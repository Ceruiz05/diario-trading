"""Lee las operaciones de NinjaTrader 8, arma los trades, los cifra y los sube al repo.

Uso:
    python sync/sincronizar.py            # actualiza data.json y hace commit + push
    python sync/sincronizar.py --sin-push # solo genera data.json
"""
import argparse
import base64
import getpass
import hashlib
import json
import os
import secrets
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

RAIZ = Path(__file__).resolve().parent.parent
LOCAL = RAIZ / "local"
CONFIG = LOCAL / "config.json"
SALIDA = RAIZ / "data.json"
NT_DB = Path(os.path.expanduser("~")) / "Documents" / "NinjaTrader 8" / "db" / "NinjaTrader.sqlite"

ITERACIONES = 310_000
TICKS_EPOCH = 621_355_968_000_000_000  # ticks .NET del 1970-01-01
CENTINELA = 1e300  # NinjaTrader usa ±double.MaxValue cuando no hay dato

# Comisión estimada por contrato y por lado (entrada o salida), en USD. Editable en local/config.json.
COMISIONES_DEFECTO = {"MNQ": 0.52, "MES": 0.52, "M2K": 0.52, "MYM": 0.52, "MGC": 0.82, "MCL": 0.82,
                      "NQ": 1.99, "ES": 1.99, "RTY": 1.99, "YM": 1.99, "GC": 2.29, "CL": 2.29, "otro": 1.99}


def ms(ticks):
    return (ticks - TICKS_EPOCH) // 10_000


def tipo_salida(nombre):
    n = (nombre or "").lower()
    if n.startswith("stop"):
        return "Stop"
    if n.startswith("target") or n.startswith("profit"):
        return "Target"
    return "Manual"


def precio_valido(x):
    return x is not None and abs(x) < CENTINELA


def cargar_config(cuentas_nt):
    LOCAL.mkdir(exist_ok=True)
    cfg = json.loads(CONFIG.read_text(encoding="utf-8")) if CONFIG.exists() else {}
    if not cfg.get("password"):
        print("\nPrimera vez: crea la contraseña para ver tu dashboard.")
        print("(Se guarda solo en este PC. La página web te la pedirá una vez por dispositivo.)\n")
        while True:
            p1 = getpass.getpass("Contraseña: ")
            p2 = getpass.getpass("Repite la contraseña: ")
            if len(p1) < 6:
                print("Usa al menos 6 caracteres.\n")
            elif p1 != p2:
                print("No coinciden, intenta de nuevo.\n")
            else:
                cfg["password"] = p1
                break
    cfg.setdefault("salt", base64.b64encode(secrets.token_bytes(16)).decode())
    cfg.setdefault("comision_por_lado", COMISIONES_DEFECTO)
    cfg.setdefault("consistencia", 0.30)
    cuentas = cfg.setdefault("cuentas", {})
    for nombre in cuentas_nt:
        if nombre in cuentas:
            continue
        es_pa = nombre.startswith("PA-")
        activa = nombre in ("PA-APEX-375246-05", "PA-APEX-375246-06")
        cuentas[nombre] = {
            "alias": ("PA " if es_pa else "Eval ") + nombre.split("-")[-1],
            "tipo": "PA" if es_pa else "Evaluación",
            "estado": "activa" if activa else "cerrada",
            "tamano": 50000,
            "drawdown": 2500,
            "retiros": [],  # [{"fecha": "2026-11-15", "monto": 1500}]
        }
    CONFIG.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")
    return cfg


def leer_nt():
    # Se trabaja sobre una copia para no bloquear ni tocar la base de NinjaTrader.
    tmp = Path(tempfile.mkdtemp()) / "nt.sqlite"
    shutil.copy2(NT_DB, tmp)
    con = sqlite3.connect(f"file:{tmp}?mode=ro", uri=True)
    ejecuciones = con.execute("""
        select e.Id, e.Time, a.Name, e.Instrument, m.Name, m.PointValue, e.Price, e.Quantity,
               e.MarketPosition, e.MaxPrice, e.MinPrice, e.Name
        from Executions e
        join Accounts a on a.Id = e.Account
        join Instruments i on i.Id = e.Instrument
        join MasterInstruments m on m.Id = i.MasterInstrument
        where a.Name like '%APEX%'
        order by e.Time, e.Id""").fetchall()
    # Primer precio de cada orden stop (tipos 3 = StopLimit, 4 = StopMarket), desde su historial.
    stops = con.execute("""
        select a.Name, o.Instrument, o.OrderAction, o.Quantity, min(u.Time),
               (select u2.StopPrice from OrderUpdates u2 where u2."Order" = o.Id and u2.StopPrice > 0
                order by u2.Time, u2.Nr limit 1)
        from Orders o
        join Accounts a on a.Id = o.Account
        join OrderUpdates u on u."Order" = o.Id
        where a.Name like '%APEX%' and o.OrderType in (3, 4)
        group by o.Id""").fetchall()
    con.close()
    shutil.rmtree(tmp.parent, ignore_errors=True)
    return ejecuciones, stops


def armar_trades(ejecuciones, stops, comisiones):
    stops_por = {}
    for cuenta, inst, accion, qty, t, precio in stops:
        if precio:
            stops_por.setdefault((cuenta, inst), []).append((ms(t), precio, qty, accion))
    for lista in stops_por.values():
        lista.sort()

    abiertos, trades = {}, []

    def nuevo(cuenta, inst, sym, pv, t, lado):
        return {"cuenta": cuenta, "inst": inst, "sym": sym, "pv": pv, "dir": lado, "t0": t,
                "pos": 0, "costo": 0.0, "maxpos": 0, "qe": 0, "ve": 0.0, "qs": 0, "vs": 0.0, "bruto": 0.0,
                "pico": 0.0, "x0": None, "fills": 0, "entradas": 0, "salida": "", "p0": None, "q0": 0,
                "lotes": [], "b0": 0.0, "ba": 0.0, "esc": []}

    def anotar(tr, t, tipo, q, px):
        # Escalera del trade. Une ejecuciones seguidas del mismo tipo (una orden partida en varios fills).
        pos = abs(tr["pos"])
        d0 = round((px - tr["p0"]) * tr["dir"], 2)
        u = tr["esc"][-1] if tr["esc"] else None
        if u and u[1] == tipo and t - u[0] <= 1000:
            u[3] = round((u[3] * u[2] + px * q) / (u[2] + q), 4)
            u[2] += q
            u[4] = pos
            u[5] = round((u[3] - tr["p0"]) * tr["dir"], 2)
        else:
            tr["esc"].append([t, tipo, q, px, pos, d0])

    def cerrar(tr, t):
        por_lado = comisiones.get(tr["sym"], comisiones.get("otro", 0))
        com = por_lado * (tr["qe"] + tr["qs"])
        pe, ps = tr["ve"] / tr["qe"], tr["vs"] / tr["qs"]
        d = tr["dir"]
        # MFE/MAE de la idea: lo que hizo el precio desde la primera entrada hasta la salida.
        mfe = mae = None
        if tr["x0"]:
            hi, lo = tr["x0"]
            mfe = max(0.0, (hi - tr["p0"]) if d > 0 else (tr["p0"] - lo))
            mae = max(0.0, (tr["p0"] - lo) if d > 0 else (hi - tr["p0"]))
        riesgo = riesgo_inicial(tr)
        trades.append({
            "c": tr["cuenta"], "s": tr["sym"], "d": d, "t0": tr["t0"], "t1": t,
            "q": tr["maxpos"], "qt": tr["qe"], "q0": tr["q0"], "p0": tr["p0"],
            "pe": round(pe, 4), "ps": round(ps, 4), "pts": round((ps - pe) * d, 4),
            "pts0": round((ps - tr["p0"]) * d, 4), "pv": tr["pv"],
            "bruto": round(tr["bruto"], 2), "com": round(com, 2), "neto": round(tr["bruto"] - com, 2),
            "b0": round(tr["b0"], 2), "ba": round(tr["ba"], 2), "c0": round(por_lado * tr["q0"] * 2, 2),
            "mfe": None if mfe is None else round(mfe, 4), "mae": None if mae is None else round(mae, 4),
            "pico": round(tr["pico"], 2),
            "riesgo": riesgo, "fills": tr["fills"], "ent": tr["entradas"], "sal": tipo_salida(tr["salida"]),
            "esc": tr["esc"],
        })

    def riesgo_inicial(tr):
        # Suma de los stops colocados al inicio del trade, del lado de la pérdida.
        lado_stop = (2, 3) if tr["dir"] > 0 else (0, 1)
        cand = [s for s in stops_por.get((tr["cuenta"], tr["inst"]), [])
                if tr["t0"] - 2000 <= s[0] <= tr["t0"] + 60_000 and s[3] in lado_stop
                and (s[1] - tr["p0"]) * tr["dir"] < 0]
        if not cand:
            return None
        primero = cand[0][0]
        grupo = [s for s in cand if s[0] - primero <= 5000]
        pts = sum(abs(tr["p0"] - s[1]) * s[2] for s in grupo) / sum(s[2] for s in grupo)
        return {"pts": round(pts, 4), "usd": round(pts * tr["pv"] * tr["q0"], 2)}

    for _, t, cuenta, inst, sym, pv, px, q, mp, hi, lo, nombre in ejecuciones:
        t = ms(t)
        lado = 1 if mp == 0 else -1  # MarketPosition 0 = compra, 1 = venta
        clave = (cuenta, inst)
        tr = abiertos.get(clave)
        while q > 0:
            if tr is None:
                tr = nuevo(cuenta, inst, sym, pv, t, lado)
                abiertos[clave] = tr
            tr["fills"] += 1
            if tr["pos"] == 0 or (tr["pos"] > 0) == (lado > 0):
                inicial = tr["p0"] is None or t - tr["t0"] <= 1000
                if tr["p0"] is None:
                    tr["p0"] = px
                    if precio_valido(hi) and precio_valido(lo):
                        tr["x0"] = (hi, lo)
                if inicial:
                    tr["q0"] += q
                    tipo = 0
                else:
                    tipo = 1 if (px - tr["costo"]) * lado > 0 else 2  # agrega ganando / perdiendo
                tr["entradas"] += 1
                tr["costo"] = (tr["costo"] * abs(tr["pos"]) + px * q) / (abs(tr["pos"]) + q)
                tr["qe"] += q
                tr["ve"] += px * q
                tr["pos"] += q * lado
                tr["maxpos"] = max(tr["maxpos"], abs(tr["pos"]))
                tr["lotes"].append([q, px, inicial])
                if precio_valido(hi) and precio_valido(lo):
                    # Cota de la ganancia abierta máxima (para estimar el trailing drawdown).
                    tr["pico"] += max(0.0, (hi - px) if lado > 0 else (px - lo)) * q * pv
                anotar(tr, t, tipo, q, px)
                q = 0
            else:
                n = min(q, abs(tr["pos"]))
                tr["bruto"] += (px - tr["costo"]) * n * pv * tr["dir"]
                # Reparto FIFO: los primeros contratos en entrar son los primeros en salir.
                resto = n
                while resto:
                    lote = tr["lotes"][0]
                    m = min(resto, lote[0])
                    r = (px - lote[1]) * m * pv * tr["dir"]
                    tr["b0" if lote[2] else "ba"] += r
                    lote[0] -= m
                    resto -= m
                    if not lote[0]:
                        tr["lotes"].pop(0)
                tr["qs"] += n
                tr["vs"] += px * n
                tr["pos"] += n * lado
                tr["salida"] = nombre or ""
                anotar(tr, t, 3, n, px)
                q -= n
                if tr["pos"] == 0:
                    cerrar(tr, t)
                    tr = None
                    abiertos.pop(clave, None)
    return trades, [a for a in abiertos.values() if a["pos"] != 0]


def cifrar(datos, cfg):
    salt = base64.b64decode(cfg["salt"])
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITERACIONES)
    clave = kdf.derive(cfg["password"].encode("utf-8"))
    iv = secrets.token_bytes(12)
    ct = AESGCM(clave).encrypt(iv, datos, None)
    return {"v": 1, "iter": ITERACIONES, "salt": cfg["salt"],
            "iv": base64.b64encode(iv).decode(), "ct": base64.b64encode(ct).decode()}


def git(*args):
    return subprocess.run(["git", *args], cwd=RAIZ, capture_output=True, text=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sin-push", action="store_true")
    args = ap.parse_args()

    if not NT_DB.exists():
        sys.exit(f"No encontré la base de NinjaTrader en {NT_DB}")
    ejecuciones, stops = leer_nt()
    cfg = cargar_config(sorted({e[2] for e in ejecuciones}))
    trades, abiertos = armar_trades(ejecuciones, stops, cfg["comision_por_lado"])

    cuentas = [{"id": k, **{c: v[c] for c in ("alias", "tipo", "estado", "tamano", "drawdown", "retiros")}}
               for k, v in cfg["cuentas"].items()]
    contenido = {"cuentas": cuentas, "trades": trades, "consistencia": cfg["consistencia"],
                 "abiertos": [{"c": a["cuenta"], "s": a["sym"], "pos": a["pos"]} for a in abiertos]}
    plano = json.dumps(contenido, separators=(",", ":"), ensure_ascii=False)
    huella = hashlib.sha256(plano.encode()).hexdigest()

    huella_previa = LOCAL / "ultima_huella.txt"
    if SALIDA.exists() and huella_previa.exists() and huella_previa.read_text() == huella:
        print(f"Sin operaciones nuevas ({len(trades)} trades). Nada que subir.")
        return

    contenido["generado"] = int(time.time() * 1000)
    paquete = cifrar(json.dumps(contenido, separators=(",", ":"), ensure_ascii=False).encode("utf-8"), cfg)
    paquete["generado"] = contenido["generado"]
    SALIDA.write_text(json.dumps(paquete), encoding="utf-8")
    print(f"Listo: {len(trades)} trades en {len(cuentas)} cuentas.")
    if abiertos:
        print(f"Aviso: {len(abiertos)} posición(es) abierta(s), se incluirán cuando se cierren.")

    if args.sin_push:
        huella_previa.write_text(huella)
        return
    git("add", "data.json")
    r = git("commit", "-m", "Datos " + time.strftime("%Y-%m-%d %H:%M"))
    if r.returncode != 0 and "nothing to commit" not in r.stdout:
        sys.exit("Error en git commit:\n" + r.stdout + r.stderr)
    r = git("push")
    if r.returncode != 0:
        sys.exit("No pude subir a GitHub:\n" + r.stderr)
    huella_previa.write_text(huella)
    print("Subido a GitHub. La página se actualiza en 1-2 minutos.")


if __name__ == "__main__":
    main()

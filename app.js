'use strict';

/* ---------- Utilidades ---------- */
const $ = (s) => document.querySelector(s);
const ZONA = 'America/Bogota';
const MIN = 60_000;
const SERIES = ['--s1', '--s2', '--s3', '--s4'];

const fmtNum = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtEnt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const fmtFechaET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const fmtHora = new Intl.DateTimeFormat('es-CO', { timeZone: ZONA, hour: '2-digit', minute: '2-digit', hour12: false });
const fmtHoraNum = new Intl.DateTimeFormat('en-US', { timeZone: ZONA, hour: 'numeric', hour12: false });
const fmtFechaCorta = new Intl.DateTimeFormat('es-CO', { timeZone: ZONA, day: 'numeric', month: 'short' });
const fmtFechaLarga = new Intl.DateTimeFormat('es-CO', { timeZone: ZONA, weekday: 'long', day: 'numeric', month: 'long' });

const usd = (v, signo = true) => {
  const s = '$' + fmtNum.format(Math.abs(v));
  if (!signo) return (v < 0 ? '−' : '') + s;
  return (v > 0 ? '+' : v < 0 ? '−' : '') + s;
};
const usd0 = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + '$' + fmtEnt.format(Math.abs(v));
const pts = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + fmtNum.format(Math.abs(v));
const pct = (v) => (v == null || !isFinite(v) ? '—' : Math.round(v * 100) + '%');
const clase = (v) => (v > 0 ? 'gana' : v < 0 ? 'pierde' : '');
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const suma = (a, f) => a.reduce((s, x) => s + f(x), 0);
const mediana = (a) => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };

// Día de trading CME: la sesión empieza a las 18:00 hora de Nueva York.
const diaTrading = (ms) => fmtFechaET.format(new Date(ms + 6 * 3600_000));
const fechaDeDia = (d) => new Date(d + 'T12:00:00Z');
const duracion = (ms) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + String(s % 60).padStart(2, '0') + 's';
  return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm';
};

/* ---------- Cifrado ---------- */
const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64e = (u) => btoa(String.fromCharCode(...u));
const CLAVE_LS = 'dt.clave';

async function derivar(pass, salt, iter) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: b64d(salt), iterations: iter }, base, 256);
  return new Uint8Array(bits);
}
async function descifrar(raw, pkg) {
  const k = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(pkg.iv) }, k, b64d(pkg.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}
function leerLS(k) { try { return localStorage.getItem(k); } catch { return null; } }
function guardarLS(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } }

/* ---------- Estado ---------- */
const S = { pkg: null, raw: null, d: null, cuentas: 'activas', periodo: 'todo', dia: null, mes: null, abierto: null };

async function cargarPaquete() {
  const r = await fetch('data.json?t=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) throw new Error('sin-datos');
  return r.json();
}

async function iniciar() {
  aplicarTema(leerLS('dt.tema'));
  try {
    S.pkg = await cargarPaquete();
  } catch {
    mostrarCandado('Aún no hay datos publicados. Ejecuta Actualizar.bat en tu PC.');
    return;
  }
  const guardada = leerLS(CLAVE_LS);
  if (guardada) {
    try {
      const g = JSON.parse(guardada);
      if (g.salt === S.pkg.salt) {
        S.raw = b64d(g.k);
        S.d = await descifrar(S.raw, S.pkg);
        return entrar();
      }
    } catch { /* clave vieja o inválida */ }
    guardarLS(CLAVE_LS, null);
  }
  mostrarCandado();
}

function mostrarCandado(msg) {
  $('#app').hidden = true;
  $('#candado').hidden = false;
  const e = $('#error-clave');
  e.hidden = !msg;
  e.textContent = msg || '';
  $('#clave').focus();
}

$('#form-clave').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const btn = ev.submitter || $('#form-clave button');
  btn.disabled = true;
  btn.textContent = 'Abriendo…';
  try {
    if (!S.pkg) S.pkg = await cargarPaquete();
    S.raw = await derivar($('#clave').value, S.pkg.salt, S.pkg.iter);
    S.d = await descifrar(S.raw, S.pkg);
    if ($('#recordar').checked) guardarLS(CLAVE_LS, JSON.stringify({ salt: S.pkg.salt, k: b64e(S.raw) }));
    $('#clave').value = '';
    entrar();
  } catch (e) {
    mostrarCandado(e.message === 'sin-datos' ? 'Aún no hay datos publicados.' : 'Contraseña incorrecta.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Entrar';
  }
});

$('#btn-salir').addEventListener('click', () => {
  guardarLS(CLAVE_LS, null);
  S.raw = S.d = null;
  mostrarCandado();
});

function aplicarTema(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  const oscuro = t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  $('#btn-tema').textContent = oscuro ? '☀' : '☾';
}
$('#btn-tema').addEventListener('click', () => {
  const actual = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const nuevo = actual === 'dark' ? 'light' : 'dark';
  guardarLS('dt.tema', nuevo);
  aplicarTema(nuevo);
  if (S.d) render();
});

// Revisa cada 2 minutos si hay datos nuevos.
setInterval(async () => {
  if (!S.raw || document.hidden) return;
  try {
    const p = await cargarPaquete();
    if (p.generado !== S.pkg.generado && p.salt === S.pkg.salt) {
      S.d = await descifrar(S.raw, p);
      S.pkg = p;
      preparar();
      render();
    }
  } catch { /* se reintenta luego */ }
}, 120_000);

/* ---------- Preparación de datos ---------- */
function preparar() {
  const d = S.d;
  d.porId = {};
  d.cuentas.forEach((c) => { d.porId[c.id] = c; });
  d.activas = d.cuentas.filter((c) => c.estado === 'activa');
  d.activas.forEach((c, i) => { c.color = SERIES[i % SERIES.length]; });
  d.trades.sort((a, b) => a.t0 - b.t0);
  const porCuenta = {};
  d.trades.forEach((t, i) => {
    t.id = i;
    t.dia = diaTrading(t.t0);
    t.r = t.riesgo && t.riesgo.usd > 0 ? t.neto / t.riesgo.usd : null;
    t.captura = t.mfe > 0 ? t.pts / t.mfe : null;
    (porCuenta[t.c] = porCuenta[t.c] || []).push(t);
  });
  // Señales de comportamiento, calculadas dentro de cada cuenta.
  Object.values(porCuenta).forEach((lista) => {
    const medQ = mediana(lista.map((t) => t.q)) || 1;
    const porDia = {};
    lista.forEach((t, i) => {
      const prev = lista[i - 1];
      t.senales = [];
      t.nDia = (porDia[t.dia] = (porDia[t.dia] || 0) + 1);
      t.trasPerdida = !!(prev && prev.neto < 0 && t.t0 - prev.t1 < 10 * MIN && prev.dia === t.dia);
      if (t.trasPerdida) t.senales.push(['Tras pérdida', 'Entró ' + duracion(t.t0 - prev.t1) + ' después de cerrar una pérdida']);
      if (!t.riesgo) t.senales.push(['Sin stop', 'No se registró stop al entrar']);
      if (t.q >= medQ * 2 && t.q > 1) t.senales.push(['Tamaño ×' + (t.q / medQ).toFixed(1).replace('.0', ''), 'Usó ' + t.q + ' contratos; lo normal en esta cuenta es ' + medQ]);
      if (t.r != null && t.r < -1.15) t.senales.push(['Pérdida > 1R', 'Perdió ' + Math.abs(t.r).toFixed(1) + ' veces el riesgo inicial']);
    });
  });
  const hoy = diaTrading(Date.now());
  const ultimo = d.trades.length ? d.trades[d.trades.length - 1].dia : hoy;
  if (!S.mes) S.mes = (S.periodo === 'todo' ? ultimo : hoy).slice(0, 7);
}

function cuentasSeleccionadas() {
  const d = S.d;
  if (S.cuentas === 'activas') return d.activas.map((c) => c.id);
  if (S.cuentas === 'historial') return d.cuentas.map((c) => c.id);
  return [S.cuentas];
}

function rangoPeriodo() {
  const hoy = diaTrading(Date.now());
  if (S.periodo === 'hoy') return [hoy, hoy];
  if (S.periodo === 'semana') {
    const f = fechaDeDia(hoy);
    const dow = (f.getUTCDay() + 6) % 7;
    const ini = new Date(f.getTime() - dow * 86400_000).toISOString().slice(0, 10);
    return [ini, hoy];
  }
  if (S.periodo === 'mes') return [hoy.slice(0, 8) + '01', hoy];
  return ['0000', '9999'];
}

function tradesFiltrados() {
  const ids = new Set(cuentasSeleccionadas());
  let [a, b] = rangoPeriodo();
  if (S.dia) a = b = S.dia;
  return S.d.trades.filter((t) => ids.has(t.c) && t.dia >= a && t.dia <= b);
}

/* ---------- Métricas ---------- */
function metricas(ts) {
  const g = ts.filter((t) => t.neto > 0), p = ts.filter((t) => t.neto < 0);
  const sg = suma(g, (t) => t.neto), sp = suma(p, (t) => t.neto);
  const dias = {};
  ts.forEach((t) => { dias[t.dia] = (dias[t.dia] || 0) + t.neto; });
  const vd = Object.entries(dias);
  const conR = ts.filter((t) => t.r != null);
  return {
    n: ts.length, neto: sg + sp, bruto: suma(ts, (t) => t.bruto), com: suma(ts, (t) => t.com),
    wr: ts.length ? g.length / ts.length : null,
    pf: sp ? sg / -sp : (sg > 0 ? Infinity : null),
    exp: ts.length ? (sg + sp) / ts.length : null,
    avgG: g.length ? sg / g.length : null, avgP: p.length ? sp / p.length : null,
    rProm: conR.length ? suma(conR, (t) => t.r) / conR.length : null,
    dias: vd.length, diasVerdes: vd.filter(([, v]) => v > 0).length,
    mejorDia: vd.length ? vd.reduce((m, x) => (x[1] > m[1] ? x : m)) : null,
    peorDia: vd.length ? vd.reduce((m, x) => (x[1] < m[1] ? x : m)) : null,
  };
}

function estadoCuenta(c) {
  const ts = S.d.trades.filter((t) => t.c === c.id);
  const retiros = (c.retiros || []).map((r) => ({ dia: r.fecha, monto: Number(r.monto) || 0 }));
  let bal = c.tamano, pico = c.tamano;
  const tope = c.tamano + 100; // Apex deja de mover el umbral cuando llega a tamaño + $100
  const ri = [...retiros].sort((a, b) => (a.dia < b.dia ? -1 : 1));
  let k = 0;
  ts.forEach((t) => {
    while (k < ri.length && ri[k].dia <= t.dia) bal -= ri[k++].monto;
    if (t.mfe != null) pico = Math.max(pico, bal + t.mfe * t.pv * t.q - t.com);
    bal += t.neto;
    pico = Math.max(pico, bal);
  });
  while (k < ri.length) bal -= ri[k++].monto;
  const umbral = Math.min(pico - c.drawdown, tope);
  // Consistencia: se mide desde el último retiro.
  const desde = ri.length ? ri[ri.length - 1].dia : '0000';
  const dias = {};
  ts.filter((t) => t.dia > desde).forEach((t) => { dias[t.dia] = (dias[t.dia] || 0) + t.neto; });
  const total = Object.values(dias).reduce((a, b) => a + b, 0);
  const mejor = Math.max(0, ...Object.values(dias));
  const hoy = diaTrading(Date.now());
  return {
    saldo: bal, umbral, colchon: bal - umbral, congelado: umbral >= tope,
    total, mejor, ratio: total > 0 ? mejor / total : null,
    hoy: dias[hoy] || 0, nHoy: ts.filter((t) => t.dia === hoy).length,
    nDias: Object.keys(dias).length, ganancia: bal - c.tamano + suma(retiros, (r) => r.monto),
  };
}

/* ---------- Render ---------- */
function entrar() {
  $('#candado').hidden = true;
  $('#app').hidden = false;
  preparar();
  render();
}

function render() {
  const d = S.d;
  const gen = new Date(S.pkg.generado);
  $('#actualizado').textContent = 'Actualizado ' + fmtFechaCorta.format(gen) + ', ' + fmtHora.format(gen) +
    ((d.abiertos || []).some((a) => d.porId[a.c] && d.porId[a.c].estado === 'activa') ? ' · hay una posición abierta (se incluye al cerrarla)' : '');
  renderFiltros();
  const ts = tradesFiltrados();
  renderKpis(ts);
  renderCuentas();
  renderEquity(ts);
  renderCalendario();
  renderDisciplina(ts);
  const horas = agrupar(ts, (t) => Number(fmtHoraNum.format(new Date(t.t0))) % 24, (h) => h + 'h');
  // Se muestran todas las horas del rango, aunque alguna no tenga trades.
  if (horas.length) for (let h = horas[0].k + 1; h < horas[horas.length - 1].k; h++) if (!horas.some((x) => x.k === h)) horas.push({ k: h, neto: 0, n: 0, gan: 0, label: h + 'h' });
  renderBarras($('#por-hora'), horas.sort((a, b) => a.k - b.k));
  const nombresDia = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  renderBarras($('#por-dia'), agrupar(ts, (t) => (fechaDeDia(t.dia).getUTCDay() + 6) % 7, (i) => nombresDia[(i + 1) % 7]));
  renderLado(ts);
  renderDuracion(ts);
  renderTrades(ts);
}

function boton(txt, activo, fn) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = txt;
  b.setAttribute('aria-pressed', activo);
  b.addEventListener('click', fn);
  return b;
}

function renderFiltros() {
  const fc = $('#f-cuentas'), fp = $('#f-periodo');
  fp.replaceChildren();
  const set = (k, v) => () => { S[k] = v; S.dia = null; S.abierto = null; render(); };
  const op = (v, t) => `<option value="${esc(v)}"${S.cuentas === v ? ' selected' : ''}>${esc(t)}</option>`;
  const cerradas = S.d.cuentas.filter((c) => c.estado !== 'activa');
  fc.innerHTML =
    `<optgroup label="Cuentas activas">${op('activas', 'Todas las activas')}${S.d.activas.map((c) => op(c.id, c.alias + ' · ' + c.id)).join('')}</optgroup>` +
    `<optgroup label="Historial">${op('historial', 'Todas las cuentas')}${cerradas.map((c) => op(c.id, c.alias + ' · ' + c.id)).join('')}</optgroup>`;
  [['hoy', 'Hoy'], ['semana', 'Semana'], ['mes', 'Mes'], ['todo', 'Todo']].forEach(([k, t]) =>
    fp.append(boton(t, S.periodo === k && !S.dia, set('periodo', k))));
  const chip = $('#filtro-dia');
  chip.hidden = !S.dia;
  if (S.dia) {
    chip.innerHTML = 'Día: <b>' + fmtFechaLarga.format(fechaDeDia(S.dia)) + '</b> <button aria-label="Quitar filtro">×</button>';
    chip.querySelector('button').onclick = () => { S.dia = null; render(); };
  }
}

function kpi(et, val, sub, cls = '') {
  return `<div class="kpi"><div class="et">${et}</div><div class="val ${cls}">${val}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
}

function renderKpis(ts) {
  const m = metricas(ts);
  if (!m.n) {
    $('#kpis').innerHTML = `<div class="kpi" style="grid-column:1/-1"><div class="vacio-msg">Sin trades en este periodo.</div></div>`;
    return;
  }
  const ratio = m.avgG && m.avgP ? (m.avgG / -m.avgP).toFixed(2) : '—';
  $('#kpis').innerHTML = [
    kpi('P&L neto', usd(m.neto), 'Bruto ' + usd(m.bruto) + ' · com. ' + usd(-m.com, false), clase(m.neto)),
    kpi('Trades', m.n, m.dias + ' día' + (m.dias === 1 ? '' : 's') + ' · ' + m.diasVerdes + ' verde' + (m.diasVerdes === 1 ? '' : 's')),
    kpi('% acierto', pct(m.wr), ts.filter((t) => t.neto > 0).length + ' ganadores'),
    kpi('Profit factor', m.pf == null ? '—' : m.pf === Infinity ? '∞' : m.pf.toFixed(2), 'ganancias ÷ pérdidas'),
    kpi('Expectativa', usd(m.exp), 'promedio por trade', clase(m.exp)),
    kpi('Ganador / perdedor', (m.avgG ? usd0(m.avgG) : '—') + ' / ' + (m.avgP ? usd0(m.avgP) : '—'), 'relación ' + ratio),
    kpi('R promedio', m.rProm == null ? '—' : (m.rProm > 0 ? '+' : '') + m.rProm.toFixed(2) + 'R', 'resultado ÷ riesgo inicial', clase(m.rProm)),
    kpi('Mejor / peor día', (m.mejorDia ? usd0(m.mejorDia[1]) : '—') + ' / ' + (m.peorDia ? usd0(m.peorDia[1]) : '—'), ''),
  ].join('');
}

function renderCuentas() {
  const cont = $('#cuentas');
  const ids = new Set(cuentasSeleccionadas());
  const lista = S.cuentas === 'historial' ? S.d.activas : S.d.cuentas.filter((c) => ids.has(c.id));
  const unaCerrada = lista.length === 1 && lista[0].estado !== 'activa';
  $('#titulo-cuentas').textContent = unaCerrada ? 'Cuenta (cerrada)' : lista.length === 1 ? 'Cuenta' : 'Cuentas Apex activas';
  if (!lista.length) { cont.innerHTML = '<p class="muted">No hay cuentas marcadas como activas.</p>'; return; }
  const lim = S.d.consistencia;
  cont.innerHTML = lista.map((c) => {
    const e = estadoCuenta(c);
    const uso = Math.max(0, Math.min(1, e.colchon / c.drawdown));
    const colorBarra = uso > 0.5 ? 'var(--gana-mark)' : uso > 0.25 ? 'var(--aviso)' : 'var(--pierde-mark)';
    const estadoColchon = uso > 0.5 ? '' : uso > 0.25 ? '<span class="estado aviso">⚠ Colchón bajo</span>' : '<span class="estado pierde">⚠ Cerca del límite</span>';
    let cons;
    if (e.ratio == null) cons = '<span class="muted">sin ganancia acumulada</span>';
    else if (e.ratio <= lim) cons = `<span class="gana">✓ ${pct(e.ratio)}</span>`;
    else cons = `<span class="aviso">⚠ ${pct(e.ratio)}</span>`;
    return `<div class="cuenta">
      <div class="cuenta-head"><span class="nombre"><i class="punto" style="background:${c.color ? `var(${c.color})` : 'var(--muted)'}"></i>${esc(c.alias)}</span>
        <span class="muted small">${esc(c.tipo)} ${fmtEnt.format(c.tamano / 1000)}K</span></div>
      <div class="saldo">$${fmtNum.format(e.saldo)}</div>
      <div class="small ${clase(e.ganancia)}">${usd(e.ganancia)} desde el inicio</div>
      <div class="filas">
        <div><span>Hoy</span><span class="${clase(e.hoy)}">${usd(e.hoy)} · ${e.nHoy} trade${e.nHoy === 1 ? '' : 's'}</span></div>
        <div><span>Umbral de liquidación${e.congelado ? ' (fijo)' : ''}</span><span>$${fmtNum.format(e.umbral)}</span></div>
        <div><span>Colchón disponible</span><span>${usd(e.colchon, false)} ${estadoColchon}</span></div>
        <div class="barra" title="Colchón respecto al drawdown de ${usd0(c.drawdown)}"><i style="width:${uso * 100}%;background:${colorBarra}"></i></div>
        ${c.tipo === 'PA' ? `<div><span>Consistencia (mejor día ÷ total, máx ${pct(lim)})</span><span>${cons}</span></div>
        <div><span>Mejor día · total</span><span>${usd0(e.mejor)} · ${usd0(e.total)}</span></div>` : ''}
        <div><span>Días operados</span><span>${e.nDias}</span></div>
      </div>
    </div>`;
  }).join('');
}

/* ---------- Gráficos SVG ---------- */
const tip = $('#tooltip');
function mostrarTip(html, x, y) {
  tip.innerHTML = html;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let left = x + 14, top = y + 14;
  if (left + r.width > innerWidth - 8) left = x - r.width - 14;
  if (top + r.height > innerHeight - 8) top = y - r.height - 14;
  tip.style.left = Math.max(8, left) + 'px';
  tip.style.top = Math.max(8, top) + 'px';
}
const ocultarTip = () => { tip.hidden = true; };
const svgNS = 'http://www.w3.org/2000/svg';
function el(tag, attrs, parent) {
  const e = document.createElementNS(svgNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
function escalaBonita(min, max, n = 4) {
  if (min === max) { min -= 1; max += 1; }
  const paso0 = (max - min) / n;
  const mag = Math.pow(10, Math.floor(Math.log10(paso0)));
  const paso = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((p) => p >= paso0);
  const ini = Math.floor(min / paso) * paso, fin = Math.ceil(max / paso) * paso;
  const marcas = [];
  for (let v = ini; v <= fin + paso / 2; v += paso) marcas.push(Math.round(v * 100) / 100);
  return { ini, fin, marcas };
}

function renderEquity(ts) {
  const cont = $('#equity');
  cont.replaceChildren();
  const ley = $('#leyenda-equity');
  if (!ts.length) { cont.innerHTML = '<div class="vacio-msg">Sin trades en este periodo.</div>'; ley.replaceChildren(); return; }
  // En historial se dibuja una sola curva combinada; si no, una por cuenta.
  const separadas = S.cuentas !== 'historial';
  const grupos = {};
  ts.forEach((t) => { const k = separadas ? t.c : 'Todas'; (grupos[k] = grupos[k] || []).push(t); });
  const series = Object.entries(grupos).map(([k, lista]) => {
    let acc = 0;
    const c = S.d.porId[k];
    const pts = [{ x: lista[0].t0, y: 0, t: null }].concat(lista.map((t) => ({ x: t.t1, y: (acc += t.neto), t })));
    return { nombre: c ? c.alias : 'Todas las cuentas', color: c && c.color ? css(c.color) : css('--s1'), pts };
  });
  ley.innerHTML = series.length > 1 ? series.map((s) => `<span><i class="punto" style="background:${s.color}"></i>${esc(s.nombre)}</span>`).join('') : '';

  const W = Math.max(280, cont.clientWidth), H = 240, m = { l: 56, r: 12, t: 10, b: 24 };
  const todos = series.flatMap((s) => s.pts);
  // Eje x por orden de trade (no por tiempo) para que los fines de semana y noches no aplasten la curva.
  const orden = [...new Set(todos.map((p) => p.x))].sort((a, b) => a - b);
  const idx = new Map(orden.map((x, i) => [x, i]));
  const xmax = Math.max(1, orden.length - 1);
  const ys = todos.map((p) => p.y);
  const esc_ = escalaBonita(Math.min(0, ...ys), Math.max(0, ...ys));
  const X = (x) => m.l + (idx.get(x) / xmax) * (W - m.l - m.r);
  const Y = (y) => m.t + (1 - (y - esc_.ini) / (esc_.fin - esc_.ini)) * (H - m.t - m.b);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Curva de equity' }, cont);
  esc_.marcas.forEach((v) => {
    el('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), stroke: v === 0 ? css('--muted') : css('--grid'), 'stroke-width': 1 }, svg);
    el('text', { x: m.l - 8, y: Y(v) + 4, 'text-anchor': 'end' }, svg).textContent = usd0(v).replace('+', '');
  });
  // Fechas en el eje x: primera, media y última.
  [0, Math.floor(xmax / 2), xmax].filter((v, i, a) => a.indexOf(v) === i).forEach((i, k, a) => {
    const x = m.l + (i / xmax) * (W - m.l - m.r);
    el('text', { x, y: H - 6, 'text-anchor': k === 0 ? 'start' : k === a.length - 1 ? 'end' : 'middle' }, svg).textContent = fmtFechaCorta.format(new Date(orden[i]));
  });
  series.forEach((s) => {
    el('path', { d: s.pts.map((p, i) => (i ? 'L' : 'M') + X(p.x).toFixed(1) + ',' + Y(p.y).toFixed(1)).join(''), fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
    const u = s.pts[s.pts.length - 1];
    el('circle', { cx: X(u.x), cy: Y(u.y), r: 4, fill: s.color, stroke: css('--bg'), 'stroke-width': 2 }, svg);
  });
  const guia = el('line', { y1: m.t, y2: H - m.b, stroke: css('--muted'), 'stroke-dasharray': '3 3', visibility: 'hidden' }, svg);
  const marca = el('circle', { r: 5, stroke: css('--bg'), 'stroke-width': 2, visibility: 'hidden' }, svg);
  const zona = el('rect', { x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: 'transparent' }, svg);
  zona.addEventListener('pointermove', (ev) => {
    const b = svg.getBoundingClientRect();
    const px = (ev.clientX - b.left) * (W / b.width), py = (ev.clientY - b.top) * (H / b.height);
    let mejor = null, dmin = Infinity;
    series.forEach((s) => s.pts.forEach((p) => {
      if (!p.t) return;
      const dd = Math.abs(X(p.x) - px) * 3 + Math.abs(Y(p.y) - py);
      if (dd < dmin) { dmin = dd; mejor = { s, p }; }
    }));
    if (!mejor) return;
    const { s, p } = mejor;
    guia.setAttribute('x1', X(p.x)); guia.setAttribute('x2', X(p.x)); guia.setAttribute('visibility', 'visible');
    marca.setAttribute('cx', X(p.x)); marca.setAttribute('cy', Y(p.y)); marca.setAttribute('fill', s.color); marca.setAttribute('visibility', 'visible');
    const t = p.t;
    mostrarTip(`<b>${esc(s.nombre)}</b> · ${fmtFechaCorta.format(new Date(t.t1))} ${fmtHora.format(new Date(t.t1))}<br>
      Acumulado <b>${usd(p.y)}</b><br>Trade ${t.d > 0 ? 'long' : 'short'} ${t.q} ${t.s}: <span class="${clase(t.neto)}">${usd(t.neto)}</span>`, ev.clientX, ev.clientY);
  });
  zona.addEventListener('pointerleave', () => { ocultarTip(); guia.setAttribute('visibility', 'hidden'); marca.setAttribute('visibility', 'hidden'); });
}

function agrupar(ts, clave, etiqueta) {
  const g = new Map();
  ts.forEach((t) => {
    const k = clave(t);
    const v = g.get(k) || { k, neto: 0, n: 0, gan: 0 };
    v.neto += t.neto; v.n++; if (t.neto > 0) v.gan++;
    g.set(k, v);
  });
  return [...g.values()].sort((a, b) => a.k - b.k).map((v) => ({ ...v, label: etiqueta(v.k) }));
}

function barraPath(x, w, y0, y1, r) {
  // Barra con esquinas redondeadas solo en el extremo del dato.
  const h = Math.abs(y1 - y0);
  r = Math.min(r, h, w / 2);
  if (y1 < y0) return `M${x},${y0}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + r}V${y0}Z`;
  return `M${x},${y0}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 - r}V${y0}Z`;
}

function renderBarras(cont, items) {
  cont.replaceChildren();
  if (!items.length) { cont.innerHTML = '<div class="vacio-msg">Sin datos.</div>'; return; }
  const W = Math.max(260, cont.clientWidth), H = 190, m = { l: 48, r: 4, t: 16, b: 22 };
  const vs = items.map((i) => i.neto);
  const e = escalaBonita(Math.min(0, ...vs), Math.max(0, ...vs), 3);
  const Y = (y) => m.t + (1 - (y - e.ini) / (e.fin - e.ini)) * (H - m.t - m.b);
  const ancho = (W - m.l - m.r) / items.length;
  const bw = Math.min(36, ancho * 0.6);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' }, cont);
  e.marcas.forEach((v) => {
    el('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), stroke: v === 0 ? css('--muted') : css('--grid') }, svg);
    el('text', { x: m.l - 8, y: Y(v) + 4, 'text-anchor': 'end' }, svg).textContent = usd0(v).replace('+', '');
  });
  items.forEach((it, i) => {
    const cx = m.l + ancho * i + ancho / 2;
    if (it.neto !== 0) el('path', { d: barraPath(cx - bw / 2, bw, Y(0), Y(it.neto), 4), fill: css(it.neto > 0 ? '--gana-mark' : '--pierde-mark') }, svg);
    el('text', { x: cx, y: H - 6, 'text-anchor': 'middle' }, svg).textContent = it.label;
    const hit = el('rect', { x: m.l + ancho * i, y: m.t, width: ancho, height: H - m.t - m.b, fill: 'transparent' }, svg);
    if (!it.n) return;
    hit.addEventListener('pointermove', (ev) => mostrarTip(`<b>${esc(it.label)}</b><br>Neto <span class="${clase(it.neto)}">${usd(it.neto)}</span><br>${it.n} trade${it.n === 1 ? '' : 's'} · ${pct(it.gan / it.n)} acierto<br>Promedio ${usd(it.neto / it.n)}`, ev.clientX, ev.clientY));
    hit.addEventListener('pointerleave', ocultarTip);
  });
}

/* ---------- Calendario ---------- */
function renderCalendario() {
  const ids = new Set(cuentasSeleccionadas());
  const porDia = {};
  S.d.trades.filter((t) => ids.has(t.c)).forEach((t) => {
    const v = porDia[t.dia] || (porDia[t.dia] = { neto: 0, n: 0 });
    v.neto += t.neto; v.n++;
  });
  const [y, mo] = S.mes.split('-').map(Number);
  const primero = new Date(Date.UTC(y, mo - 1, 1));
  const diasMes = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  $('#mes-titulo').textContent = new Intl.DateTimeFormat('es-CO', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(primero);
  const cal = $('#calendario');
  let html = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom', 'Semana'].map((d) => `<div class="cal-cab">${d}</div>`).join('');
  const offset = (primero.getUTCDay() + 6) % 7;
  let celdas = [];
  for (let i = 0; i < offset; i++) celdas.push(null);
  for (let d = 1; d <= diasMes; d++) celdas.push(`${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  while (celdas.length % 7) celdas.push(null);
  for (let s = 0; s < celdas.length; s += 7) {
    let semNeto = 0, semN = 0;
    celdas.slice(s, s + 7).forEach((dia) => {
      if (!dia) { html += '<div class="dia vacio"></div>'; return; }
      const v = porDia[dia];
      const num = Number(dia.slice(8));
      if (!v) { html += `<div class="dia"><span class="num">${num}</span></div>`; return; }
      semNeto += v.neto; semN += v.n;
      html += `<div class="dia con ${v.neto > 0 ? 'g' : v.neto < 0 ? 'p' : ''} ${S.dia === dia ? 'sel' : ''}" data-dia="${dia}" role="button" tabindex="0">
        <span class="num">${num}</span><span class="pnl ${clase(v.neto)}">${usd0(v.neto)}</span><span class="nt">${v.n} trade${v.n === 1 ? '' : 's'}</span></div>`;
    });
    html += `<div class="dia semana">${semN ? `<span class="num">sem.</span><span class="pnl ${clase(semNeto)}">${usd0(semNeto)}</span><span class="nt">${semN} trades</span>` : ''}</div>`;
  }
  cal.innerHTML = html;
  cal.querySelectorAll('.dia.con').forEach((c) => {
    const ir = () => {
      S.dia = S.dia === c.dataset.dia ? null : c.dataset.dia;
      S.abierto = null;
      render();
      if (S.dia) $('#sec-trades').scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    c.addEventListener('click', ir);
    c.addEventListener('keydown', (e) => { if (e.key === 'Enter') ir(); });
  });
}
function moverMes(delta) {
  const [y, m] = S.mes.split('-').map(Number);
  const f = new Date(Date.UTC(y, m - 1 + delta, 1));
  S.mes = f.toISOString().slice(0, 7);
  renderCalendario();
}
$('#f-cuentas').addEventListener('change', (e) => {
  S.cuentas = e.target.value;
  S.dia = null;
  S.abierto = null;
  // El calendario salta al último mes con operaciones de la selección.
  const ids = new Set(cuentasSeleccionadas());
  const ult = S.d.trades.filter((t) => ids.has(t.c)).pop();
  if (ult) S.mes = ult.dia.slice(0, 7);
  render();
});
$('#mes-ant').addEventListener('click', () => moverMes(-1));
$('#mes-sig').addEventListener('click', () => moverMes(1));

/* ---------- Disciplina ---------- */
function disc(et, val, sub, cls = '') {
  return `<div class="disc"><div class="et">${et}</div><div class="val ${cls}">${val}</div><div class="sub">${sub}</div></div>`;
}
function renderDisciplina(ts) {
  const cont = $('#disciplina');
  if (!ts.length) { cont.innerHTML = '<div class="disc"><div class="vacio-msg">Sin trades en este periodo.</div></div>'; return; }
  const m = metricas(ts);
  const ganadores = ts.filter((t) => t.neto > 0 && t.captura != null);
  const cap = mediana(ganadores.map((t) => t.captura));
  const dejado = suma(ganadores, (t) => Math.max(0, t.mfe - t.pts) * t.pv * t.q);
  const sinStop = ts.filter((t) => !t.riesgo);
  const tras = ts.filter((t) => t.trasPerdida);
  const mt = metricas(tras);
  const primeros = ts.filter((t) => t.nDia <= 3), resto = ts.filter((t) => t.nDia > 3);
  const grandes = ts.filter((t) => t.senales.some((s) => s[0].startsWith('Tamaño')));
  const perdR = ts.filter((t) => t.neto < 0 && t.r != null);
  const rPerd = perdR.length ? suma(perdR, (t) => t.r) / perdR.length : null;
  const masDe1R = perdR.filter((t) => t.r < -1.15).length;

  cont.innerHTML = [
    disc('Captura de los ganadores', pct(cap),
      ganadores.length ? `De lo que el precio llegó a darte, te quedaste con la mitad o menos en ${ganadores.filter((t) => t.captura <= 0.5).length} de ${ganadores.length} ganadores. Quedó en la mesa ≈ ${usd0(dejado).replace('+', '')}.` : 'Sin ganadores en el periodo.'),
    disc('Trades sin stop inicial', sinStop.length + ' de ' + ts.length,
      sinStop.length ? 'Resultado de esos trades: <span class="' + clase(suma(sinStop, (t) => t.neto)) + '">' + usd(suma(sinStop, (t) => t.neto)) + '</span>' : 'Todos entraron con stop.', sinStop.length ? 'aviso' : 'gana'),
    disc('Después de una pérdida (&lt;10 min)', tras.length ? pct(mt.wr) + ' acierto' : '—',
      tras.length ? `${tras.length} trades · neto <span class="${clase(mt.neto)}">${usd(mt.neto)}</span> (tu acierto general es ${pct(m.wr)})` : 'No hubo entradas rápidas después de perder.'),
    disc('Trades 1–3 del día vs 4 en adelante', usd0(suma(primeros, (t) => t.neto)) + ' / ' + (resto.length ? usd0(suma(resto, (t) => t.neto)) : '—'),
      resto.length ? `${resto.length} trades después del tercero del día, con ${pct(metricas(resto).wr)} de acierto.` : 'Nunca pasaste de 3 trades en un día.'),
    disc('Pérdida promedio en R', rPerd == null ? '—' : rPerd.toFixed(2) + 'R',
      perdR.length ? `${masDe1R} de ${perdR.length} perdedores con stop superaron 1R (stop movido o deslizamiento).` : 'Sin perdedores con stop registrado.', masDe1R ? 'aviso' : ''),
    disc('Trades con tamaño ×2 o más', grandes.length ? String(grandes.length) : '0',
      grandes.length ? 'Resultado: <span class="' + clase(suma(grandes, (t) => t.neto)) + '">' + usd(suma(grandes, (t) => t.neto)) + '</span> frente a tu tamaño habitual.' : 'Tamaño consistente.'),
  ].join('');
}

function filaResumen(nombre, ts) {
  const m = metricas(ts);
  return `<tr><td>${nombre}</td><td class="n">${m.n}</td><td class="n">${pct(m.wr)}</td><td class="n ${clase(m.neto)}">${m.n ? usd(m.neto) : '—'}</td><td class="n ${clase(m.exp)}">${m.n ? usd(m.exp) : '—'}</td></tr>`;
}
const cabResumen = '<thead><tr><th></th><th class="n">Trades</th><th class="n">Acierto</th><th class="n">Neto</th><th class="n">Promedio</th></tr></thead>';
function renderLado(ts) {
  $('#por-lado').innerHTML = `<table class="mini-tabla">${cabResumen}<tbody>${filaResumen('Long', ts.filter((t) => t.d > 0))}${filaResumen('Short', ts.filter((t) => t.d < 0))}</tbody></table>`;
}
function renderDuracion(ts) {
  const b = [['< 1 min', 0, 1], ['1–5 min', 1, 5], ['5–15 min', 5, 15], ['15–60 min', 15, 60], ['> 1 hora', 60, 1e9]];
  $('#por-duracion').innerHTML = `<table class="mini-tabla">${cabResumen}<tbody>${b.map(([n, a, z]) =>
    filaResumen(n, ts.filter((t) => { const mi = (t.t1 - t.t0) / MIN; return mi >= a && mi < z; }))).join('')}</tbody></table>`;
}

/* ---------- Tabla de trades ---------- */
function renderTrades(ts) {
  const tabla = $('#trades');
  $('#n-trades').textContent = ts.length ? '(' + ts.length + ')' : '';
  if (!ts.length) { tabla.innerHTML = '<tbody><tr><td class="vacio-msg">Sin trades en este periodo.</td></tr></tbody>'; return; }
  const variasCuentas = new Set(ts.map((t) => t.c)).size > 1;
  const cab = ['Hora', variasCuentas ? 'Cuenta' : null, 'Lado', 'Cont.', 'Entrada', 'Salida', 'Duración', 'Pts', 'Neto', 'R', 'MFE', 'MAE', 'Cierre', 'Señales'].filter(Boolean);
  const num = new Set(['Cont.', 'Entrada', 'Salida', 'Duración', 'Pts', 'Neto', 'R', 'MFE', 'MAE']);
  const nCol = cab.length;
  let html = '<thead><tr>' + cab.map((c) => `<th class="${num.has(c) ? 'n' : ''}">${c}</th>`).join('') + '</tr></thead><tbody>';
  const lista = [...ts].reverse();
  let diaActual = null;
  const porDia = {};
  ts.forEach((t) => { const v = porDia[t.dia] || (porDia[t.dia] = { neto: 0, n: 0 }); v.neto += t.neto; v.n++; });
  lista.forEach((t) => {
    if (t.dia !== diaActual) {
      diaActual = t.dia;
      const v = porDia[t.dia];
      html += `<tr class="sep"><td colspan="${nCol}">${fmtFechaLarga.format(fechaDeDia(t.dia))} · <span class="${clase(v.neto)}">${usd(v.neto)}</span> · ${v.n} trade${v.n === 1 ? '' : 's'}</td></tr>`;
    }
    const c = S.d.porId[t.c];
    html += `<tr class="fila" data-id="${t.id}">
      <td>${fmtHora.format(new Date(t.t0))}</td>
      ${variasCuentas ? `<td><i class="punto" style="background:${c && c.color ? `var(${c.color})` : 'var(--muted)'}"></i> ${esc(c ? c.alias : t.c)}</td>` : ''}
      <td>${t.d > 0 ? 'Long' : 'Short'}</td>
      <td class="n">${t.q}</td>
      <td class="n">${fmtNum.format(t.pe)}</td>
      <td class="n">${fmtNum.format(t.ps)}</td>
      <td class="n">${duracion(t.t1 - t.t0)}</td>
      <td class="n ${clase(t.pts)}">${pts(t.pts)}</td>
      <td class="n ${clase(t.neto)}">${usd(t.neto)}</td>
      <td class="n">${t.r == null ? '—' : (t.r > 0 ? '+' : '') + t.r.toFixed(2)}</td>
      <td class="n">${t.mfe == null ? '—' : fmtNum.format(t.mfe)}</td>
      <td class="n">${t.mae == null ? '—' : fmtNum.format(t.mae)}</td>
      <td>${t.sal}</td>
      <td>${t.senales.map((s) => `<span class="senal" title="${esc(s[1])}">${esc(s[0])}</span>`).join('')}</td>
    </tr>`;
    if (S.abierto === t.id) html += `<tr class="detalle"><td colspan="${nCol}">${detalle(t)}</td></tr>`;
  });
  tabla.innerHTML = html + '</tbody>';
  tabla.querySelectorAll('tr.fila').forEach((f) => f.addEventListener('click', () => {
    const id = Number(f.dataset.id);
    S.abierto = S.abierto === id ? null : id;
    renderTrades(ts);
  }));
}

function detalle(t) {
  const c = S.d.porId[t.c];
  const l = [];
  l.push(`<div><b>${t.d > 0 ? 'Long' : 'Short'} ${t.q} ${t.s}</b> en ${esc(c ? c.alias : t.c)} · ${fmtHora.format(new Date(t.t0))} → ${fmtHora.format(new Date(t.t1))} (${duracion(t.t1 - t.t0)})</div>`);
  l.push(`<div>Entrada promedio <b>${fmtNum.format(t.pe)}</b> → salida promedio <b>${fmtNum.format(t.ps)}</b> = <span class="${clase(t.pts)}">${pts(t.pts)} pts</span>. Bruto ${usd(t.bruto)}, comisión est. ${usd(t.com, false)}, neto <b class="${clase(t.neto)}">${usd(t.neto)}</b>.</div>`);
  if (t.mfe != null) {
    let s = `A favor llegó a <b>+${fmtNum.format(t.mfe)} pts</b>`;
    if (t.mfe > 0 && t.pts > 0) s += `; capturaste el <b>${pct(t.captura)}</b> del movimiento (quedaron ${fmtNum.format(Math.max(0, t.mfe - t.pts))} pts en la mesa)`;
    else if (t.mfe > 0 && t.pts <= 0) s += ', pero terminó en pérdida';
    s += `. En contra llegó a <b>−${fmtNum.format(t.mae)} pts</b>.`;
    if (t.ent > 1) s += ' <span class="muted">(Valores promedio por contrato porque hubo escalado.)</span>';
    l.push(`<div>${s}</div>`);
  }
  if (t.riesgo) l.push(`<div>Stop inicial a <b>${fmtNum.format(t.riesgo.pts)} pts</b> (${usd(-t.riesgo.usd, false).replace('−', '')} de riesgo). Resultado: <b class="${clase(t.r)}">${(t.r > 0 ? '+' : '') + t.r.toFixed(2)}R</b>.</div>`);
  else l.push('<div class="aviso">No se encontró un stop colocado al momento de entrar.</div>');
  if (t.ent > 1) l.push(`<div>Escalado: ${t.ent} entradas, ${t.qt} contratos en total, posición máxima ${t.q}.</div>`);
  l.push(`<div>Cierre: ${t.sal === 'Stop' ? 'por stop' : t.sal === 'Target' ? 'por objetivo (target)' : 'manual'} · ${t.fills} ejecuciones · trade #${t.nDia} del día en esta cuenta.</div>`);
  t.senales.forEach((s) => l.push(`<div><span class="senal">${esc(s[0])}</span> ${esc(s[1])}.</div>`));
  return `<div class="det">${l.join('')}</div>`;
}

let tResize;
addEventListener('resize', () => { clearTimeout(tResize); tResize = setTimeout(() => { if (S.d && !$('#app').hidden) render(); }, 150); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (!leerLS('dt.tema')) { aplicarTema(null); if (S.d) render(); } });

iniciar();

#region Using declarations
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.ComponentModel.DataAnnotations;
using System.Globalization;
using System.Linq;
using System.Windows.Media;
using NinjaTrader.Cbi;
using NinjaTrader.Gui;
using NinjaTrader.Gui.Chart;
using NinjaTrader.Gui.Tools;
using NinjaTrader.NinjaScript.DrawingTools;
#endregion

// Asistente de agregados (Diario de trading).
// Muestra una tabla con una fila por cuenta que tenga posición abierta en el instrumento del gráfico y calcula
// cuántos contratos se pueden sumar sin que un retroceso hasta el stop se coma la ganancia que se quiere asegurar.
//   colchón (pts)     = ganancia abierta / (valor del punto x contratos)
//   contratos máximos = (ganancia abierta - ganancia a asegurar) / (valor del punto x distancia del stop)
namespace NinjaTrader.NinjaScript.Indicators
{
	public class AsistenteAgregados : Indicator
	{
		private static readonly CultureInfo Cultura = CultureInfo.GetCultureInfo("en-US");
		private static readonly Brush CTexto = Pincel(232, 231, 227);
		private static readonly Brush CMuted = Pincel(150, 149, 143);
		private static readonly Brush CGana = Pincel(91, 209, 91);
		private static readonly Brush CPierde = Pincel(240, 110, 110);
		private static readonly Brush CAviso = Pincel(250, 178, 25);
		private static readonly Brush CFondo = Pincel(12, 12, 12);
		private static readonly string[] Cabecera = { "Cuenta", "Posición", "Ganancia", "Si te saca tu stop", "Agregar", "Stop de todo", "Te quedas con" };

		private double ultimoPrecio;
		private System.Windows.Threading.DispatcherTimer timer;

		private class Fila
		{
			public string[] Celdas;
			public Brush[] Colores;
			public double LineaStop;
			public string Alias;
		}

		protected override void OnStateChange()
		{
			if (State == State.SetDefaults)
			{
				Name						= "AsistenteAgregados";
				Description					= "Tabla por cuenta: cuántos contratos puedes agregar sin arriesgar la ganancia que quieres asegurar.";
				Calculate					= Calculate.OnPriceChange;
				IsOverlay					= true;
				IsChartOnly					= true;
				DisplayInDataBox			= false;
				DrawOnPricePanel			= true;
				PaintPriceMarkers			= false;
				IsSuspendedWhileInactive	= false;
				FiltroCuentas				= string.Empty;
				DistanciaStop				= 25;
				Asegurar					= 0;
				Ubicacion					= TextPosition.TopLeft;
				TamanoLetra					= 12;
				MostrarLineas				= true;
			}
			else if (State == State.Historical)
			{
				// Redibuja dos veces por segundo para reflejar entradas, salidas y stops aunque el precio no se mueva.
				if (ChartControl != null)
					ChartControl.Dispatcher.InvokeAsync(() =>
					{
						timer = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromMilliseconds(500) };
						timer.Tick += (s, e) => ForceRefresh();
						timer.Start();
					});
			}
			else if (State == State.Terminated)
			{
				System.Windows.Threading.DispatcherTimer t = timer;
				timer = null;
				if (t != null)
					t.Dispatcher.InvokeAsync(() => t.Stop());
			}
		}

		protected override void OnBarUpdate()
		{
			ultimoPrecio = Close[0];
		}

		/* ---------- Cálculo ---------- */

		private List<Fila> Calcular(double precio)
		{
			List<Fila> filas = new List<Fila>();
			List<Account> cuentas;
			lock (Account.All)
				cuentas = Account.All.OrderBy(a => a.Name).ToList();

			double totalG = 0, totalStop = 0;
			bool todosConStop = true;
			foreach (Account a in cuentas)
			{
				if (!string.IsNullOrWhiteSpace(FiltroCuentas) && a.Name.IndexOf(FiltroCuentas.Trim(), StringComparison.OrdinalIgnoreCase) < 0)
					continue;
				Position pos;
				lock (a.Positions)
					pos = a.Positions.FirstOrDefault(p => p.Instrument.FullName == Instrument.FullName && p.MarketPosition != MarketPosition.Flat && p.Quantity > 0);
				if (pos == null)
					continue;

				int dir			= pos.MarketPosition == MarketPosition.Long ? 1 : -1;
				int n			= pos.Quantity;
				double pv		= Instrument.MasterInstrument.PointValue;
				double prom		= pos.AveragePrice;
				double aFavor	= (precio - prom) * dir;
				double g		= aFavor * n * pv;
				double porCont	= pv * DistanciaStop;
				int maxTot		= Math.Max(0, (int)Math.Floor((g - Asegurar) / porCont + 1e-9));
				int k			= Math.Max(0, maxTot - n);

				Fila f = new Fila { Alias = Alias(a.Name), Celdas = new string[7], Colores = new Brush[7] };
				f.Celdas[0] = f.Alias;
				f.Celdas[1] = (dir > 0 ? "L " : "S ") + n + " @ " + Precio(prom);
				f.Celdas[2] = Usd(g) + " (" + Pts(aFavor) + ")";
				f.Colores[2] = g > 0 ? CGana : g < 0 ? CPierde : CTexto;

				// Stops de salida trabajando para esta posición y cuánto queda si se ejecutan.
				int cubiertos = 0;
				double resultado = 0, precioStop = 0;
				lock (a.Orders)
				{
					foreach (Order o in a.Orders)
					{
						if (o.Instrument.FullName != Instrument.FullName)
							continue;
						if (o.OrderType != OrderType.StopMarket && o.OrderType != OrderType.StopLimit)
							continue;
						if (Order.IsTerminalState(o.OrderState) || o.OrderState == OrderState.Initialized)
							continue;
						bool sale = dir > 0 ? o.OrderAction == OrderAction.Sell : (o.OrderAction == OrderAction.BuyToCover || o.OrderAction == OrderAction.Buy);
						if (!sale)
							continue;
						int q = o.Quantity - o.Filled;
						cubiertos += q;
						resultado += (o.StopPrice - prom) * dir * q * pv;
						precioStop = o.StopPrice;
					}
				}
				if (cubiertos == 0)
				{
					f.Celdas[3] = "SIN STOP";
					f.Colores[3] = CAviso;
					todosConStop = false;
				}
				else
				{
					f.Celdas[3] = Usd(resultado) + " @ " + Precio(precioStop) + (cubiertos < n ? "  cubre " + cubiertos + "/" + n : "");
					f.Colores[3] = cubiertos < n ? CAviso : resultado < 0 ? CPierde : CGana;
					totalStop += resultado;
					if (cubiertos < n)
						todosConStop = false;
				}

				if (g <= 0)
				{
					f.Celdas[4] = "no · en contra";
					f.Colores[4] = CAviso;
				}
				else if (k == 0)
				{
					f.Celdas[4] = maxTot < n ? "no · ya tienes de más" : "no · faltan " + Usd(porCont * (n + 1) + Asegurar - g, false);
					f.Colores[4] = CAviso;
				}
				else
				{
					f.LineaStop = Instrument.MasterInstrument.RoundToTickSize(precio - dir * DistanciaStop);
					f.Celdas[4] = "hasta " + k + " (total " + maxTot + ")";
					f.Colores[4] = CGana;
					f.Celdas[5] = Precio(f.LineaStop);
					f.Celdas[6] = Usd(g - porCont * maxTot);
				}
				totalG += g;
				filas.Add(f);
			}

			if (filas.Count > 1)
			{
				Fila t = new Fila { Celdas = new string[7], Colores = new Brush[7] };
				t.Celdas[0] = "Total";
				t.Celdas[2] = Usd(totalG);
				t.Colores[2] = totalG > 0 ? CGana : totalG < 0 ? CPierde : CTexto;
				t.Celdas[3] = todosConStop ? Usd(totalStop) : "falta stop en alguna";
				t.Colores[3] = !todosConStop ? CAviso : totalStop < 0 ? CPierde : CGana;
				filas.Add(t);
			}
			return filas;
		}

		/* ---------- Dibujo ---------- */

		protected override void OnRender(ChartControl chartControl, ChartScale chartScale)
		{
			if (RenderTarget == null || Instrument == null || ultimoPrecio <= 0)
				return;
			List<Fila> filas = Calcular(ultimoPrecio);

			SharpDX.DirectWrite.TextFormat fNormal = new SimpleFont("Consolas", TamanoLetra).ToDirectWriteTextFormat();
			SharpDX.DirectWrite.TextFormat fNegrita = new SimpleFont("Consolas", TamanoLetra) { Bold = true }.ToDirectWriteTextFormat();
			Dictionary<Brush, SharpDX.Direct2D1.Brush> dx = new Dictionary<Brush, SharpDX.Direct2D1.Brush>();
			List<IDisposable> basura = new List<IDisposable> { fNormal, fNegrita };
			Func<Brush, SharpDX.Direct2D1.Brush> DX = b =>
			{
				SharpDX.Direct2D1.Brush r;
				if (!dx.TryGetValue(b, out r)) { r = b.ToDxBrush(RenderTarget); dx[b] = r; basura.Add(r); }
				return r;
			};
			Func<string, SharpDX.DirectWrite.TextFormat, SharpDX.DirectWrite.TextLayout> Medir = (txt, fmt) =>
			{
				SharpDX.DirectWrite.TextLayout l = new SharpDX.DirectWrite.TextLayout(Core.Globals.DirectWriteFactory, txt ?? string.Empty, fmt, 4000, 200);
				basura.Add(l);
				return l;
			};

			try
			{
				float pad = 8, sep = 16;
				float altoFila = Medir("Ag", fNormal).Metrics.Height + 4;
				string pie = filas.Count == 0
					? "Asistente de agregados · sin posiciones abiertas en " + Instrument.FullName + (string.IsNullOrWhiteSpace(FiltroCuentas) ? "" : " (filtro: " + FiltroCuentas.Trim() + ")")
					: "Stop a " + Num(DistanciaStop) + " pts · " + Usd(Instrument.MasterInstrument.PointValue * DistanciaStop, false) + " de ganancia por contrato"
						+ (Asegurar > 0 ? " + " + Usd(Asegurar, false) + " que no quieres devolver" : "") + " · Te quedas con = si agregas el máximo y el precio vuelve al stop";
				SharpDX.DirectWrite.TextLayout lPie = Medir(pie, fNormal);

				// Ancho de cada columna según su contenido más largo.
				float[] ancho = new float[Cabecera.Length];
				SharpDX.DirectWrite.TextLayout[] lCab = new SharpDX.DirectWrite.TextLayout[Cabecera.Length];
				SharpDX.DirectWrite.TextLayout[,] lCel = new SharpDX.DirectWrite.TextLayout[filas.Count, Cabecera.Length];
				if (filas.Count > 0)
					for (int c = 0; c < Cabecera.Length; c++)
					{
						lCab[c] = Medir(Cabecera[c], fNegrita);
						ancho[c] = lCab[c].Metrics.WidthIncludingTrailingWhitespace;
						for (int r = 0; r < filas.Count; r++)
						{
							lCel[r, c] = Medir(filas[r].Celdas[c] ?? (c >= 5 && filas[r].Alias != null ? "—" : ""), r == filas.Count - 1 && filas[r].Alias == null ? fNegrita : fNormal);
							ancho[c] = Math.Max(ancho[c], lCel[r, c].Metrics.WidthIncludingTrailingWhitespace);
						}
					}
				float anchoTabla = filas.Count > 0 ? ancho.Sum() + sep * (Cabecera.Length - 1) : 0;
				float w = Math.Max(anchoTabla, lPie.Metrics.Width) + pad * 2;
				float h = (filas.Count > 0 ? altoFila * (filas.Count + 1) + 6 : 0) + altoFila + pad * 2;
				bool derecha = Ubicacion == TextPosition.TopRight || Ubicacion == TextPosition.BottomRight;
				bool abajo = Ubicacion == TextPosition.BottomLeft || Ubicacion == TextPosition.BottomRight;
				float x0 = derecha ? ChartPanel.X + ChartPanel.W - w - 10 : ChartPanel.X + 10;
				float y0 = abajo ? ChartPanel.Y + ChartPanel.H - h - 10 : ChartPanel.Y + 10;

				SharpDX.Direct2D1.Brush fondo = CFondo.ToDxBrush(RenderTarget, 0.88f);
				basura.Add(fondo);
				RenderTarget.FillRectangle(new SharpDX.RectangleF(x0, y0, w, h), fondo);

				float y = y0 + pad;
				if (filas.Count > 0)
				{
					float x = x0 + pad;
					for (int c = 0; c < Cabecera.Length; c++) { RenderTarget.DrawTextLayout(new SharpDX.Vector2(x, y), lCab[c], DX(CMuted)); x += ancho[c] + sep; }
					y += altoFila;
					RenderTarget.DrawLine(new SharpDX.Vector2(x0 + pad, y + 1), new SharpDX.Vector2(x0 + w - pad, y + 1), DX(CMuted), 1);
					y += 4;
					for (int r = 0; r < filas.Count; r++)
					{
						if (filas[r].Alias == null)
						{
							RenderTarget.DrawLine(new SharpDX.Vector2(x0 + pad, y + 1), new SharpDX.Vector2(x0 + w - pad, y + 1), DX(CMuted), 1);
							y += 2;
						}
						x = x0 + pad;
						for (int c = 0; c < Cabecera.Length; c++)
						{
							Brush b = filas[r].Colores[c] ?? (filas[r].Celdas[c] == null ? CMuted : CTexto);
							RenderTarget.DrawTextLayout(new SharpDX.Vector2(x, y), lCel[r, c], DX(b));
							x += ancho[c] + sep;
						}
						y += altoFila;
					}
					y += 2;
				}
				RenderTarget.DrawTextLayout(new SharpDX.Vector2(x0 + pad, y), lPie, DX(CMuted));

				// Línea del stop sugerido, solo para las cuentas que pueden agregar, con el nombre de la cuenta.
				if (MostrarLineas)
				{
					SharpDX.Direct2D1.StrokeStyle guion = new SharpDX.Direct2D1.StrokeStyle(Core.Globals.D2DFactory,
						new SharpDX.Direct2D1.StrokeStyleProperties { DashStyle = SharpDX.Direct2D1.DashStyle.Dash });
					basura.Add(guion);
					List<float> etiquetas = new List<float>();
					SharpDX.Direct2D1.AntialiasMode modo = RenderTarget.AntialiasMode;
					RenderTarget.AntialiasMode = SharpDX.Direct2D1.AntialiasMode.Aliased;
					foreach (Fila f in filas.Where(f => f.LineaStop > 0))
					{
						float yl = chartScale.GetYByValue(f.LineaStop);
						if (yl < ChartPanel.Y || yl > ChartPanel.Y + ChartPanel.H)
							continue;
						RenderTarget.DrawLine(new SharpDX.Vector2(ChartPanel.X, yl), new SharpDX.Vector2(ChartPanel.X + ChartPanel.W, yl), DX(CGana), 1.5f, guion);
						SharpDX.DirectWrite.TextLayout le = Medir(f.Alias + " · stop si agregas " + f.Celdas[5], fNormal);
						float ye = yl - altoFila;
						while (etiquetas.Any(e => Math.Abs(e - ye) < altoFila))
							ye -= altoFila;
						etiquetas.Add(ye);
						float xe = ChartPanel.X + ChartPanel.W - le.Metrics.Width - 12;
						RenderTarget.FillRectangle(new SharpDX.RectangleF(xe - 4, ye, le.Metrics.Width + 8, altoFila - 2), fondo);
						RenderTarget.DrawTextLayout(new SharpDX.Vector2(xe, ye + 1), le, DX(CGana));
					}
					RenderTarget.AntialiasMode = modo;
				}
			}
			finally
			{
				foreach (IDisposable d in basura)
					d.Dispose();
			}
		}

		/* ---------- Formatos ---------- */

		private static Brush Pincel(byte r, byte g, byte b)
		{
			SolidColorBrush p = new SolidColorBrush(Color.FromRgb(r, g, b));
			p.Freeze();
			return p;
		}
		private static string Alias(string nombre)
		{
			if (nombre.StartsWith("PA-APEX-") && nombre.Length > 2)
				return "PA " + nombre.Substring(nombre.Length - 2);
			if (nombre.StartsWith("APEX-") && nombre.Length > 2)
				return "Eval " + nombre.Substring(nombre.Length - 2);
			return nombre;
		}
		private string Precio(double p) { return Instrument.MasterInstrument.FormatPrice(Instrument.MasterInstrument.RoundToTickSize(p)); }
		private static string Num(double v) { return v.ToString("0.##", Cultura); }
		private static string Pts(double v) { return (v > 0 ? "+" : v < 0 ? "-" : "") + Math.Abs(v).ToString("N1", Cultura); }
		private static string Usd(double v, bool signo = true)
		{
			string s = "$" + Math.Abs(v).ToString("N2", Cultura);
			return (v < 0 ? "-" : signo && v > 0 ? "+" : "") + s;
		}

		#region Properties
		[Display(Name = "Filtro de cuentas", Description = "Muestra solo las cuentas cuyo nombre contiene este texto (por ejemplo PA). Vacío = todas.", Order = 1, GroupName = "Asistente")]
		public string FiltroCuentas { get; set; }

		[Range(1, double.MaxValue)]
		[Display(Name = "Stop de toda la posición (pts)", Description = "A cuántos puntos del precio pondrás el stop de todos los contratos después de agregar.", Order = 2, GroupName = "Asistente")]
		public double DistanciaStop { get; set; }

		[Range(0, double.MaxValue)]
		[Display(Name = "Ganancia que no quieres devolver ($)", Description = "Si el precio se devuelve hasta el stop, el asistente cuida que te quedes al menos con esto en cada cuenta. Empieza con 0.", Order = 3, GroupName = "Asistente")]
		public double Asegurar { get; set; }

		[Display(Name = "Ubicación de la tabla", Order = 4, GroupName = "Asistente")]
		public TextPosition Ubicacion { get; set; }

		[Range(8, 30)]
		[Display(Name = "Tamaño de letra", Order = 5, GroupName = "Asistente")]
		public int TamanoLetra { get; set; }

		[Display(Name = "Dibujar línea del stop sugerido", Order = 6, GroupName = "Asistente")]
		public bool MostrarLineas { get; set; }
		#endregion
	}
}

#region NinjaScript generated code. Neither change nor remove.

namespace NinjaTrader.NinjaScript.Indicators
{
	public partial class Indicator : NinjaTrader.Gui.NinjaScript.IndicatorRenderBase
	{
		private AsistenteAgregados[] cacheAsistenteAgregados;
		public AsistenteAgregados AsistenteAgregados()
		{
			return AsistenteAgregados(Input);
		}

		public AsistenteAgregados AsistenteAgregados(ISeries<double> input)
		{
			if (cacheAsistenteAgregados != null)
				for (int idx = 0; idx < cacheAsistenteAgregados.Length; idx++)
					if (cacheAsistenteAgregados[idx] != null &&  cacheAsistenteAgregados[idx].EqualsInput(input))
						return cacheAsistenteAgregados[idx];
			return CacheIndicator<AsistenteAgregados>(new AsistenteAgregados(), input, ref cacheAsistenteAgregados);
		}
	}
}

namespace NinjaTrader.NinjaScript.MarketAnalyzerColumns
{
	public partial class MarketAnalyzerColumn : MarketAnalyzerColumnBase
	{
		public Indicators.AsistenteAgregados AsistenteAgregados()
		{
			return indicator.AsistenteAgregados(Input);
		}

		public Indicators.AsistenteAgregados AsistenteAgregados(ISeries<double> input )
		{
			return indicator.AsistenteAgregados(input);
		}
	}
}

namespace NinjaTrader.NinjaScript.Strategies
{
	public partial class Strategy : NinjaTrader.Gui.NinjaScript.StrategyRenderBase
	{
		public Indicators.AsistenteAgregados AsistenteAgregados()
		{
			return indicator.AsistenteAgregados(Input);
		}

		public Indicators.AsistenteAgregados AsistenteAgregados(ISeries<double> input )
		{
			return indicator.AsistenteAgregados(input);
		}
	}
}

#endregion

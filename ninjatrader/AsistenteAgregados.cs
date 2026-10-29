#region Using declarations
using System;
using System.ComponentModel;
using System.ComponentModel.DataAnnotations;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Windows.Media;
using NinjaTrader.Cbi;
using NinjaTrader.Gui;
using NinjaTrader.Gui.Tools;
using NinjaTrader.NinjaScript.DrawingTools;
#endregion

// Asistente de agregados (Diario de trading).
// Lee la posición de la cuenta elegida en el instrumento del gráfico y calcula cuántos contratos se pueden sumar
// sin que un retroceso hasta el stop se coma la ganancia que se quiere asegurar.
//   colchón (pts)     = ganancia abierta / (valor del punto x contratos)
//   contratos máximos = (ganancia abierta - ganancia a asegurar) / (valor del punto x distancia del stop)
namespace NinjaTrader.NinjaScript.Indicators
{
	public class AsistenteAgregados : Indicator
	{
		private static readonly CultureInfo Cultura = CultureInfo.GetCultureInfo("en-US");
		private Account cuenta;
		private DateTime ultimoDibujo = DateTime.MinValue;

		protected override void OnStateChange()
		{
			if (State == State.SetDefaults)
			{
				Name						= "AsistenteAgregados";
				Description					= "Calcula cuántos contratos puedes agregar a tu posición sin arriesgar la ganancia que quieres asegurar.";
				Calculate					= Calculate.OnPriceChange;
				IsOverlay					= true;
				IsChartOnly					= true;
				DisplayInDataBox			= false;
				DrawOnPricePanel			= true;
				PaintPriceMarkers			= false;
				IsSuspendedWhileInactive	= false;
				Cuenta						= string.Empty;
				DistanciaStop				= 25;
				Asegurar					= 0;
				Ubicacion					= TextPosition.TopLeft;
				TamanoLetra					= 13;
				MostrarLinea				= true;
			}
			else if (State == State.DataLoaded)
			{
				lock (Account.All)
				{
					cuenta = Account.All.FirstOrDefault(a => a.Name == Cuenta);
					if (cuenta == null && string.IsNullOrEmpty(Cuenta))
						cuenta = Account.All.FirstOrDefault(a => a.Name.StartsWith("PA-APEX"));
				}
			}
		}

		protected override void OnBarUpdate()
		{
			// Solo importa el precio actual: se dibuja en la última barra histórica y luego en tiempo real.
			if (State == State.Historical && CurrentBar < Count - 2)
				return;
			// MNQ cambia de precio muchas veces por segundo; con redibujar cuatro veces por segundo basta.
			if (State == State.Realtime && (DateTime.Now - ultimoDibujo).TotalMilliseconds < 250)
				return;
			ultimoDibujo = DateTime.Now;
			Dibujar(Close[0]);
		}

		private void Dibujar(double precio)
		{
			Brush color = Brushes.WhiteSmoke;
			double lineaStop = 0;
			StringBuilder t = new StringBuilder();

			if (cuenta == null)
			{
				t.AppendLine("ASISTENTE DE AGREGADOS");
				t.Append("No encontré la cuenta \"" + Cuenta + "\". Elígela en las propiedades del indicador.");
			}
			else
			{
				t.AppendLine("ASISTENTE DE AGREGADOS · " + cuenta.Name);
				Position pos;
				lock (cuenta.Positions)
					pos = cuenta.Positions.FirstOrDefault(p => p.Instrument.FullName == Instrument.FullName);

				if (pos == null || pos.MarketPosition == MarketPosition.Flat || pos.Quantity == 0)
					t.Append("Sin posición abierta en " + Instrument.MasterInstrument.Name + ".");
				else
				{
					int dir			= pos.MarketPosition == MarketPosition.Long ? 1 : -1;
					int n			= pos.Quantity;
					double pv		= Instrument.MasterInstrument.PointValue;
					double prom		= pos.AveragePrice;
					double aFavor	= (precio - prom) * dir;
					double g		= aFavor * n * pv;
					double porCont	= pv * DistanciaStop;
					int maxTot		= Math.Max(0, (int)Math.Floor((g - Asegurar) / porCont + 1e-9));
					int k			= Math.Max(0, maxTot - n);

					t.AppendLine((dir > 0 ? "Long " : "Short ") + n + " " + Instrument.MasterInstrument.Name + " @ " + Precio(prom));
					t.AppendLine("Ganancia abierta   " + Usd(g) + "  (" + Pts(aFavor) + " pts)");
					t.AppendLine("Colchón actual     " + Num(Math.Max(0, aFavor)) + " pts");
					AnotarStopActual(t, dir, n, prom, pv);
					t.AppendLine("------------------------------------------");

					if (g <= 0)
					{
						color = Brushes.Orange;
						t.Append("NO AGREGUES: la posición va en contra.");
					}
					else if (k == 0)
					{
						color = Brushes.Orange;
						double falta = porCont * (n + 1) + Asegurar - g;
						t.AppendLine(maxTot < n ? "NO AGREGUES: ya tienes más de lo que cubre tu ganancia." : "TODAVÍA NO AGREGUES");
						t.AppendLine("Si el stop está a " + Num(DistanciaStop) + " pts, te quedas con " + Usd(g - porCont * n));
						t.Append("Para agregar 1 te faltan " + Usd(falta, false) + " de ganancia");
					}
					else
					{
						color = Brushes.LightGreen;
						double nuevoProm = (prom * n + precio * k) / (n + k);
						lineaStop = Instrument.MasterInstrument.RoundToTickSize(precio - dir * DistanciaStop);
						t.AppendLine("PUEDES AGREGAR " + k + "  (total " + maxTot + ")");
						t.AppendLine("Nuevo promedio     " + Precio(nuevoProm) + "  colchón " + Num(g / (pv * maxTot)) + " pts");
						t.AppendLine("Stop de TODO en    " + Precio(lineaStop) + "  (" + Num(DistanciaStop) + " pts)");
						t.Append("Si toca, aseguras  " + Usd(g - porCont * maxTot));
					}
					t.AppendLine();
					t.Append("Regla: " + Usd(porCont, false) + " de ganancia por contrato" + (Asegurar > 0 ? " + " + Usd(Asegurar, false) + " asegurados" : ""));
				}
			}

			Draw.TextFixed(this, "AA_texto", t.ToString(), Ubicacion, color, new SimpleFont("Consolas", TamanoLetra), Brushes.Transparent, Brushes.Black, 80);
			if (MostrarLinea && lineaStop > 0)
				Draw.HorizontalLine(this, "AA_stop", lineaStop, Brushes.Orange, DashStyleHelper.Dash, 2);
			else
				RemoveDrawObject("AA_stop");
		}

		// Stops de salida que hay trabajando para esta posición y cuánto queda si se ejecutan.
		private void AnotarStopActual(StringBuilder t, int dir, int n, double prom, double pv)
		{
			int cubiertos = 0;
			double resultado = 0, precioStop = 0;
			lock (cuenta.Orders)
			{
				foreach (Order o in cuenta.Orders)
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
				t.AppendLine("Stop actual        !! SIN STOP");
			else
			{
				t.AppendLine("Stop actual        " + Precio(precioStop) + "  si toca " + Usd(resultado));
				if (cubiertos < n)
					t.AppendLine("                   !! cubre solo " + cubiertos + " de " + n + " contratos");
			}
		}

		private string Precio(double p) { return Instrument.MasterInstrument.FormatPrice(Instrument.MasterInstrument.RoundToTickSize(p)); }
		private static string Num(double v) { return v.ToString("N1", Cultura); }
		private static string Pts(double v) { return (v > 0 ? "+" : v < 0 ? "-" : "") + Math.Abs(v).ToString("N1", Cultura); }
		private static string Usd(double v, bool signo = true)
		{
			string s = "$" + Math.Abs(v).ToString("N2", Cultura);
			return (v < 0 ? "-" : signo && v > 0 ? "+" : "") + s;
		}

		#region Properties
		[TypeConverter(typeof(NinjaTrader.NinjaScript.AccountNameConverter))]
		[Display(Name = "Cuenta", Description = "Cuenta cuya posición se analiza.", Order = 1, GroupName = "Asistente")]
		public string Cuenta { get; set; }

		[Range(1, double.MaxValue)]
		[Display(Name = "Stop de toda la posición (pts)", Description = "A cuántos puntos del precio pondrás el stop de todos los contratos después de agregar.", Order = 2, GroupName = "Asistente")]
		public double DistanciaStop { get; set; }

		[Range(0, double.MaxValue)]
		[Display(Name = "Ganancia a asegurar ($)", Description = "Lo mínimo que quieres llevarte si el precio se devuelve hasta el stop.", Order = 3, GroupName = "Asistente")]
		public double Asegurar { get; set; }

		[Display(Name = "Ubicación del cuadro", Order = 4, GroupName = "Asistente")]
		public TextPosition Ubicacion { get; set; }

		[Range(8, 30)]
		[Display(Name = "Tamaño de letra", Order = 5, GroupName = "Asistente")]
		public int TamanoLetra { get; set; }

		[Display(Name = "Dibujar línea del stop sugerido", Order = 6, GroupName = "Asistente")]
		public bool MostrarLinea { get; set; }
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

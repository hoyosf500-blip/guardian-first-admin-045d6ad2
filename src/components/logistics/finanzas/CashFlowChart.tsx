import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip as RTooltip, Legend,
} from 'recharts';
import { Activity } from 'lucide-react';
import { formatCOP } from '@/lib/utils';
import { TiltCard } from '@/components/ui3d';
import {
  CHART_TOOLTIP_STYLE, CHART_GRID_PROPS, CHART_BAR_CURSOR, fmtCompact,
} from '../charts/chartTokens';

export interface CashFlowSeriesPoint {
  fecha: string;       // YYYY-MM-DD
  ENTRADA: number;     // monto positivo abonado al wallet ese día
  SALIDA: number;      // monto positivo debitado del wallet ese día
}

interface CashFlowChartProps {
  series: CashFlowSeriesPoint[];
  isLoading?: boolean;
}

// TOOLTIP_STYLE y fmtCompact ya no viven acá: se importan de chartTokens, que
// es lo que usa BilleteraTab. Eran el mismo gráfico con dos estilos distintos.
//
// fmtDay SÍ se queda local, y no por olvido: la versión de chartTokens no fuerza
// timeZone. El string se parsea como UTC ('T00:00:00Z'), así que sin el
// timeZone:'UTC' del toLocaleDateString el render en Bogotá (UTC-5) rotula el
// bucket del 1 de junio como "31 may.". Es el mismo bug de -1 día anotado en
// LogisticaTab.parseLocalDate. NO simplificar a new Date(s).
function fmtDay(s: string): string {
  const d = new Date(s + 'T00:00:00Z');
  return d.toLocaleDateString('es-CO', { day: '2-digit', month: 'short', timeZone: 'UTC' });
}

const CHART_SUCCESS = 'hsl(var(--success))';
const CHART_DANGER = 'hsl(var(--danger))';
const tickStyle = { fontSize: 10, fill: 'hsl(var(--muted-foreground))' };

export default function CashFlowChart({ series, isLoading = false }: CashFlowChartProps) {
  if (isLoading) {
    return <div className="rounded-2xl border border-border bg-card/40 shadow-card3d hairline-top animate-pulse h-[340px]" />;
  }

  const totalIn = series.reduce((acc, s) => acc + s.ENTRADA, 0);
  const totalOut = series.reduce((acc, s) => acc + s.SALIDA, 0);
  const neto = totalIn - totalOut;

  return (
    <TiltCard className="bg-card/40 border border-border rounded-2xl p-5 shadow-card3d h-full transition-colors duration-200 hover:border-border-strong">
      <div className="flex items-start justify-between gap-3 mb-4 tilt-layer-1">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Activity size={14} className="text-success" aria-hidden="true" /> Cash flow diario
          </h3>
          <p className="text-[10px] text-muted-foreground mt-1">
            Entradas vs salidas por día (wallet Dropi)
          </p>
        </div>
        <div className="text-right shrink-0">
          <div className={`font-mono tabular-nums text-lg font-bold leading-none ${
            neto >= 0 ? 'text-success num-glow-success' : 'text-danger num-glow-danger'
          }`}>
            {neto >= 0 ? '+' : ''}{formatCOP(neto)}
          </div>
          <div className="hud-label text-subtle mt-1.5">
            neto
          </div>
        </div>
      </div>

      {series.length === 0 ? (
        <div className="flex items-center justify-center h-[260px] text-xs text-muted-foreground">
          Sin movimientos en este rango
        </div>
      ) : (
        <div className="h-[260px] tilt-layer-2">
          <ResponsiveContainer>
            {/* left:-10 (no -15) con YAxis width=50: con -15 el área útil para
                los ticks bajaba a ~35px y `fmtCompact` sobre pesos produce
                etiquetas tipo "1,2 M" que se recortaban en el rango alto. */}
            <BarChart data={series} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
              <defs>
                {/* Degradado vertical por serie: pleno arriba, tenue en la base.
                    Es lo que separa una barra con volumen de un rectángulo de
                    color plano. */}
                <linearGradient id="finCashInGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={CHART_SUCCESS} stopOpacity={0.95} />
                  <stop offset="100%" stopColor={CHART_SUCCESS} stopOpacity={0.35} />
                </linearGradient>
                <linearGradient id="finCashOutGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={CHART_DANGER} stopOpacity={0.95} />
                  <stop offset="100%" stopColor={CHART_DANGER} stopOpacity={0.35} />
                </linearGradient>
              </defs>
              <CartesianGrid {...CHART_GRID_PROPS} />
              <XAxis
                dataKey="fecha"
                tickFormatter={fmtDay}
                tick={tickStyle}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                tickFormatter={fmtCompact}
                tick={tickStyle}
                tickLine={false}
                axisLine={false}
                width={50}
              />
              <RTooltip
                contentStyle={CHART_TOOLTIP_STYLE}
                cursor={CHART_BAR_CURSOR}
                formatter={(v: number, name) => [formatCOP(v), name as string]}
                labelFormatter={(l) => fmtDay(String(l))}
              />
              <Legend
                wrapperStyle={{ fontSize: 10, paddingTop: 6 }}
                iconType="circle"
                iconSize={8}
              />
              {/* En una pila SOLO el segmento de arriba lleva radio: si los dos
                  lo llevan quedan muescas entre segmentos (era el caso, ambos
                  tenían radius [3,3,0,0]). ENTRADA va abajo → sin radio. */}
              <Bar
                dataKey="ENTRADA" stackId="a" name="Entrada"
                fill="url(#finCashInGrad)" radius={[0, 0, 0, 0]}
                style={{ filter: `drop-shadow(0 0 6px ${CHART_SUCCESS})` }}
              />
              <Bar
                dataKey="SALIDA" stackId="a" name="Salida"
                fill="url(#finCashOutGrad)" radius={[6, 6, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </TiltCard>
  );
}

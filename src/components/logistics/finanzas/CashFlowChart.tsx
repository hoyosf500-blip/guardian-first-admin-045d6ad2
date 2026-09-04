import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip as RTooltip, Legend,
} from 'recharts';
import { Activity, AlertTriangle } from 'lucide-react';
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
  /** La consulta falló. NO es lo mismo que una serie vacía: ver el bloque de
   *  abajo. Sin esto, un error de red se dibujaba como "+$0 · sin movimientos". */
  isError?: boolean;
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

export default function CashFlowChart({ series, isLoading = false, isError = false }: CashFlowChartProps) {
  if (isLoading) {
    return <div className="rounded-2xl border border-border bg-card/40 shadow-card3d hairline-top animate-pulse h-[340px]" />;
  }

  // ⛔ NO SE PUDO LEER ≠ NO SE MOVIÓ PLATA (4-sep-2026). Con la consulta caída,
  // `series` llegaba vacía y esta tarjeta calculaba `neto = 0 − 0`, lo pintaba
  // EN VERDE DE ÉXITO y escribía "Sin movimientos en este rango". O sea: un
  // fallo de red se leía como una quincena tranquila, en la pantalla de la
  // plata. El cero se muestra solo cuando de verdad se midió cero.
  if (isError) {
    return (
      <TiltCard className="bg-card/40 border border-warning/30 rounded-2xl p-5 shadow-card3d h-full">
        <div className="flex items-start gap-2.5">
          <AlertTriangle size={15} className="text-warning shrink-0 mt-0.5" aria-hidden="true" />
          <div>
            <div className="text-xs font-semibold text-warning">No se pudo leer el movimiento del wallet</div>
            <p className="text-[11px] text-muted-foreground leading-relaxed mt-1">
              No es que no haya movimientos: es que la consulta falló. Recargá o tocá
              Sincronizar; hasta entonces este gráfico no dice nada.
            </p>
          </div>
        </div>
      </TiltCard>
    );
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
          {/* Este neto suma TODOS los movimientos de la serie (retiros y depósitos
              de tesorería incluidos) — por eso NO cuadra con la Ganancia Neta del
              hero, que solo mira lo operativo. Se dice en la cara. */}
          <div className="text-[10px] text-muted-foreground leading-snug mt-1 max-w-[170px]">
            movimiento total del wallet · incluye retiros y depósitos, no es ganancia
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

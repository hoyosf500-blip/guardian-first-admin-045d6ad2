import { useMemo } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip as RTooltip } from 'recharts';
import { CheckCircle2, RotateCcw, Ban, Clock, PieChart as PieIcon } from 'lucide-react';
import { TiltCard } from '@/components/ui3d';
import { CHART_TOOLTIP_STYLE } from '../charts/chartTokens';

interface EstadoOrdenesDonutProps {
  totalOrdenes: number;
  entregadas: number;
  devueltas: number;
  canceladas: number;
  isLoading?: boolean;
  /** Tasa de entrega MADURA (÷ resueltos) calculada por el padre — la misma del
   *  KpiCard "Tasa de entrega". El centro del donut mostraba entregadas÷TOTAL
   *  (con canceladas y pendientes) al lado del KPI maduro: dos números con la
   *  misma etiqueta en la misma pantalla (auditoría 2026-07-07). */
  tasaEntregaMadura?: number | null;
  /** true → cohorte inmaduro: el centro se atenúa y marca "prelim." */
  tasaPreliminar?: boolean;
}

// Los ids de <linearGradient> son GLOBALES al documento: si otro chart de la
// misma pantalla declarara "grad0", el navegador tomaría el primero que
// encuentre y las porciones se pintarían con el color equivocado. Por eso el
// prefijo largo y específico.
const GRAD_ID = 'finEstadoOrdenesGrad';

export default function EstadoOrdenesDonut({
  totalOrdenes, entregadas, devueltas, canceladas, isLoading = false,
  tasaEntregaMadura, tasaPreliminar = false,
}: EstadoOrdenesDonutProps) {
  const pendientes = Math.max(0, totalOrdenes - entregadas - devueltas - canceladas);

  const data = useMemo(() => [
    { name: 'Entregadas', value: entregadas, color: 'hsl(var(--success))', soft: 'hsl(var(--success) / 0.45)', dot: 'bg-success', icon: CheckCircle2 },
    { name: 'Devueltas',  value: devueltas,  color: 'hsl(var(--danger))',  soft: 'hsl(var(--danger) / 0.45)',  dot: 'bg-danger',  icon: RotateCcw },
    { name: 'Pendientes', value: pendientes, color: 'hsl(var(--info))',    soft: 'hsl(var(--info) / 0.45)',    dot: 'bg-info',    icon: Clock },
    { name: 'Canceladas', value: canceladas, color: 'hsl(var(--muted-foreground))', soft: 'hsl(var(--muted-foreground) / 0.45)', dot: 'bg-muted-foreground', icon: Ban },
  ], [entregadas, devueltas, pendientes, canceladas]);

  const total = totalOrdenes || 1;
  // Centro del donut = la tasa MADURA del padre (misma que el KPI de al lado).
  // Fallback legacy (padre viejo sin prop): resueltos locales, no ÷ total.
  const resueltosLocal = entregadas + devueltas;
  const tasaEntrega = tasaEntregaMadura ?? (resueltosLocal > 0 ? (entregadas / resueltosLocal) * 100 : null);

  if (isLoading) {
    return <div className="rounded-2xl border border-border bg-card/40 shadow-card3d hairline-top animate-pulse h-[340px]" />;
  }

  if (totalOrdenes === 0) {
    return (
      <TiltCard className="bg-card/40 border border-border rounded-2xl p-5 shadow-card3d h-[340px] flex flex-col items-center justify-center text-center">
        <div className="w-9 h-9 rounded-xl border flex items-center justify-center bg-muted/60 border-border text-muted-foreground mb-3">
          <PieIcon size={17} aria-hidden="true" />
        </div>
        <div className="hud-label text-subtle mb-2">Estado de órdenes</div>
        <div className="text-xs text-muted-foreground">Sin órdenes en este rango</div>
      </TiltCard>
    );
  }

  return (
    <TiltCard className="bg-card/40 border border-border rounded-2xl p-5 shadow-card3d h-full transition-colors duration-200 hover:border-border-strong">
      <div className="flex items-center justify-between gap-3 mb-4 tilt-layer-1">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <PieIcon size={14} className="text-accent" aria-hidden="true" /> Estado de órdenes
        </h3>
        <span className="font-mono tabular-nums text-[10px] text-muted-foreground">
          {totalOrdenes} totales
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-[190px,1fr] gap-5 items-center">
        <div className="relative h-[190px] w-full tilt-layer-3">
          <ResponsiveContainer>
            <PieChart>
              <defs>
                {/* Cada porción va con degradado vertical propio (pleno arriba →
                    tenue abajo): es lo que le da volumen a la dona en vez de
                    cuatro bloques de color plano. */}
                {data.map((d, i) => (
                  <linearGradient key={d.name} id={`${GRAD_ID}${i}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={d.color} />
                    <stop offset="100%" stopColor={d.soft} />
                  </linearGradient>
                ))}
              </defs>
              <Pie
                data={data}
                cx="50%" cy="50%"
                innerRadius={56} outerRadius={86}
                paddingAngle={2}
                dataKey="value"
                stroke="none"
              >
                {data.map((d, i) => (
                  <Cell
                    key={d.name}
                    fill={`url(#${GRAD_ID}${i})`}
                    // El glow del lenguaje: 6px para superficies (barras, porciones).
                    style={{ filter: `drop-shadow(0 0 6px ${d.soft})` }}
                  />
                ))}
              </Pie>
              <RTooltip
                contentStyle={CHART_TOOLTIP_STYLE}
                formatter={(v: number, name) => [
                  `${v} (${((v / total) * 100).toFixed(1)}%)`,
                  name as string,
                ]}
              />
            </PieChart>
          </ResponsiveContainer>
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            {/* Un SOLO nodo de texto con el mismo toFixed(1) de siempre, y el '—'
                intacto cuando el padre no pudo calcular la tasa. */}
            <div
              className={`font-mono tabular-nums text-[26px] font-bold leading-none ${
                tasaPreliminar ? 'text-muted-foreground' : 'text-success num-glow-success'
              }`}
            >
              {tasaEntrega == null ? '—' : `${tasaEntrega.toFixed(1)}%`}
            </div>
            <div className="hud-label text-subtle mt-1.5">
              entrega · resueltos{tasaPreliminar ? ' · prelim.' : ''}
            </div>
          </div>
        </div>

        {/* Leyenda con barra proporcional: el conteo dejó de ser una columna de
            números sueltos y ahora se ve de qué tamaño es cada estado. */}
        <ul className="space-y-2.5 tilt-layer-1">
          {data.map(({ name, value, color, soft, dot, icon: Icon }) => {
            const pct = (value / total) * 100;
            return (
              <li key={name} className="space-y-1.5">
                <div className="flex items-center gap-2.5">
                  <span className={`w-2.5 h-2.5 rounded-[3px] shrink-0 ${dot}`} aria-hidden="true" />
                  <Icon size={13} className="text-muted-foreground shrink-0" aria-hidden="true" />
                  <span className="text-xs font-medium text-foreground flex-1 min-w-0 truncate">{name}</span>
                  <span className="font-mono tabular-nums text-xs text-muted-foreground">
                    {value}
                  </span>
                  <span className="font-mono tabular-nums text-[11px] font-semibold text-foreground w-12 text-right">
                    {pct.toFixed(1)}%
                  </span>
                </div>
                <div className="h-1 rounded-full bg-foreground/10 overflow-hidden">
                  <div
                    className="h-full rounded-full transition-[width] duration-700"
                    style={{
                      // Sin piso artificial: un estado en 0 deja la pista vacía.
                      // Inflar la barra para que "se vea" sería dibujar un dato
                      // que no existe.
                      width: `${pct}%`,
                      background: `linear-gradient(90deg, ${soft}, ${color})`,
                    }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </TiltCard>
  );
}

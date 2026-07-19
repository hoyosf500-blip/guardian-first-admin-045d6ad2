import { useMemo } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip as RTooltip } from 'recharts';
import { CheckCircle2, RotateCcw, Ban, Clock } from 'lucide-react';

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

const TOOLTIP_STYLE = {
  background: 'hsl(var(--card) / 0.96)',
  border: '1px solid hsl(var(--border-strong))',
  borderRadius: 8,
  color: 'hsl(var(--foreground))',
  fontSize: 12,
  padding: '8px 10px',
  boxShadow: 'var(--shadow-md)',
};

export default function EstadoOrdenesDonut({
  totalOrdenes, entregadas, devueltas, canceladas, isLoading = false,
  tasaEntregaMadura, tasaPreliminar = false,
}: EstadoOrdenesDonutProps) {
  const pendientes = Math.max(0, totalOrdenes - entregadas - devueltas - canceladas);

  const data = useMemo(() => [
    { name: 'Entregadas', value: entregadas, color: 'hsl(var(--success))', icon: CheckCircle2 },
    { name: 'Devueltas',  value: devueltas,  color: 'hsl(var(--danger))',  icon: RotateCcw },
    { name: 'Pendientes', value: pendientes, color: 'hsl(var(--info))',    icon: Clock },
    { name: 'Canceladas', value: canceladas, color: 'hsl(var(--muted-foreground))', icon: Ban },
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
      <div className="rounded-2xl border border-border bg-card/40 p-5 shadow-card3d hairline-top h-[340px] flex flex-col items-center justify-center text-center">
        <div className="text-sm font-bold text-foreground tracking-tight uppercase tracking-[0.06em] mb-2">
          Estado de órdenes
        </div>
        <div className="text-xs text-muted-foreground">Sin órdenes en este rango</div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border bg-card/40 p-5 shadow-card3d hairline-top transition-colors hover:border-border-strong">
      <div className="flex items-end justify-between gap-3 mb-3">
        <h3 className="text-sm font-bold text-foreground tracking-tight uppercase tracking-[0.06em]">
          Estado de órdenes
        </h3>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {totalOrdenes} totales
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-[180px,1fr] gap-5 items-center">
        <div className="relative h-[180px] w-full">
          <ResponsiveContainer>
            <PieChart>
              <Pie
                data={data}
                cx="50%" cy="50%"
                innerRadius={50} outerRadius={80}
                paddingAngle={2}
                dataKey="value"
                stroke="hsl(var(--card))"
                strokeWidth={2}
              >
                {data.map((d, i) => <Cell key={i} fill={d.color} />)}
              </Pie>
              <RTooltip
                contentStyle={TOOLTIP_STYLE}
                formatter={(v: number, name) => [
                  `${v} (${((v / total) * 100).toFixed(1)}%)`,
                  name as string,
                ]}
              />
            </PieChart>
          </ResponsiveContainer>
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            <div className={`text-2xl font-extrabold tabular-nums leading-none ${tasaPreliminar ? 'text-muted-foreground' : 'text-success'}`}>
              {tasaEntrega == null ? '—' : `${tasaEntrega.toFixed(1)}%`}
            </div>
            <div className="text-[10px] uppercase tracking-[0.1em] font-semibold text-muted-foreground mt-1">
              entrega · resueltos{tasaPreliminar ? ' · prelim.' : ''}
            </div>
          </div>
        </div>

        <ul className="space-y-2">
          {data.map(({ name, value, color, icon: Icon }) => {
            const pct = (value / total) * 100;
            return (
              <li key={name} className="flex items-center gap-3">
                <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: color }} />
                <Icon size={13} className="text-muted-foreground shrink-0" />
                <span className="text-xs font-medium text-foreground flex-1">{name}</span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {value}
                </span>
                <span className="text-[11px] tabular-nums font-semibold text-foreground w-12 text-right">
                  {pct.toFixed(1)}%
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

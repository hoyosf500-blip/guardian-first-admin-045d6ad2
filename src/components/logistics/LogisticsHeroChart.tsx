import { memo, useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid } from 'recharts';
import type { CarrierStats } from '@/lib/logistics.types';

interface Props {
  rows: CarrierStats[];
}

interface TooltipPayload {
  payload: CarrierStats;
}
function HeroTooltip({ active, payload }: { active?: boolean; payload?: TooltipPayload[] }) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  return (
    <div className="rounded-lg border border-border bg-card/95 backdrop-blur-sm p-3 shadow-2xl text-xs min-w-[220px]">
      <div className="mb-2 font-bold text-sm text-foreground">{d.transportadora}</div>
      <div className="space-y-1.5">
        <Row dot="bg-success" label="Entregados"  value={d.entregados}        extra={`${d.tasa_entrega.toFixed(1)}%`}    valueClass="text-success" />
        <Row dot="bg-info"    label="En tránsito" value={d.en_transito ?? 0}                                              valueClass="text-info" />
        <Row dot="bg-warning" label="Novedades"   value={d.novedades ?? 0}                                                valueClass="text-warning" />
        <Row dot="bg-danger"  label="Devueltos"   value={d.devueltos}         extra={`${d.tasa_devolucion.toFixed(1)}%`} valueClass="text-danger" />
        <div className="flex items-center justify-between gap-4 pt-1.5 mt-1.5 border-t border-border/60">
          <span className="text-muted-foreground">Total envíos</span>
          <span className="font-mono font-bold tabular-nums text-foreground">{d.total_pedidos.toLocaleString('es-CO')}</span>
        </div>
      </div>
    </div>
  );
}
function Row({ dot, label, value, extra, valueClass }: { dot: string; label: string; value: number; extra?: string; valueClass?: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden="true" />
        {label}
      </span>
      <span className={`font-mono font-bold tabular-nums ${valueClass ?? 'text-foreground'}`}>
        {value.toLocaleString('es-CO')}{extra ? <span className="ml-1.5 font-normal opacity-60">{extra}</span> : null}
      </span>
    </div>
  );
}

/** Hero chart: stacked vertical bar chart con top 8 transportadoras
 *  por volumen. Cada barra muestra composición real (entregados +
 *  tránsito + novedades + devueltos). Patrón usado por dashboards
 *  profesionales de logística (Aryo, Stripe shipping). */
export default memo(function LogisticsHeroChart({ rows }: Props) {
  const top = useMemo(() => {
    return [...rows]
      .sort((a, b) => (b.total_pedidos ?? 0) - (a.total_pedidos ?? 0))
      .slice(0, 8)
      // Truncamos nombres largos para que quepan en el eje X
      .map(r => ({
        ...r,
        name: r.transportadora.length > 10 ? r.transportadora.slice(0, 9) + '…' : r.transportadora,
      }));
  }, [rows]);

  if (top.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-5 h-full flex flex-col items-center justify-center text-center min-h-[280px]">
        <p className="text-sm font-semibold text-foreground mb-1">Sin datos</p>
        <p className="text-xs text-muted-foreground max-w-xs">
          No hay transportadoras con suficientes pedidos en este rango.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card p-5 h-full flex flex-col">
      {/* Header con título + leyenda inline (oculta en mobile) */}
      <header className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-foreground tracking-tight">
            Volumen por transportadora
          </h2>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Top 8 — composición de envíos por estado actual
          </p>
        </div>
        <div className="hidden md:flex items-center gap-3 text-[11px] text-muted-foreground">
          {[
            { color: 'hsl(var(--success))', label: 'Entregados' },
            { color: 'hsl(var(--info))',    label: 'Tránsito' },
            { color: 'hsl(var(--warning))', label: 'Novedades' },
            { color: 'hsl(var(--danger))',  label: 'Devueltos' },
          ].map(it => (
            <span key={it.label} className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-sm" style={{ background: it.color }} aria-hidden="true" />
              {it.label}
            </span>
          ))}
        </div>
      </header>

      <div className="flex-1 min-h-[240px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={top}
            margin={{ top: 8, right: 8, left: -16, bottom: 4 }}
            barCategoryGap="22%"
          >
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
            <XAxis
              dataKey="name"
              tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
              tickLine={false}
              axisLine={false}
              interval={0}
            />
            <YAxis
              tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
              tickLine={false}
              axisLine={false}
              allowDecimals={false}
            />
            <Tooltip content={<HeroTooltip />} cursor={{ fill: 'hsl(var(--muted)/0.3)' }} />
            <Bar dataKey="entregados"  stackId="vol" name="Entregados"  fill="hsl(var(--success))" />
            <Bar dataKey="en_transito" stackId="vol" name="En tránsito" fill="hsl(var(--info))" />
            <Bar dataKey="novedades"   stackId="vol" name="Novedades"   fill="hsl(var(--warning))" />
            <Bar dataKey="devueltos"   stackId="vol" name="Devueltos"   fill="hsl(var(--danger))" radius={[6, 6, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
});

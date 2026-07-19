import { memo, useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid } from 'recharts';
import { Truck } from 'lucide-react';
import { deriveDeliveryMaturity } from '@/lib/logisticsRates';
import type { CarrierStats } from '@/lib/logistics.types';
import {
  CHART_GRID_PROPS, CHART_BAR_CURSOR, SEMANTIC_COLORS,
} from './charts/chartTokens';

// Degradado vertical por serie: el segmento arranca pleno arriba y se apaga
// hacia la base, que es lo que le da volumen a la pila (una barra de color
// plano se lee como un bloque de cartón). Los ids llevan prefijo `heroVol`
// porque los ids de <defs> son GLOBALES al documento: sin prefijo, el donut
// de la tab Transportadoras pisaría estos degradados.
const BAR_GRADIENTS = [
  { id: 'heroVolSuccess', color: SEMANTIC_COLORS.success },
  { id: 'heroVolInfo',    color: SEMANTIC_COLORS.info },
  { id: 'heroVolWarning', color: SEMANTIC_COLORS.warning },
  { id: 'heroVolDanger',  color: SEMANTIC_COLORS.danger },
] as const;

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
  // Tasas MADURAS (÷ resueltos, sin rechazos) — las mismas que la tabla
  // Transportadoras. Antes el tooltip mostraba las crudas del RPC (÷ COUNT con
  // tránsito) y el mismo carrier tenía dos tasas distintas en la misma página.
  const m = deriveDeliveryMaturity(d.entregados, d.devueltos, d.total_pedidos, d.rechazados ?? 0);
  return (
    <div className="rounded-lg border border-border bg-card/95 backdrop-blur-sm p-3 shadow-2xl text-xs min-w-[220px]">
      <div className="mb-2 font-bold text-sm text-foreground">{d.transportadora}</div>
      <div className="space-y-1.5">
        <Row dot="bg-success" label="Entregados"  value={d.entregados}        extra={m.tasaEntregaMadura == null ? undefined : `${m.tasaEntregaMadura}% resueltos`}    valueClass="text-success" />
        <Row dot="bg-info"    label="En tránsito" value={d.en_transito ?? 0}                                              valueClass="text-info" />
        <Row dot="bg-warning" label="Novedades"   value={d.novedades ?? 0}                                                valueClass="text-warning" />
        <Row dot="bg-danger"  label="Devueltos"   value={d.devueltos}         extra={m.tasaDevolucionMadura == null ? undefined : `${m.tasaDevolucionMadura}% resueltos`} valueClass="text-danger" />
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
      <div className="rounded-2xl border border-border bg-card/40 p-5 shadow-card3d hairline-top h-full flex flex-col items-center justify-center text-center min-h-[280px]">
        <span className="w-9 h-9 rounded-xl border bg-muted/60 border-border text-muted-foreground flex items-center justify-center mb-3" aria-hidden="true">
          <Truck size={17} />
        </span>
        <p className="text-sm font-semibold text-foreground mb-1">Sin datos</p>
        <p className="text-xs text-muted-foreground max-w-xs">
          No hay transportadoras con suficientes pedidos en este rango.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border bg-card/40 p-5 shadow-card3d hairline-top h-full flex flex-col transition-colors duration-200 hover:border-border-strong">
      {/* Header con título + leyenda inline (oculta en mobile) */}
      <header className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Truck size={14} className="text-info" aria-hidden="true" />
            Volumen por transportadora
          </h2>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Top 8 — composición de envíos por estado actual
          </p>
        </div>
        <div className="hidden md:flex items-center gap-3 text-[10px] text-muted-foreground">
          {[
            { color: 'hsl(var(--success))', label: 'Entregados' },
            { color: 'hsl(var(--info))',    label: 'Tránsito' },
            { color: 'hsl(var(--warning))', label: 'Novedades' },
            { color: 'hsl(var(--danger))',  label: 'Devueltos' },
          ].map(it => (
            <span key={it.label} className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: it.color }} aria-hidden="true" />
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
            barCategoryGap="26%"
          >
            <defs>
              {BAR_GRADIENTS.map(g => (
                <linearGradient key={g.id} id={g.id} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%"   stopColor={g.color} stopOpacity={0.95} />
                  <stop offset="100%" stopColor={g.color} stopOpacity={0.5} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid {...CHART_GRID_PROPS} />
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
            <Tooltip content={<HeroTooltip />} cursor={CHART_BAR_CURSOR} />
            {/* En una pila SOLO el segmento de arriba lleva radio: si se lo ponés
                a los de abajo quedan muescas entre segmentos. El glow va solo en
                el protagonista (entregados) para que la vista aterrice ahí. */}
            <Bar dataKey="entregados"  stackId="vol" name="Entregados"  fill="url(#heroVolSuccess)" maxBarSize={54}
                 style={{ filter: `drop-shadow(0 0 6px ${SEMANTIC_COLORS.success})` }} />
            <Bar dataKey="en_transito" stackId="vol" name="En tránsito" fill="url(#heroVolInfo)"    maxBarSize={54} />
            <Bar dataKey="novedades"   stackId="vol" name="Novedades"   fill="url(#heroVolWarning)" maxBarSize={54} />
            <Bar dataKey="devueltos"   stackId="vol" name="Devueltos"   fill="url(#heroVolDanger)"  maxBarSize={54} radius={[6, 6, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
});

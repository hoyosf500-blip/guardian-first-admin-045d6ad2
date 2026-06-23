import { useNovedadesSeguimiento, SeguimientoRange, DimensionRow } from '@/hooks/useNovedadesSeguimiento';
import { CULPA_LABEL, CULPA_ORDER, Culpa } from '@/lib/novedadTaxonomy';
import { Stat } from '@/components/novedades/Stat';
import {
  CHART_TOOLTIP_STYLE, CHART_LEGEND_PROPS, SEMANTIC_COLORS,
} from '@/components/logistics/charts/chartTokens';
import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip as RTooltip, Legend,
} from 'recharts';
import {
  RefreshCw, AlertTriangle, Truck, MapPin, Target, Lightbulb, ShieldQuestion,
} from 'lucide-react';

const RANGES: { key: SeguimientoRange; label: string }[] = [
  { key: 'today', label: 'Hoy' },
  { key: '7d', label: '7 días' },
  { key: '30d', label: '30 días' },
];

const CULPA_COLOR: Record<Culpa, string> = {
  datos_nuestros: SEMANTIC_COLORS.danger,
  cliente: SEMANTIC_COLORS.warning,
  transportadora: SEMANTIC_COLORS.info,
  generica: SEMANTIC_COLORS.muted,
};

function pct(n: number | null): string {
  if (n == null) return '—';
  return `${Math.round(n * 100)}%`;
}

/** Etiqueta legible de categoría (snake_case → Texto). */
function catLabel(categoria: string): string {
  if (categoria === 'otro') return 'Sin clasificar';
  return categoria.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/** Tabla de dimensión problemática (transportadora / ciudad). */
function DimensionTable({
  title, icon, rows, fallbackLabel,
}: {
  title: string; icon: React.ReactNode; rows: DimensionRow[]; fallbackLabel: string;
}) {
  return (
    <section className="bg-card rounded-xl border border-border shadow-ds-xs overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border flex items-center gap-2">
        {icon}
        <h3 className="text-xs font-bold text-foreground uppercase tracking-wide">{title}</h3>
        <span className="text-[10px] text-muted-foreground">(mín. 3 pedidos · orden por % devolución)</span>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-6 text-center text-xs text-muted-foreground">{fallbackLabel}</div>
      ) : (
        <div className="divide-y divide-border">
          {rows.slice(0, 8).map((r) => {
            const danger = r.tasaDevolucion != null && r.tasaDevolucion >= 0.3;
            return (
              <div key={r.label} className="px-4 py-2 flex items-center gap-3 text-xs">
                <span className="flex-1 min-w-0 truncate text-foreground">{r.label}</span>
                <span className="text-muted-foreground tabular-nums" title="Pedidos con novedad">{r.total}</span>
                <span className={`w-12 text-right font-mono font-bold tabular-nums ${danger ? 'text-danger' : 'text-foreground'}`} title="% devolución (de las terminadas)">
                  {pct(r.tasaDevolucion)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default function NovedadesPuntosMejora() {
  const s = useNovedadesSeguimiento();

  // Agregación por culpa (suma de las filas categoría → culpa) para el donut + KPIs.
  const culpaTotals = CULPA_ORDER
    .map((culpa) => ({ culpa, count: s.porCulpa.filter((r) => r.culpa === culpa).reduce((a, r) => a + r.count, 0) }))
    .filter((c) => c.count > 0);
  const totalNov = s.porCulpa.reduce((a, r) => a + r.count, 0);
  const countOf = (c: Culpa) => culpaTotals.find((x) => x.culpa === c)?.count ?? 0;
  const pctDatos = totalNov ? countOf('datos_nuestros') / totalNov : null;
  const pctGenerica = totalNov ? countOf('generica') / totalNov : null;

  const donutData = culpaTotals.map((c) => ({ name: CULPA_LABEL[c.culpa], value: c.count, culpa: c.culpa }));
  const topCategorias = [...s.porCulpa].sort((a, b) => b.count - a.count).slice(0, 8);
  const maxCat = topCategorias[0]?.count || 1;

  return (
    <div className="space-y-5">
      {/* Range selector + refresh */}
      <div className="flex items-center justify-between gap-2">
        <div className="inline-flex rounded-lg border border-border bg-surface p-0.5">
          {RANGES.map((r) => (
            <button
              key={r.key}
              onClick={() => s.setRange(r.key)}
              className={`px-3 h-8 rounded-md text-xs font-semibold transition-colors ${
                s.range === r.key ? 'bg-accent/10 text-accent' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
        <button
          onClick={s.refresh}
          disabled={s.loading}
          className="h-8 px-3 rounded-lg border border-border bg-surface text-muted-foreground text-xs font-semibold flex items-center gap-1.5 hover:text-foreground hover:border-accent/30 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={12} className={s.loading ? 'animate-spin' : ''} />
          Recargar
        </button>
      </div>

      {/* KPIs hero: el lever accionable */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Stat icon={<AlertTriangle size={11} />} label="Novedades analizadas" value={totalNov} hint="gestionadas + en cola" />
        <Stat
          icon={<Target size={11} />} label="Culpa: datos nuestros" value={pct(pctDatos)}
          tone={pctDatos != null && pctDatos > 0.2 ? 'danger' : 'default'} hint="lo corregible por nosotros"
        />
        <Stat
          icon={<ShieldQuestion size={11} />} label="Texto genérico / sin info" value={pct(pctGenerica)}
          tone={pctGenerica != null && pctGenerica > 0.3 ? 'warning' : 'default'} hint="el carrier no dice el motivo"
        />
      </div>

      {/* Empty state */}
      {totalNov === 0 && !s.loading && (
        <div className="bg-card rounded-xl border border-border p-10 text-center text-sm text-muted-foreground shadow-ds-xs">
          No hay novedades en el período para analizar.
        </div>
      )}

      {totalNov > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {/* Donut de culpa */}
          <section className="bg-card rounded-xl border border-border shadow-ds-xs overflow-hidden">
            <div className="px-4 py-2.5 border-b border-border flex items-center gap-2">
              <Lightbulb size={13} className="text-warning" />
              <h3 className="text-xs font-bold text-foreground uppercase tracking-wide">¿De quién es la culpa?</h3>
            </div>
            <div className="p-3" style={{ height: 240 }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={donutData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={2}>
                    {donutData.map((d) => (
                      <Cell key={d.culpa} fill={CULPA_COLOR[d.culpa]} stroke="hsl(var(--card))" strokeWidth={2} />
                    ))}
                  </Pie>
                  <RTooltip
                    contentStyle={CHART_TOOLTIP_STYLE}
                    formatter={(value: number) => [`${value} (${pct(totalNov ? value / totalNov : null)})`, 'Novedades']}
                  />
                  <Legend {...CHART_LEGEND_PROPS} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </section>

          {/* Top categorías */}
          <section className="bg-card rounded-xl border border-border shadow-ds-xs overflow-hidden">
            <div className="px-4 py-2.5 border-b border-border flex items-center gap-2">
              <AlertTriangle size={13} className="text-muted-foreground" />
              <h3 className="text-xs font-bold text-foreground uppercase tracking-wide">Motivos más frecuentes</h3>
            </div>
            <div className="p-3 space-y-1.5">
              {topCategorias.map((r) => (
                <div key={`${r.culpa}-${r.categoria}`} className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: CULPA_COLOR[r.culpa] }} />
                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between items-center mb-0.5">
                      <span className="text-xs text-foreground truncate pr-2">{catLabel(r.categoria)}</span>
                      <span className="text-xs font-mono font-bold text-muted-foreground tabular-nums">
                        {r.count}
                        {r.pctDevolucion != null && (
                          <span className={`ml-1.5 ${r.pctDevolucion >= 0.3 ? 'text-danger' : 'text-muted-foreground/70'}`} title="% devolución de las terminadas">
                            · {pct(r.pctDevolucion)} dev
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${(r.count / maxCat) * 100}%`, background: CULPA_COLOR[r.culpa] }} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {/* Dimensiones problemáticas */}
      {totalNov > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <DimensionTable
            title="Transportadoras problemáticas" icon={<Truck size={13} className="text-info" />}
            rows={s.carriersProblematicos} fallbackLabel="Sin suficientes datos (mín. 3 pedidos por transportadora)."
          />
          <DimensionTable
            title="Ciudades problemáticas" icon={<MapPin size={13} className="text-info" />}
            rows={s.ciudadesProblematicas} fallbackLabel="Sin suficientes datos (mín. 3 pedidos por ciudad)."
          />
        </div>
      )}

      <p className="text-[10px] text-muted-foreground text-center">
        Análisis sobre novedades gestionadas + en cola. El cruce completo de devoluciones con la confirmación
        (causa raíz) llega en la próxima fase.
      </p>
    </div>
  );
}

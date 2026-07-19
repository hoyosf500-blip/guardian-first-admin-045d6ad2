import { useNovedadesSeguimiento, SeguimientoRange, DimensionRow } from '@/hooks/useNovedadesSeguimiento';
import { CULPA_LABEL, CULPA_ORDER, Culpa } from '@/lib/novedadTaxonomy';
import { Stat } from '@/components/novedades/Stat';
import {
  NovCard, SwatchLegend, MetricBar, RangePills, EmptyCard,
} from '@/components/novedades/NovedadesChrome';
import { fadeUp, barGlow } from '@/components/novedades/chromeTokens';
import {
  CHART_TOOLTIP_STYLE, SEMANTIC_COLORS,
} from '@/components/logistics/charts/chartTokens';
import { motion } from 'framer-motion';
import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip as RTooltip,
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

/** Tabla de dimensión problemática (transportadora / ciudad).
 *  La barra representa la MISMA tasa que ya muestra la columna de la derecha;
 *  cuando la tasa es null («—», sin pedidos terminados) la pista queda vacía en
 *  vez de dibujar un 0% que se leería como "medimos y dio cero". */
function DimensionTable({
  title, icon, iconClass, rows, fallbackLabel,
}: {
  title: string; icon: typeof Truck; iconClass: string; rows: DimensionRow[]; fallbackLabel: string;
}) {
  return (
    <NovCard title={title} icon={icon} iconClass={iconClass} note="(mín. 3 pedidos · orden por % devolución)">
      {rows.length === 0 ? (
        <p className="flex-1 flex items-center justify-center py-6 text-center text-xs text-muted-foreground">{fallbackLabel}</p>
      ) : (
        <ul className="space-y-1">
          {rows.slice(0, 8).map((r) => {
            const danger = r.tasaDevolucion != null && r.tasaDevolucion >= 0.3;
            const color = danger ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.info;
            return (
              <MetricBar
                key={r.label}
                label={r.label}
                color={color}
                pct={r.tasaDevolucion == null ? null : r.tasaDevolucion * 100}
                right={
                  <span className="flex items-baseline gap-2">
                    <span className="text-muted-foreground" title="Pedidos con novedad">{r.total}</span>
                    <span
                      className={`w-12 text-right font-bold ${danger ? 'text-danger' : 'text-foreground'}`}
                      title="% devolución (de las terminadas)"
                    >
                      {pct(r.tasaDevolucion)}
                    </span>
                  </span>
                }
              />
            );
          })}
        </ul>
      )}
    </NovCard>
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
  // Porción dominante del donut, para la cifra del centro. Misma proporción que
  // ya muestra el tooltip de esa porción — no es una métrica nueva.
  const topCulpa = donutData.reduce<typeof donutData[number] | null>(
    (best, d) => (best == null || d.value > best.value ? d : best), null,
  );

  return (
    <div className="space-y-5">
      {/* Range selector + refresh */}
      <motion.div {...fadeUp(0)} className="flex items-center justify-between gap-2 flex-wrap">
        <RangePills items={RANGES} value={s.range} onChange={s.setRange} ariaLabel="Período del análisis" />
        <button
          type="button"
          onClick={s.refresh}
          disabled={s.loading}
          className="px-3 py-2 rounded-xl bg-card/40 border border-border text-muted-foreground text-sm font-medium flex items-center gap-1.5 hover:text-foreground hover:border-border-strong transition-colors duration-200 disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <RefreshCw size={13} className={s.loading ? 'animate-spin' : ''} aria-hidden="true" />
          Recargar
        </button>
      </motion.div>

      {/* KPIs hero: el lever accionable */}
      <motion.div {...fadeUp(0.05)} className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Stat icon={<AlertTriangle size={17} />} label="Novedades analizadas" value={totalNov} hint="gestionadas + en cola" />
        <Stat
          icon={<Target size={17} />} label="Culpa: datos nuestros" value={pct(pctDatos)}
          tone={pctDatos != null && pctDatos > 0.2 ? 'danger' : 'default'} hint="lo corregible por nosotros"
        />
        <Stat
          icon={<ShieldQuestion size={17} />} label="Texto genérico / sin info" value={pct(pctGenerica)}
          tone={pctGenerica != null && pctGenerica > 0.3 ? 'warning' : 'default'} hint="el carrier no dice el motivo"
        />
      </motion.div>

      {/* Empty state */}
      {totalNov === 0 && !s.loading && (
        <motion.div {...fadeUp(0.1)}>
          <EmptyCard msg="No hay novedades en el período para analizar." />
        </motion.div>
      )}

      {totalNov > 0 && (
        <motion.div {...fadeUp(0.12)} className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {/* Donut de culpa */}
          <NovCard
            title="¿De quién es la culpa?"
            icon={Lightbulb}
            iconClass="text-warning"
            right={<SwatchLegend items={donutData.map(d => ({ color: CULPA_COLOR[d.culpa], label: d.name }))} />}
          >
            <div className="relative h-[260px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  {/* Relleno con degradado, igual que las barras del área: el
                      sector va del color pleno en el borde exterior al mismo
                      color al 55% en el interior. Es el ÚNICO gráfico de verdad
                      de /novedades y era el que seguía con fill plano. */}
                  <defs>
                    {donutData.map((d) => (
                      <linearGradient key={d.culpa} id={`novCulpa-${d.culpa}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={CULPA_COLOR[d.culpa]} stopOpacity={1} />
                        <stop offset="100%" stopColor={CULPA_COLOR[d.culpa]} stopOpacity={0.55} />
                      </linearGradient>
                    ))}
                  </defs>
                  <Pie
                    data={donutData} dataKey="value" nameKey="name"
                    innerRadius={62} outerRadius={102} paddingAngle={2} cornerRadius={6}
                    stroke="hsl(var(--card))" strokeWidth={2}
                  >
                    {donutData.map((d) => (
                      <Cell key={d.culpa} fill={`url(#novCulpa-${d.culpa})`} style={barGlow(CULPA_COLOR[d.culpa])} />
                    ))}
                  </Pie>
                  <RTooltip
                    contentStyle={CHART_TOOLTIP_STYLE}
                    formatter={(value: number) => [`${value} (${pct(totalNov ? value / totalNov : null)})`, 'Novedades']}
                  />
                </PieChart>
              </ResponsiveContainer>
              {topCulpa && (
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                  <div className="text-[38px] font-bold text-foreground font-mono tabular-nums leading-none num-glow-accent">
                    {pct(totalNov ? topCulpa.value / totalNov : null)}
                  </div>
                  {/* max-w atado al agujero REAL del donut: innerRadius=62 →
                      124px de diámetro, y a la altura donde cae este rótulo la
                      cuerda mide ~108px. Con 150px el truncate no disparaba
                      nunca y "Sin info / genérica" se montaba sobre el anillo. */}
                  <div className="text-[11px] text-muted-foreground font-medium mt-2 truncate max-w-[100px] text-center" title={topCulpa.name}>
                    {topCulpa.name}
                  </div>
                </div>
              )}
            </div>
          </NovCard>

          {/* Top categorías */}
          <NovCard title="Motivos más frecuentes" icon={AlertTriangle} iconClass="text-muted-foreground">
            <ul className="space-y-1">
              {topCategorias.map((r, i) => (
                <MetricBar
                  key={`${r.culpa}-${r.categoria}`}
                  rank={i + 1}
                  label={catLabel(r.categoria)}
                  color={CULPA_COLOR[r.culpa]}
                  dotTitle={CULPA_LABEL[r.culpa]}
                  pct={(r.count / maxCat) * 100}
                  right={
                    <span className="font-bold text-muted-foreground">
                      {r.count}
                      {r.pctDevolucion != null && (
                        <span className={`ml-1.5 ${r.pctDevolucion >= 0.3 ? 'text-danger' : 'text-muted-foreground/70'}`} title="% devolución de las terminadas">
                          · {pct(r.pctDevolucion)} dev
                        </span>
                      )}
                    </span>
                  }
                />
              ))}
            </ul>
          </NovCard>
        </motion.div>
      )}

      {/* Dimensiones problemáticas */}
      {totalNov > 0 && (
        <motion.div {...fadeUp(0.18)} className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <DimensionTable
            title="Transportadoras problemáticas" icon={Truck} iconClass="text-info"
            rows={s.carriersProblematicos} fallbackLabel="Sin suficientes datos (mín. 3 pedidos por transportadora)."
          />
          <DimensionTable
            title="Ciudades problemáticas" icon={MapPin} iconClass="text-info"
            rows={s.ciudadesProblematicas} fallbackLabel="Sin suficientes datos (mín. 3 pedidos por ciudad)."
          />
        </motion.div>
      )}

      <p className="text-[10px] text-muted-foreground text-center">
        Análisis sobre novedades gestionadas + en cola. El cruce completo de devoluciones con la confirmación
        (causa raíz) llega en la próxima fase.
      </p>
    </div>
  );
}

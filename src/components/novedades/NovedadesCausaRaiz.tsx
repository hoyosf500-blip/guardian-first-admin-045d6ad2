import { useNovedadRootCause } from '@/hooks/useNovedadRootCause';
import { SeguimientoRange } from '@/hooks/useNovedadesSeguimiento';
import { CULPA_LABEL, Culpa } from '@/lib/novedadTaxonomy';
import { EvitableReason } from '@/lib/novedadRootCause';
import { Stat } from '@/components/novedades/Stat';
import {
  NovCard, MetricBar, RangePills, EmptyCard,
} from '@/components/novedades/NovedadesChrome';
import { fadeUp } from '@/components/novedades/chromeTokens';
import { formatCOP } from '@/lib/utils';
import { SEMANTIC_COLORS } from '@/components/logistics/charts/chartTokens';
import { motion } from 'framer-motion';
import {
  RefreshCw, TriangleAlert, Target, DollarSign, Users, Lock, Wrench, ServerCrash,
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

const REASON_META: Record<EvitableReason, { label: string; color: string }> = {
  semaforo: { label: 'Semáforo amarillo/rojo', color: SEMANTIC_COLORS.danger },
  direccion: { label: 'Dirección dudosa (rural / sin validar)', color: SEMANTIC_COLORS.warning },
  pickup: { label: 'Pickup en oficina no retirado', color: SEMANTIC_COLORS.info },
};
const REASON_ORDER: EvitableReason[] = ['semaforo', 'direccion', 'pickup'];

function pct(n: number | null): string {
  if (n == null) return '—';
  return `${Math.round(n * 100)}%`;
}

function catLabel(categoria: string): string {
  if (categoria === 'otro') return 'Sin clasificar';
  return categoria.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/** Carteles de estado no-OK (permiso, migración pendiente, error). Molde de
 *  banner del DS: chip de ícono teñido por tono + copy centrado. */
function StatusCard({
  icon, title, body, tone,
}: {
  icon: React.ReactNode; title: string; body: string; tone: 'info' | 'warning' | 'danger';
}) {
  const chip = {
    info: 'bg-info/14 border-info/30 text-info glow-info',
    warning: 'bg-warning/14 border-warning/30 text-warning glow-warning',
    danger: 'bg-danger/14 border-danger/30 text-danger glow-danger',
  }[tone];
  return (
    <div className="hairline-top bg-card/40 rounded-2xl border border-border p-10 flex flex-col items-center gap-3 text-center shadow-card3d">
      <div className={`w-12 h-12 rounded-2xl border flex items-center justify-center ${chip}`} aria-hidden="true">{icon}</div>
      <h3 className="text-sm font-bold text-foreground">{title}</h3>
      <p className="text-xs text-muted-foreground max-w-md">{body}</p>
    </div>
  );
}

export default function NovedadesCausaRaiz() {
  const s = useNovedadRootCause();
  const { summary } = s;
  const maxReason = Math.max(1, ...REASON_ORDER.map((r) => summary.porReason[r]));
  const topCategorias = summary.porCategoria.slice(0, 8);
  const maxCat = topCategorias[0]?.devoluciones || 1;

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

      {/* Estados no-OK */}
      {s.status === 'forbidden' && (
        <StatusCard tone="info" icon={<Lock size={22} />} title="Solo para encargados"
          body="Este análisis incluye nombres de operadoras y montos, así que solo lo ven dueño/supervisor de la tienda." />
      )}
      {s.status === 'not_ready' && (
        <StatusCard tone="warning" icon={<Wrench size={22} />} title="Módulo pendiente de activar"
          body="Falta aplicar la migración `novedades_root_cause` en la base. En cuanto se aplique, este panel se llena solo (no hay que tocar nada más)." />
      )}
      {s.status === 'error' && (
        <StatusCard tone="danger" icon={<ServerCrash size={22} />} title="No se pudo cargar"
          body="Hubo un error consultando las devoluciones. Probá recargar; si persiste, avisá." />
      )}

      {s.status === 'ok' && (
        <>
          {/* KPIs hero */}
          <motion.div {...fadeUp(0.05)} className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat icon={<TriangleAlert size={17} />} label="Devoluciones" value={summary.totalDevoluciones} hint="en el período" />
            <Stat
              icon={<Target size={17} />} label="% evitables" value={pct(summary.pctEvitable)}
              tone={summary.pctEvitable != null && summary.pctEvitable >= 0.3 ? 'danger' : 'default'}
              hint="prevenibles de nuestro lado"
            />
            <Stat
              icon={<DollarSign size={17} />} label="$ perdido evitable" value={formatCOP(summary.valorPerdidoEvitable)}
              tone={summary.valorPerdidoEvitable > 0 ? 'danger' : 'default'} hint={`de ${formatCOP(summary.valorPerdidoTotal)} total`}
            />
            <Stat icon={<Users size={17} />} label="Con confirmador" value={summary.conConfirmador}
              hint={`${summary.sinConfirmador} carga directa`} />
          </motion.div>

          {summary.totalDevoluciones === 0 && !s.loading && (
            <motion.div {...fadeUp(0.1)}>
              <EmptyCard msg="No hay devoluciones en el período para analizar." />
            </motion.div>
          )}

          {summary.totalDevoluciones > 0 && (
            <>
              {/* Motivos por los que era evitable */}
              <motion.div {...fadeUp(0.12)}>
                <NovCard
                  title="¿Por qué era evitable?" icon={Target} iconClass="text-danger"
                  note="(una devolución puede tener varios motivos)"
                >
                  <ul className="space-y-1">
                    {REASON_ORDER.map((r) => {
                      const count = summary.porReason[r];
                      const meta = REASON_META[r];
                      return (
                        <MetricBar
                          key={r}
                          label={meta.label}
                          color={meta.color}
                          pct={(count / maxReason) * 100}
                          right={<span className="font-bold text-muted-foreground">{count}</span>}
                        />
                      );
                    })}
                  </ul>
                </NovCard>
              </motion.div>

              <motion.div {...fadeUp(0.18)} className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                {/* Ranking de operadoras confirmadoras — la barra es el % evitable
                    de esa operadora; cuando no hay tasa medida («—») la pista
                    queda vacía en vez de fingir un 0%. */}
                <NovCard title="Quién confirmó las devoluciones" icon={Users} iconClass="text-info">
                  <div className="px-3 pb-2 flex items-center gap-2 hud-label border-b border-border/50">
                    {/* Espaciador del ancho del punto de color de MetricBar
                        (w-2.5) — el gap-2 aporta los 8px restantes. Sin él el
                        rótulo "Operadora" queda 18px a la izquierda del nombre
                        que encabeza. */}
                    <span className="w-2.5 shrink-0" aria-hidden="true" />
                    <span className="flex-1">Operadora</span>
                    <span className="w-10 text-right">Devol.</span>
                    <span className="w-12 text-right">Evit.</span>
                    <span className="w-12 text-right">% evit</span>
                  </div>
                  <ul className="space-y-1 mt-2">
                    {summary.porOperadora.slice(0, 10).map((o) => {
                      const danger = o.pctEvitable != null && o.pctEvitable >= 0.5 && o.devoluciones >= 2;
                      return (
                        <MetricBar
                          key={o.operatorId ?? '__none__'}
                          label={o.name}
                          labelClassName={o.operatorId ? 'text-foreground' : 'text-muted-foreground italic'}
                          color={danger ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.info}
                          pct={o.pctEvitable == null ? null : o.pctEvitable * 100}
                          right={
                            <span className="flex items-baseline gap-2">
                              <span className="w-10 text-right text-muted-foreground">{o.devoluciones}</span>
                              <span className="w-12 text-right text-foreground">{o.evitables}</span>
                              <span className={`w-12 text-right font-bold ${danger ? 'text-danger' : 'text-muted-foreground'}`}>
                                {pct(o.pctEvitable)}
                              </span>
                            </span>
                          }
                        />
                      );
                    })}
                  </ul>
                </NovCard>

                {/* Categorías de novedad que terminan en devolución */}
                <NovCard title="Novedades que más se devuelven" icon={TriangleAlert} iconClass="text-muted-foreground">
                  <ul className="space-y-1">
                    {topCategorias.map((c, i) => (
                      <MetricBar
                        key={`${c.culpa}-${c.categoria}`}
                        rank={i + 1}
                        label={catLabel(c.categoria)}
                        color={CULPA_COLOR[c.culpa]}
                        dotTitle={CULPA_LABEL[c.culpa]}
                        pct={(c.devoluciones / maxCat) * 100}
                        right={
                          <span className="font-bold text-muted-foreground">
                            {c.devoluciones}
                            {c.evitables > 0 && <span className="ml-1.5 text-danger">· {c.evitables} evit</span>}
                          </span>
                        }
                      />
                    ))}
                  </ul>
                </NovCard>
              </motion.div>

              {s.partial && (
                <p className="text-[10px] text-warning text-center">
                  Resultado parcial: se muestran las 5.000 devoluciones de mayor valor del período. Acotá el rango para ver todo.
                </p>
              )}
            </>
          )}

          <p className="text-[10px] text-muted-foreground text-center">
            Confirmador = última operadora que marcó «confirmar» en el pedido (match exacto por order_id). Las devoluciones sin
            registro de confirmación caen en «carga directa». Un pedido sin semáforo (anterior al validador) no cuenta como
            evitable. Es correlación, no causalidad.
          </p>
        </>
      )}
    </div>
  );
}

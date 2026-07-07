import { useNovedadRootCause } from '@/hooks/useNovedadRootCause';
import { SeguimientoRange } from '@/hooks/useNovedadesSeguimiento';
import { CULPA_LABEL, Culpa } from '@/lib/novedadTaxonomy';
import { EvitableReason } from '@/lib/novedadRootCause';
import { Stat } from '@/components/novedades/Stat';
import { formatCOP } from '@/lib/utils';
import { SEMANTIC_COLORS } from '@/components/logistics/charts/chartTokens';
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

/** Carteles de estado no-OK (permiso, migración pendiente, error). */
function StatusCard({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="bg-card rounded-xl border border-border p-10 flex flex-col items-center gap-3 text-center shadow-ds-xs">
      <div className="w-12 h-12 rounded-xl bg-muted/40 flex items-center justify-center text-muted-foreground">{icon}</div>
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

      {/* Estados no-OK */}
      {s.status === 'forbidden' && (
        <StatusCard icon={<Lock size={22} />} title="Solo para encargados"
          body="Este análisis incluye nombres de operadoras y montos, así que solo lo ven dueño/supervisor de la tienda." />
      )}
      {s.status === 'not_ready' && (
        <StatusCard icon={<Wrench size={22} />} title="Módulo pendiente de activar"
          body="Falta aplicar la migración `novedades_root_cause` en la base. En cuanto se aplique, este panel se llena solo (no hay que tocar nada más)." />
      )}
      {s.status === 'error' && (
        <StatusCard icon={<ServerCrash size={22} />} title="No se pudo cargar"
          body="Hubo un error consultando las devoluciones. Probá recargar; si persiste, avisá." />
      )}

      {s.status === 'ok' && (
        <>
          {/* KPIs hero */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat icon={<TriangleAlert size={11} />} label="Devoluciones" value={summary.totalDevoluciones} hint="en el período" />
            <Stat
              icon={<Target size={11} />} label="% evitables" value={pct(summary.pctEvitable)}
              tone={summary.pctEvitable != null && summary.pctEvitable >= 0.3 ? 'danger' : 'default'}
              hint="prevenibles de nuestro lado"
            />
            <Stat
              icon={<DollarSign size={11} />} label="$ perdido evitable" value={formatCOP(summary.valorPerdidoEvitable)}
              tone={summary.valorPerdidoEvitable > 0 ? 'danger' : 'default'} hint={`de ${formatCOP(summary.valorPerdidoTotal)} total`}
            />
            <Stat icon={<Users size={11} />} label="Con confirmador" value={summary.conConfirmador}
              hint={`${summary.sinConfirmador} carga directa`} />
          </div>

          {summary.totalDevoluciones === 0 && !s.loading && (
            <div className="bg-card rounded-xl border border-border p-10 text-center text-sm text-muted-foreground shadow-ds-xs">
              No hay devoluciones en el período para analizar.
            </div>
          )}

          {summary.totalDevoluciones > 0 && (
            <>
              {/* Motivos por los que era evitable */}
              <section className="bg-card rounded-xl border border-border shadow-ds-xs overflow-hidden">
                <div className="px-4 py-2.5 border-b border-border flex items-center gap-2">
                  <Target size={13} className="text-danger" />
                  <h3 className="text-xs font-bold text-foreground uppercase tracking-wide">¿Por qué era evitable?</h3>
                  <span className="text-[10px] text-muted-foreground">(una devolución puede tener varios motivos)</span>
                </div>
                <div className="p-3 space-y-2">
                  {REASON_ORDER.map((r) => {
                    const count = summary.porReason[r];
                    const meta = REASON_META[r];
                    return (
                      <div key={r} className="flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: meta.color }} />
                        <div className="flex-1 min-w-0">
                          <div className="flex justify-between items-center mb-0.5">
                            <span className="text-xs text-foreground truncate pr-2">{meta.label}</span>
                            <span className="text-xs font-mono font-bold text-muted-foreground tabular-nums">{count}</span>
                          </div>
                          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                            <div className="h-full rounded-full" style={{ width: `${(count / maxReason) * 100}%`, background: meta.color }} />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                {/* Ranking de operadoras confirmadoras */}
                <section className="bg-card rounded-xl border border-border shadow-ds-xs overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-border flex items-center gap-2">
                    <Users size={13} className="text-info" />
                    <h3 className="text-xs font-bold text-foreground uppercase tracking-wide">Quién confirmó las devoluciones</h3>
                  </div>
                  <div className="px-4 py-1.5 flex items-center gap-3 text-[10px] uppercase tracking-wide text-muted-foreground border-b border-border/50">
                    <span className="flex-1">Operadora</span>
                    <span className="w-10 text-right">Devol.</span>
                    <span className="w-12 text-right">Evit.</span>
                    <span className="w-12 text-right">% evit</span>
                  </div>
                  <div className="divide-y divide-border">
                    {summary.porOperadora.slice(0, 10).map((o) => {
                      const danger = o.pctEvitable != null && o.pctEvitable >= 0.5 && o.devoluciones >= 2;
                      return (
                        <div key={o.operatorId ?? '__none__'} className="px-4 py-2 flex items-center gap-3 text-xs">
                          <span className={`flex-1 min-w-0 truncate ${o.operatorId ? 'text-foreground' : 'text-muted-foreground italic'}`}>{o.name}</span>
                          <span className="w-10 text-right text-muted-foreground tabular-nums">{o.devoluciones}</span>
                          <span className="w-12 text-right font-mono tabular-nums text-foreground">{o.evitables}</span>
                          <span className={`w-12 text-right font-mono font-bold tabular-nums ${danger ? 'text-danger' : 'text-muted-foreground'}`}>{pct(o.pctEvitable)}</span>
                        </div>
                      );
                    })}
                  </div>
                </section>

                {/* Categorías de novedad que terminan en devolución */}
                <section className="bg-card rounded-xl border border-border shadow-ds-xs overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-border flex items-center gap-2">
                    <TriangleAlert size={13} className="text-muted-foreground" />
                    <h3 className="text-xs font-bold text-foreground uppercase tracking-wide">Novedades que más se devuelven</h3>
                  </div>
                  <div className="p-3 space-y-1.5">
                    {topCategorias.map((c) => (
                      <div key={`${c.culpa}-${c.categoria}`} className="flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: CULPA_COLOR[c.culpa] }} title={CULPA_LABEL[c.culpa]} />
                        <div className="flex-1 min-w-0">
                          <div className="flex justify-between items-center mb-0.5">
                            <span className="text-xs text-foreground truncate pr-2">{catLabel(c.categoria)}</span>
                            <span className="text-xs font-mono font-bold text-muted-foreground tabular-nums">
                              {c.devoluciones}
                              {c.evitables > 0 && <span className="ml-1.5 text-danger">· {c.evitables} evit</span>}
                            </span>
                          </div>
                          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                            <div className="h-full rounded-full" style={{ width: `${(c.devoluciones / maxCat) * 100}%`, background: CULPA_COLOR[c.culpa] }} />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              </div>

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

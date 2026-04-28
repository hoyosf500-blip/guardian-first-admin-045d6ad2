import { memo, useMemo, useState } from 'react';
import { useLogisticsTimeline } from '@/hooks/useLogisticsTimeline';
import { formatCOP } from '@/lib/utils';
import { Search, ChevronLeft, ChevronRight, ListChecks, Truck, MapPin, X } from 'lucide-react';
import type {
  LogisticsSummary,
  LogisticsFilters,
  CarrierStats,
} from '@/lib/logistics.types';

interface Props {
  summary: LogisticsSummary | null;
  range: LogisticsFilters;
  carriers: CarrierStats[];
}

function stateTone(estado: string): 'success' | 'info' | 'warning' | 'danger' | 'neutral' {
  const e = (estado || '').toUpperCase();
  if (e === 'ENTREGADO') return 'success';
  if (e === 'CANCELADO') return 'neutral';
  if (e.includes('DEVOLUCION') || e === 'RECHAZADO') return 'danger';
  if (e === 'NOVEDAD' || e === 'INTENTO DE ENTREGA') return 'warning';
  if (e === 'PENDIENTE' || e === 'PENDIENTE CONFIRMACION') return 'warning';
  return 'info';
}

const STATE_PRESETS: { label: string; estados: string[] | null; tone: ReturnType<typeof stateTone> }[] = [
  { label: 'Todos',         estados: null, tone: 'neutral' },
  { label: 'Entregado',     estados: ['ENTREGADO'], tone: 'success' },
  { label: 'En tránsito',   estados: [
    'EN TRANSPORTE', 'EN DESPACHO', 'EN TRASLADO NACIONAL',
    'EN TERMINAL ORIGEN', 'EN TERMINAL DESTINO',
    'EN REPARTO', 'EN DISTRIBUCION', 'EN REEXPEDICION',
    'TELEMERCADEO', 'REENVIO', 'REENVÍO',
    'EN BODEGA TRANSPORTADORA', 'ADMITIDA',
    'EN BODEGA DROPI', 'RECOGIDO POR DROPI',
  ], tone: 'info' },
  { label: 'Devolución',    estados: ['DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO'], tone: 'danger' },
  { label: 'Pendiente',     estados: ['PENDIENTE', 'PENDIENTE CONFIRMACION'], tone: 'warning' },
  { label: 'Cancelado',     estados: ['CANCELADO'], tone: 'neutral' },
];

const PAGE_SIZE = 50;

export default memo(function TrazabilidadView({ summary, range, carriers }: Props) {
  const [statePreset, setStatePreset] = useState(0);
  const [transportadora, setTransportadora] = useState<string>('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);

  const filters = useMemo(() => ({
    estados: STATE_PRESETS[statePreset]?.estados ?? null,
    transportadora,
    search,
    page,
    pageSize: PAGE_SIZE,
  }), [statePreset, transportadora, search, page]);

  const timeline = useLogisticsTimeline(range, {
    estados: filters.estados ?? undefined,
    transportadora: filters.transportadora,
    search: filters.search,
    page: filters.page,
    pageSize: filters.pageSize,
  });

  if (!summary) {
    return (
      <div className="space-y-4">
        {[0, 1, 2].map(i => (
          <div key={i} className="rounded-xl border border-border bg-card p-5 skeleton-shimmer min-h-[140px]" />
        ))}
      </div>
    );
  }

  const entregados   = summary.entregados ?? 0;
  const enTransito   = summary.en_transito ?? 0;
  const devueltos    = summary.devueltos ?? 0;
  const totalDespachadas = entregados + enTransito + devueltos;

  const pendSinDespachar = summary.pendientes_sin_despachar ?? 0;
  const pendPorConfirmar = summary.pendientes_por_confirmar ?? 0;
  const totalPendientes  = pendSinDespachar + pendPorConfirmar;

  const valorEntregado    = summary.valor_entregado ?? 0;
  const valorEnTransito   = summary.valor_en_transito ?? 0;
  const valorPerdido      = summary.valor_perdido ?? 0;
  const valorDespachadas  = valorEntregado + valorEnTransito + valorPerdido;

  const valorPendientes   = summary.valor_pendientes ?? 0;
  const cancelados        = summary.cancelados ?? 0;
  const valorCancelado    = summary.valor_cancelado ?? 0;

  // Total absoluto = activos + cancelados (denominador para "tasas reales")
  const totalConCancelados = (summary.total_pedidos ?? 0) + cancelados;
  const despachadasMasPendientes = totalDespachadas + totalPendientes;

  const tasaDespacho = totalConCancelados > 0
    ? (totalDespachadas / totalConCancelados) * 100
    : 0;
  const tasaCancelacion = totalConCancelados > 0
    ? (cancelados / totalConCancelados) * 100
    : 0;
  const tasaDespachoReal = despachadasMasPendientes > 0
    ? (totalDespachadas / despachadasMasPendientes) * 100
    : 0;

  const pct = (n: number) => totalDespachadas > 0 ? (n / totalDespachadas) * 100 : 0;
  const pctPend = (n: number) => totalPendientes > 0 ? (n / totalPendientes) * 100 : 0;
  // Distribución del valor pendiente proporcional al # de pedidos de cada bucket
  // (no tenemos breakdown de valor por sub-tipo en el RPC).
  const valorPendDistr = (n: number) => totalPendientes > 0
    ? valorPendientes * (n / totalPendientes)
    : 0;

  return (
    <div className="space-y-6">
      {/* SECCIÓN 1: Estado de guías despachadas */}
      <section className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="px-5 py-4 border-b border-border/60">
          <div className="flex items-center gap-2">
            <Truck size={14} className="text-info" aria-hidden="true" strokeWidth={2.25} />
            <h2 className="text-sm font-bold text-foreground uppercase tracking-[0.08em]">
              Estado de guías despachadas
            </h2>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/60 bg-muted/20">
                <th className="text-left px-5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Estado</th>
                <th className="text-right px-5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Ventas</th>
                <th className="text-right px-5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Guías</th>
                <th className="text-right px-5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">%</th>
              </tr>
            </thead>
            <tbody>
              <Row tone="success" label="Entregado"     ventas={valorEntregado}  guias={entregados}    pct={pct(entregados)} />
              <Row tone="info"    label="En Tránsito"   ventas={valorEnTransito} guias={enTransito}    pct={pct(enTransito)} />
              <Row tone="danger"  label="Devoluciones"  ventas={valorPerdido}    guias={devueltos}     pct={pct(devueltos)} />
              <tr className="border-t border-border/60 bg-muted/20">
                <td className="px-5 py-2.5 text-foreground font-bold text-sm">Total despachadas</td>
                <td className="px-5 py-2.5 text-right font-mono font-bold tabular-nums text-foreground">{formatCOP(valorDespachadas)}</td>
                <td className="px-5 py-2.5 text-right font-mono font-bold tabular-nums text-foreground">{totalDespachadas.toLocaleString('es-CO')}</td>
                <td className="px-5 py-2.5 text-right font-mono font-bold tabular-nums text-foreground">100.0%</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* SECCIÓN 2: Tasa Despacho + Cancelación */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <RateCard
          label="Tasa de Despacho"
          pct={tasaDespacho}
          subline={`${totalDespachadas.toLocaleString('es-CO')} de ${totalConCancelados.toLocaleString('es-CO')} pedidos`}
          tone="success"
        />
        <RateCard
          label="Tasa de Cancelación"
          pct={tasaCancelacion}
          subline={`${cancelados.toLocaleString('es-CO')} de ${totalConCancelados.toLocaleString('es-CO')} pedidos`}
          tone="danger"
        />
      </div>

      {/* SECCIÓN 3: Pedidos pendientes */}
      <section className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="px-5 py-4 border-b border-border/60">
          <div className="flex items-center gap-2">
            <ListChecks size={14} className="text-warning" aria-hidden="true" strokeWidth={2.25} />
            <h2 className="text-sm font-bold text-foreground uppercase tracking-[0.08em]">
              Pedidos pendientes
            </h2>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/60 bg-muted/20">
                <th className="text-left px-5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Tipo</th>
                <th className="text-right px-5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Ventas</th>
                <th className="text-right px-5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Pedidos</th>
                <th className="text-right px-5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">% sobre total</th>
              </tr>
            </thead>
            <tbody>
              <Row
                tone="warning"
                label="Pendientes (sin despachar)"
                ventas={valorPendDistr(pendSinDespachar)}
                guias={pendSinDespachar}
                pct={pctPend(pendSinDespachar)}
              />
              <Row
                tone="info"
                label="Pendientes por confirmar"
                ventas={valorPendDistr(pendPorConfirmar)}
                guias={pendPorConfirmar}
                pct={pctPend(pendPorConfirmar)}
              />
              <tr className="border-t border-border/60 bg-muted/20">
                <td className="px-5 py-2.5 text-foreground font-bold text-sm">Total pendientes</td>
                <td className="px-5 py-2.5 text-right font-mono font-bold tabular-nums text-foreground">{formatCOP(valorPendientes)}</td>
                <td className="px-5 py-2.5 text-right font-mono font-bold tabular-nums text-foreground">{totalPendientes.toLocaleString('es-CO')}</td>
                <td className="px-5 py-2.5 text-right font-mono font-bold tabular-nums text-foreground">
                  {totalConCancelados > 0 ? ((totalPendientes / totalConCancelados) * 100).toFixed(1) : '0.0'}%
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* SECCIÓN 4: 4 KPIs operativos */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <MiniKpi
          label="Despachado + Pendientes"
          value={despachadasMasPendientes.toLocaleString('es-CO')}
          subline={formatCOP(valorDespachadas + valorPendientes)}
          tone="info"
        />
        <MiniKpi
          label="Tasa despacho real"
          value={`${tasaDespachoReal.toFixed(1)}%`}
          subline="(despachadas / activas)"
          tone="success"
        />
        <MiniKpi
          label="Tasa cancelación real"
          value={`${tasaCancelacion.toFixed(1)}%`}
          subline={`${cancelados.toLocaleString('es-CO')} cancelados`}
          tone="danger"
        />
        <MiniKpi
          label="Pedidos cancelados"
          value={cancelados.toLocaleString('es-CO')}
          subline={formatCOP(valorCancelado)}
          tone="neutral"
        />
      </div>

      {/* SECCIÓN 5: Timeline de guías */}
      <section className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="px-5 py-4 border-b border-border/60 space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <MapPin size={14} className="text-info" aria-hidden="true" strokeWidth={2.25} />
              <h2 className="text-sm font-bold text-foreground uppercase tracking-[0.08em]">
                Timeline de guías
              </h2>
              {timeline.data && (
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  · {timeline.data.totalCount.toLocaleString('es-CO')} guías
                </span>
              )}
            </div>
          </div>

          {/* Filter chips por estado */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {STATE_PRESETS.map((preset, idx) => {
              const active = idx === statePreset;
              const toneClass = active
                ? `pill-${preset.tone === 'neutral' ? 'neutral' : preset.tone}`
                : 'pill-neutral hover:bg-muted/50';
              return (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => { setStatePreset(idx); setPage(0); }}
                  className={`pill text-[11px] transition-colors ${toneClass} ${active ? 'ring-1 ring-border-strong' : ''}`}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>

          {/* Filtros: transportadora + search */}
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={transportadora}
              onChange={e => { setTransportadora(e.target.value); setPage(0); }}
              className="h-8 rounded-lg border border-border bg-card px-2.5 text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              aria-label="Filtrar por transportadora"
            >
              <option value="">Todas las transportadoras</option>
              {carriers
                .filter(c => c.transportadora)
                .map(c => (
                  <option key={c.transportadora} value={c.transportadora}>
                    {c.transportadora}
                  </option>
                ))}
            </select>

            <div className="relative flex-1 min-w-[180px] max-w-[280px]">
              <Search
                size={13}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
                aria-hidden="true"
              />
              <input
                type="text"
                value={search}
                onChange={e => { setSearch(e.target.value); setPage(0); }}
                placeholder="Buscar guía…"
                className="h-8 w-full rounded-lg border border-border bg-card pl-8 pr-7 text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                aria-label="Buscar guía o ID externo"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => { setSearch(''); setPage(0); }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label="Limpiar búsqueda"
                >
                  <X size={12} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Tabla del timeline */}
        <div className="overflow-x-auto">
          {timeline.isError ? (
            <div className="px-5 py-10 text-center">
              <p className="text-sm text-danger">Error cargando timeline</p>
              <p className="text-xs text-muted-foreground mt-1">{timeline.error?.message}</p>
            </div>
          ) : timeline.isLoading && !timeline.data ? (
            <div className="p-3 space-y-2">
              {[0, 1, 2, 3, 4].map(i => (
                <div key={i} className="h-9 rounded-md skeleton-shimmer" />
              ))}
            </div>
          ) : timeline.data && timeline.data.entries.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-muted-foreground">
              No hay guías que matcheen los filtros.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/60 bg-muted/20">
                  <th className="text-left px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Fecha</th>
                  <th className="text-left px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Guía</th>
                  <th className="text-left px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Estado</th>
                  <th className="text-left px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Transportadora</th>
                  <th className="text-left px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground hidden md:table-cell">Ciudad</th>
                  <th className="text-right px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Valor</th>
                </tr>
              </thead>
              <tbody>
                {timeline.data?.entries.map(e => (
                  <tr key={e.id} className="border-b border-border/40 hover:bg-muted/10 transition-colors">
                    <td className="px-4 py-2 text-xs font-mono tabular-nums text-muted-foreground whitespace-nowrap">
                      {e.fecha}
                    </td>
                    <td className="px-4 py-2 text-xs font-mono tabular-nums text-foreground">
                      {e.guia || <span className="text-muted-foreground/60">—</span>}
                    </td>
                    <td className="px-4 py-2">
                      <span className={`pill pill-${stateTone(e.estado)} text-[10px]`}>
                        {e.estado || '—'}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-xs text-foreground truncate max-w-[160px]" title={e.transportadora}>
                      {e.transportadora || <span className="text-muted-foreground/60">—</span>}
                    </td>
                    <td className="px-4 py-2 text-xs text-muted-foreground truncate max-w-[140px] hidden md:table-cell" title={e.ciudad}>
                      {e.ciudad || '—'}
                    </td>
                    <td className="px-4 py-2 text-right text-xs font-mono tabular-nums text-foreground">
                      {formatCOP(e.valor)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Paginación */}
        {timeline.data && timeline.data.totalCount > PAGE_SIZE && (
          <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-border/60 bg-muted/10">
            <span className="text-xs text-muted-foreground tabular-nums">
              {(page * PAGE_SIZE + 1).toLocaleString('es-CO')}
              {' - '}
              {Math.min((page + 1) * PAGE_SIZE, timeline.data.totalCount).toLocaleString('es-CO')}
              {' de '}
              {timeline.data.totalCount.toLocaleString('es-CO')}
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-card hover:bg-muted/40 disabled:opacity-40 disabled:cursor-not-allowed"
                aria-label="Página anterior"
              >
                <ChevronLeft size={14} aria-hidden="true" />
              </button>
              <span className="text-xs tabular-nums text-muted-foreground px-2">
                Pág. {page + 1} / {Math.ceil(timeline.data.totalCount / PAGE_SIZE)}
              </span>
              <button
                type="button"
                onClick={() => setPage(p => p + 1)}
                disabled={(page + 1) * PAGE_SIZE >= timeline.data.totalCount}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-card hover:bg-muted/40 disabled:opacity-40 disabled:cursor-not-allowed"
                aria-label="Página siguiente"
              >
                <ChevronRight size={14} aria-hidden="true" />
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
});

interface RowProps {
  tone: 'success' | 'info' | 'warning' | 'danger';
  label: string;
  ventas: number;
  guias: number;
  pct: number;
}
function Row({ tone, label, ventas, guias, pct }: RowProps) {
  const labelColor = {
    success: 'text-success',
    info:    'text-info',
    warning: 'text-warning',
    danger:  'text-danger',
  }[tone];
  return (
    <tr className="border-b border-border/40 last:border-b-0">
      <td className={`px-5 py-2.5 font-semibold ${labelColor}`}>{label}</td>
      <td className="px-5 py-2.5 text-right font-mono tabular-nums text-foreground">{formatCOP(ventas)}</td>
      <td className="px-5 py-2.5 text-right font-mono tabular-nums text-foreground">{guias.toLocaleString('es-CO')}</td>
      <td className="px-5 py-2.5 text-right font-mono tabular-nums text-muted-foreground">{pct.toFixed(1)}%</td>
    </tr>
  );
}

interface RateCardProps {
  label: string;
  pct: number;
  subline: string;
  tone: 'success' | 'danger';
}
function RateCard({ label, pct, subline, tone }: RateCardProps) {
  const styles = {
    success: { bg: 'bg-success/8',  border: 'border-success/30', text: 'text-success' },
    danger:  { bg: 'bg-danger/8',   border: 'border-danger/30',  text: 'text-danger' },
  }[tone];
  return (
    <article className={`rounded-xl border ${styles.border} ${styles.bg} p-5`}>
      <div className="text-[11px] uppercase tracking-[0.08em] font-semibold text-muted-foreground">
        {label}
      </div>
      <div className={`font-mono font-bold tabular-nums leading-none mt-2 text-4xl ${styles.text}`}>
        {pct.toFixed(1)}%
      </div>
      <div className="text-xs text-muted-foreground mt-2 tabular-nums">
        {subline}
      </div>
    </article>
  );
}

interface MiniKpiProps {
  label: string;
  value: string;
  subline: string;
  tone: 'info' | 'success' | 'danger' | 'neutral';
}
function MiniKpi({ label, value, subline, tone }: MiniKpiProps) {
  const valueColor = {
    info:    'text-info',
    success: 'text-success',
    danger:  'text-danger',
    neutral: 'text-foreground',
  }[tone];
  return (
    <article className="rounded-xl border border-border bg-card p-4 transition-colors hover:border-border-strong">
      <div className="text-[10px] uppercase tracking-[0.08em] font-semibold text-muted-foreground truncate">
        {label}
      </div>
      <div className={`font-mono font-bold tabular-nums leading-none mt-1.5 text-2xl ${valueColor}`}>
        {value}
      </div>
      <div className="text-[11px] text-muted-foreground mt-1.5 tabular-nums truncate">
        {subline}
      </div>
    </article>
  );
}

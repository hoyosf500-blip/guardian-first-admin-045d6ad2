import { memo, useMemo, useState } from 'react';
import { useLogisticsTimeline } from '@/hooks/useLogisticsTimeline';
import { formatCOP } from '@/lib/utils';
import {
  Search, ChevronLeft, ChevronRight, ListChecks, Truck, MapPin, X,
  PackageCheck, PackageX, Inbox, AlertTriangle,
} from 'lucide-react';
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
  if (e === 'NOVEDAD' || e === 'INTENTO DE ENTREGA' || e === 'NOVEDAD SOLUCIONADA') return 'warning';
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
  { label: 'Novedades',     estados: ['NOVEDAD', 'INTENTO DE ENTREGA', 'NOVEDAD SOLUCIONADA'], tone: 'warning' },
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
          <div key={i} className="rounded-2xl border border-border bg-card/40 p-5 shadow-card3d hairline-top skeleton-shimmer min-h-[140px]" />
        ))}
      </div>
    );
  }

  // ── Detección de migration desactualizada ────────────────────
  // Si los campos v2/v3 vienen undefined, la RPC en DB es vieja.
  // Mostramos warning para que el admin sepa que los números son
  // parciales (no por bug del frontend).
  const migrationStale =
    summary.cancelados === undefined ||
    summary.novedades === undefined;

  // ── Buckets ──────────────────────────────────────────────────
  const entregados   = summary.entregados ?? 0;
  const enTransito   = summary.en_transito ?? 0;
  const devueltos    = summary.devueltos ?? 0;
  const novedades    = summary.novedades ?? 0;

  const pendSinDespachar = summary.pendientes_sin_despachar ?? 0;
  const pendPorConfirmar = summary.pendientes_por_confirmar ?? 0;
  const totalPendientes  = pendSinDespachar + pendPorConfirmar;

  const cancelados = summary.cancelados ?? 0;

  // Despachadas reales = todo lo que ya salió de la operadora hacia el carrier.
  // Incluye novedades porque son guías ya en manos del transportador.
  const despachadasReales = entregados + enTransito + devueltos + novedades;

  // Total entrados al sistema = activos (no cancelados) + cancelados.
  const totalActivos = summary.total_pedidos ?? 0;
  const totalEntrados = totalActivos + cancelados;

  // Pre-despacho = lo que ya se confirmó pero AÚN no salió al carrier: guía
  // generada, CONFIRMADO, PREPARANDO, ALISTAMIENTO, POR RECOLECTAR (EC). Es
  // inventario operativo NORMAL, no un estado "sin clasificar" ni un bug de datos.
  // logistics_summary no tiene un bucket propio para esto, así que sale por resta:
  // activos − despachadas − pendientes. (Antes se rotulaba "sin clasificar" y
  // culpaba a una migration inexistente — auditoría 2026-07-03.)
  const enPreparacion = Math.max(0, totalActivos - despachadasReales - totalPendientes);

  // ── Valores ─────────────────────────────────────────────────
  const valorEntregado    = summary.valor_entregado    ?? 0;
  const valorEnTransito   = summary.valor_en_transito  ?? 0;
  const valorPerdido      = summary.valor_perdido      ?? 0;
  const valorNovedades    = summary.valor_novedades    ?? 0;
  const valorDespachadas  = valorEntregado + valorEnTransito + valorPerdido + valorNovedades;
  const valorPendientes   = summary.valor_pendientes   ?? 0;
  const valorCancelado    = summary.valor_cancelado    ?? 0;
  const valorTotal        = valorDespachadas + valorPendientes + valorCancelado;

  // ── Tasas ───────────────────────────────────────────────────
  // Tasa de despacho = despachadas ÷ GENERADOS SIN CANCELAR — la MISMA fórmula
  // que "Tasa de despachos" del Simulador (unitEconomics.tasaDespachos). Antes
  // esta dividía por total+cancelados y las dos tabs mostraban hasta 11 puntos
  // de diferencia para la misma pregunta (auditoría 2026-07-07).
  // `null` = denominador 0, o sea NO hay con qué calcular la tasa. Antes caían a
  // 0 y la RateCard pintaba "0.0%" en verde (despacho) y "0.0%" en rojo
  // (cancelación) para un rango SIN pedidos: un veredicto con color sobre un
  // dato que no existe. Un 0 medido (hay pedidos y ninguno despachó) sigue
  // siendo 0 y sigue pintándose con su tono (auditoría 2026-07-18).
  const tasaDespacho = totalActivos > 0
    ? (despachadasReales / totalActivos) * 100
    : null;
  const tasaCancelacion = totalEntrados > 0
    ? (cancelados / totalEntrados) * 100
    : null;

  // % por fila (sobre total despachadas)
  const pct = (n: number) => despachadasReales > 0 ? (n / despachadasReales) * 100 : 0;
  // % por fila de pendientes: sobre el TOTAL ENTRADO — el header de la columna
  // dice "% sobre total" y la fila Total ya dividía por totalEntrados; las filas
  // dividían por totalPendientes → tres denominadores en una columna que no
  // cerraba consigo misma (auditoría 2026-07-07).
  const pctPend = (n: number) => totalEntrados > 0 ? (n / totalEntrados) * 100 : 0;
  // NO hay valor por sub-tipo de pendiente: logistics_summary devuelve UN solo
  // valor_pendientes agregado. Antes se repartía proporcional a la cantidad
  // (valorPendientes * n / totalPendientes) y se pintaba igual que la fila TOTAL
  // real — un número que no medía nada: era la cantidad de la columna de al lado
  // reescalada, y asumía que el ticket promedio de "por confirmar" es igual al de
  // "sin despachar" (falso: lo caro es justo lo que la asesora no logra cerrar).
  // Ahora esas celdas van "—" y la plata se muestra SOLO en el total, que sí es
  // medido (auditoría 2026-07-18).

  return (
    <div className="space-y-6">

      {migrationStale && (
        <div className="rounded-2xl border border-warning/40 bg-warning/8 p-4 shadow-card3d flex items-start gap-3">
          <AlertTriangle size={16} className="text-warning shrink-0 mt-0.5" aria-hidden="true" strokeWidth={2.25} />
          <div className="text-sm">
            <p className="font-semibold text-foreground">Datos parciales — falta aplicar migration</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              La DB todavía corre la versión vieja del RPC <code className="font-mono text-[11px]">logistics_summary</code>.
              Cancelados, pendientes y novedades no se están contando.
              {' '}Aplicá <code className="font-mono text-[11px]">supabase db push</code> en el repo
              o esperá a que Lovable Cloud reanude el deploy.
            </p>
          </div>
        </div>
      )}

      {/* HERO — los 3 números que pidió el user, grandes y claros */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <HeroKpi
          label="Total entrados"
          value={totalEntrados.toLocaleString('es-CO')}
          subline={formatCOP(valorTotal)}
          tone="info"
          icon={Inbox}
        />
        <HeroKpi
          label="Despachados reales"
          value={despachadasReales.toLocaleString('es-CO')}
          subline={tasaDespacho === null
            ? 'Sin pedidos generados en el rango'
            : `${tasaDespacho.toFixed(1)}% de generados sin cancelar`}
          tone="success"
          icon={PackageCheck}
        />
        <HeroKpi
          label="Cancelados"
          value={cancelados.toLocaleString('es-CO')}
          subline={tasaCancelacion === null
            ? 'Sin pedidos en el rango'
            : `${tasaCancelacion.toFixed(1)}% del total · ${formatCOP(valorCancelado)}`}
          tone="danger"
          icon={PackageX}
        />
      </div>

      {/* SECCIÓN 1: Estado de guías despachadas */}
      <section className="rounded-2xl border border-border bg-card/40 overflow-hidden shadow-card3d hairline-top transition-colors hover:border-border-strong">
        <div className="px-5 py-4 border-b border-border/60">
          <div className="flex items-center gap-2">
            <Truck size={14} className="text-info" aria-hidden="true" strokeWidth={2.25} />
            <h2 className="text-sm font-bold text-foreground uppercase tracking-[0.08em]">
              Estado de guías despachadas
            </h2>
            <span className="text-[11px] text-muted-foreground tabular-nums">
              · {despachadasReales.toLocaleString('es-CO')} guías en ruta
            </span>
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
              <Row tone="success" label="Entregado"     ventas={valorEntregado}  guias={entregados} pct={pct(entregados)} />
              <Row tone="info"    label="En Tránsito"   ventas={valorEnTransito} guias={enTransito} pct={pct(enTransito)} />
              <Row tone="warning" label="Novedades"     ventas={valorNovedades}  guias={novedades}  pct={pct(novedades)} />
              <Row tone="danger"  label="Devoluciones"  ventas={valorPerdido}    guias={devueltos}  pct={pct(devueltos)} />
              <tr className="border-t border-border/60 bg-muted/20">
                <td className="px-5 py-2.5 text-foreground font-bold text-sm">Total despachadas</td>
                <td className="px-5 py-2.5 text-right font-mono font-bold tabular-nums text-foreground">{formatCOP(valorDespachadas)}</td>
                <td className="px-5 py-2.5 text-right font-mono font-bold tabular-nums text-foreground">{despachadasReales.toLocaleString('es-CO')}</td>
                <td className="px-5 py-2.5 text-right font-mono font-bold tabular-nums text-foreground">100.0%</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* SECCIÓN 2: Tasa Despacho + Cancelación (cards grandes) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <RateCard
          label="Tasa de Despacho"
          pct={tasaDespacho}
          subline={`${despachadasReales.toLocaleString('es-CO')} de ${totalActivos.toLocaleString('es-CO')} generados sin cancelar`}
          tone="success"
        />
        <RateCard
          label="Tasa de Cancelación"
          pct={tasaCancelacion}
          subline={`${cancelados.toLocaleString('es-CO')} de ${totalEntrados.toLocaleString('es-CO')} pedidos`}
          tone="danger"
        />
      </div>

      {/* SECCIÓN 3: Pedidos pendientes */}
      <section className="rounded-2xl border border-border bg-card/40 overflow-hidden shadow-card3d hairline-top transition-colors hover:border-border-strong">
        <div className="px-5 py-4 border-b border-border/60">
          <div className="flex items-center gap-2">
            <ListChecks size={14} className="text-warning" aria-hidden="true" strokeWidth={2.25} />
            <h2 className="text-sm font-bold text-foreground uppercase tracking-[0.08em]">
              Pedidos pendientes
            </h2>
            <span className="text-[11px] text-muted-foreground tabular-nums">
              · {totalPendientes.toLocaleString('es-CO')} sin salir todavía
            </span>
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
                ventas={null}
                guias={pendSinDespachar}
                pct={pctPend(pendSinDespachar)}
              />
              <Row
                tone="info"
                label="Pendientes por confirmar"
                ventas={null}
                guias={pendPorConfirmar}
                pct={pctPend(pendPorConfirmar)}
              />
              <tr className="border-t border-border/60 bg-muted/20">
                <td className="px-5 py-2.5 text-foreground font-bold text-sm">Total pendientes</td>
                <td className="px-5 py-2.5 text-right font-mono font-bold tabular-nums text-foreground">{formatCOP(valorPendientes)}</td>
                <td className="px-5 py-2.5 text-right font-mono font-bold tabular-nums text-foreground">{totalPendientes.toLocaleString('es-CO')}</td>
                <td className="px-5 py-2.5 text-right font-mono font-bold tabular-nums text-foreground">
                  {totalEntrados > 0
                    ? `${((totalPendientes / totalEntrados) * 100).toFixed(1)}%`
                    : <span className="text-muted-foreground/60" title="No hay pedidos en el rango: no hay sobre qué calcular el porcentaje">—</span>}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="px-5 py-2.5 border-t border-border/60 text-[11px] text-muted-foreground">
          El valor pendiente llega como un solo total: no hay desglose medido por tipo, por eso esas celdas van en “—”.
          {migrationStale
            ? ' La fila Total tampoco es confiable mientras falte aplicar la migration (ver aviso arriba).'
            : ' La plata de la fila Total sí es real.'}
        </p>
      </section>

      {enPreparacion > 0 && (
        <div className="rounded-2xl border border-border/60 bg-muted/10 px-4 py-2.5 shadow-card3d text-xs text-muted-foreground">
          <span className="font-mono tabular-nums text-foreground">{enPreparacion.toLocaleString('es-CO')}</span>
          {' '}pedidos en preparación (confirmados con guía generada / en alistamiento, todavía no salieron al transportador). Es inventario normal previo al despacho.
        </div>
      )}

      {/* SECCIÓN 4: Timeline de guías */}
      <section className="rounded-2xl border border-border bg-card/40 overflow-hidden shadow-card3d hairline-top transition-colors hover:border-border-strong">
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

interface HeroKpiProps {
  label: string;
  value: string;
  subline: string;
  tone: 'info' | 'success' | 'danger';
  icon: typeof Inbox;
}
function HeroKpi({ label, value, subline, tone, icon: Icon }: HeroKpiProps) {
  const styles = {
    info:    { card: 'border-info/30 bg-gradient-to-br from-info/8 via-info/3 to-transparent',
               text: 'text-info', iconBg: 'bg-info/15 border-info/40' },
    success: { card: 'border-success/30 bg-gradient-to-br from-success/8 via-success/3 to-transparent',
               text: 'text-success', iconBg: 'bg-success/15 border-success/40' },
    danger:  { card: 'border-danger/30 bg-gradient-to-br from-danger/8 via-danger/3 to-transparent',
               text: 'text-danger', iconBg: 'bg-danger/15 border-danger/40' },
  }[tone];
  return (
    <article className={`rounded-2xl border-2 ${styles.card} p-5 shadow-card3d flex items-start gap-4`}>
      <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border ${styles.iconBg}`}>
        <Icon size={18} className={styles.text} aria-hidden="true" strokeWidth={2.25} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] uppercase tracking-[0.12em] font-bold text-muted-foreground">
          {label}
        </div>
        <div className={`font-extrabold tabular-nums leading-none mt-1.5 text-3xl ${styles.text}`}>
          {value}
        </div>
        <div className="text-[11px] text-muted-foreground mt-2 tabular-nums truncate">
          {subline}
        </div>
      </div>
    </article>
  );
}

interface RowProps {
  tone: 'success' | 'info' | 'warning' | 'danger';
  label: string;
  /** `null` = la fuente no reporta el valor de esta fila. Se muestra "—", nunca $0. */
  ventas: number | null;
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
      <td className="px-5 py-2.5 text-right font-mono tabular-nums text-foreground">
        {ventas === null
          ? <span className="text-muted-foreground/60" title="La fuente no desglosa el valor por tipo de pendiente">—</span>
          : formatCOP(ventas)}
      </td>
      <td className="px-5 py-2.5 text-right font-mono tabular-nums text-foreground">{guias.toLocaleString('es-CO')}</td>
      <td className="px-5 py-2.5 text-right font-mono tabular-nums text-muted-foreground">{pct.toFixed(1)}%</td>
    </tr>
  );
}

interface RateCardProps {
  label: string;
  /** `null` = denominador 0: no hay con qué calcular. Se muestra "—" en tono
   *  neutro, nunca "0.0%" con color de veredicto. Un 0 medido es `0`, no `null`. */
  pct: number | null;
  subline: string;
  tone: 'success' | 'danger';
}
function RateCard({ label, pct, subline, tone }: RateCardProps) {
  const noData = pct === null;
  const styles = noData
    ? 'border-border bg-muted/10'
    : {
        success: 'border-success/30 bg-gradient-to-br from-success/8 via-success/3 to-transparent text-success',
        danger:  'border-danger/30 bg-gradient-to-br from-danger/8 via-danger/3 to-transparent text-danger',
      }[tone];
  const textColor = noData
    ? 'text-muted-foreground'
    : tone === 'success' ? 'text-success' : 'text-danger';
  return (
    <article className={`rounded-2xl border-2 ${styles} p-5 shadow-card3d`}>
      <div className="text-[10px] uppercase tracking-[0.12em] font-bold text-muted-foreground">
        {label}
      </div>
      <div
        className={`font-extrabold tabular-nums leading-none mt-2 text-4xl ${textColor}`}
        title={noData ? 'No hay pedidos en el rango: no hay con qué calcular esta tasa' : undefined}
      >
        {noData ? '—' : `${pct.toFixed(1)}%`}
      </div>
      <div className="text-[11px] text-muted-foreground mt-2 tabular-nums">
        {subline}
      </div>
    </article>
  );
}

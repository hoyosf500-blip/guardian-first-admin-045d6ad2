import { memo, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { useLogisticsTimeline } from '@/hooks/useLogisticsTimeline';
import { formatCOP } from '@/lib/utils';
import {
  Search, ChevronLeft, ChevronRight, ListChecks, Truck, MapPin, X,
  PackageCheck, PackageX, Inbox, AlertTriangle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
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

const fadeUp = (delay = 0) => ({
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35, delay, ease: 'easeOut' as const },
});

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
    <div className="space-y-5">

      {migrationStale && (
        // Banner del lenguaje: barra lateral w-1 + chip de 36px con glow +
        // metadatos en mono. Mismo molde que el banner de frescura del Dashboard.
        <motion.div
          {...fadeUp(0)}
          className="relative flex flex-col sm:flex-row sm:items-center gap-3 rounded-2xl border border-warning/30 bg-warning/10 px-4 pl-5 py-3 shadow-card3d"
        >
          <span className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-warning" aria-hidden="true" />
          <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 bg-warning/20 glow-warning">
            <AlertTriangle size={17} className="text-warning" aria-hidden="true" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-semibold text-foreground">Datos parciales — falta aplicar migration</div>
            <div className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
              La DB todavía corre la versión vieja del RPC <code className="font-mono text-[10px]">logistics_summary</code>.
              Cancelados, pendientes y novedades no se están contando.
              {' '}Aplicá <code className="font-mono text-[10px]">supabase db push</code> en el repo
              o esperá a que Lovable Cloud reanude el deploy.
            </div>
          </div>
        </motion.div>
      )}

      {/* HERO — los 3 números que pidió el user, grandes y claros */}
      <motion.div {...fadeUp(0.05)} className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
      </motion.div>

      {/* SECCIÓN 1: Estado de guías despachadas */}
      <motion.section
        {...fadeUp(0.12)}
        className="rounded-2xl border border-border bg-card/40 overflow-hidden shadow-card3d hairline-top transition-colors duration-200 hover:border-border-strong"
      >
        <div className="px-5 py-3.5 border-b border-border/60">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Truck size={14} className="text-info" aria-hidden="true" />
              Estado de guías despachadas
            </h2>
            <span className="text-[10px] text-muted-foreground font-mono tabular-nums">
              · {despachadasReales.toLocaleString('es-CO')} guías en ruta
            </span>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left px-5 py-2.5 hud-label font-normal">Estado</th>
                <th className="text-right px-3 py-2.5 hud-label font-normal">Ventas</th>
                <th className="text-right px-3 py-2.5 hud-label font-normal">Guías</th>
                <th className="text-right px-5 py-2.5 hud-label font-normal">%</th>
              </tr>
            </thead>
            <tbody>
              <Row tone="success" label="Entregado"     ventas={valorEntregado}  guias={entregados} pct={pct(entregados)} />
              <Row tone="info"    label="En Tránsito"   ventas={valorEnTransito} guias={enTransito} pct={pct(enTransito)} />
              <Row tone="warning" label="Novedades"     ventas={valorNovedades}  guias={novedades}  pct={pct(novedades)} />
              <Row tone="danger"  label="Devoluciones"  ventas={valorPerdido}    guias={devueltos}  pct={pct(devueltos)} />
              <tr className="border-t border-border bg-muted/20">
                <td className="px-5 py-2.5 text-foreground font-bold">Total despachadas</td>
                <td className="px-3 py-2.5 text-right font-mono font-bold tabular-nums text-foreground">{formatCOP(valorDespachadas)}</td>
                <td className="px-3 py-2.5 text-right font-mono font-bold tabular-nums text-foreground">{despachadasReales.toLocaleString('es-CO')}</td>
                <td className="px-5 py-2.5 text-right font-mono font-bold tabular-nums text-foreground">100.0%</td>
              </tr>
            </tbody>
          </table>
        </div>
      </motion.section>

      {/* SECCIÓN 2: Tasa Despacho + Cancelación (cards grandes) */}
      <motion.div {...fadeUp(0.14)} className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
      </motion.div>

      {/* SECCIÓN 3: Pedidos pendientes */}
      <motion.section
        {...fadeUp(0.15)}
        className="rounded-2xl border border-border bg-card/40 overflow-hidden shadow-card3d hairline-top transition-colors duration-200 hover:border-border-strong"
      >
        <div className="px-5 py-3.5 border-b border-border/60">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <ListChecks size={14} className="text-warning" aria-hidden="true" />
              Pedidos pendientes
            </h2>
            <span className="text-[10px] text-muted-foreground font-mono tabular-nums">
              · {totalPendientes.toLocaleString('es-CO')} sin salir todavía
            </span>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left px-5 py-2.5 hud-label font-normal">Tipo</th>
                <th className="text-right px-3 py-2.5 hud-label font-normal">Ventas</th>
                <th className="text-right px-3 py-2.5 hud-label font-normal">Pedidos</th>
                <th className="text-right px-5 py-2.5 hud-label font-normal">% sobre total</th>
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
              <tr className="border-t border-border bg-muted/20">
                <td className="px-5 py-2.5 text-foreground font-bold">Total pendientes</td>
                <td className="px-3 py-2.5 text-right font-mono font-bold tabular-nums text-foreground">{formatCOP(valorPendientes)}</td>
                <td className="px-3 py-2.5 text-right font-mono font-bold tabular-nums text-foreground">{totalPendientes.toLocaleString('es-CO')}</td>
                <td className="px-5 py-2.5 text-right font-mono font-bold tabular-nums text-foreground">
                  {totalEntrados > 0
                    ? `${((totalPendientes / totalEntrados) * 100).toFixed(1)}%`
                    : <span className="text-muted-foreground/60" title="No hay pedidos en el rango: no hay sobre qué calcular el porcentaje">—</span>}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="px-5 py-2.5 border-t border-border/60 text-[10px] text-muted-foreground leading-relaxed">
          El valor pendiente llega como un solo total: no hay desglose medido por tipo, por eso esas celdas van en “—”.
          {migrationStale
            ? ' La fila Total tampoco es confiable mientras falte aplicar la migration (ver aviso arriba).'
            : ' La plata de la fila Total sí es real.'}
        </p>
      </motion.section>

      {enPreparacion > 0 && (
        <div className="rounded-2xl border border-border/60 bg-muted/10 px-4 py-2.5 shadow-card3d text-[11px] text-muted-foreground leading-relaxed">
          <span className="font-mono tabular-nums text-foreground">{enPreparacion.toLocaleString('es-CO')}</span>
          {' '}pedidos en preparación (confirmados con guía generada / en alistamiento, todavía no salieron al transportador). Es inventario normal previo al despacho.
        </div>
      )}

      {/* SECCIÓN 4: Timeline de guías */}
      <motion.section
        {...fadeUp(0.18)}
        className="rounded-2xl border border-border bg-card/40 overflow-hidden shadow-card3d hairline-top transition-colors duration-200 hover:border-border-strong"
      >
        <div className="px-5 py-3.5 border-b border-border/60 space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <MapPin size={14} className="text-info" aria-hidden="true" />
                Timeline de guías
              </h2>
              {timeline.data && (
                <span className="text-[10px] text-muted-foreground font-mono tabular-nums">
                  · {timeline.data.totalCount.toLocaleString('es-CO')} guías
                </span>
              )}
            </div>
          </div>

          {/* Filter chips por estado — molde de toggle segmentado del Dashboard:
              contenedor rounded-xl p-[3px], activo con borde + shadow-glow3d, e
              inactivos con `border border-transparent` para que no salte nada. */}
          <div className="inline-flex flex-wrap gap-[2px] p-[3px] rounded-xl bg-card/40 border border-border">
            {STATE_PRESETS.map((preset, idx) => {
              const active = idx === statePreset;
              const activeTone = {
                neutral: 'bg-muted/70 border-border-strong text-foreground',
                success: 'bg-success/16 border-success/40 text-success',
                info:    'bg-info/16 border-info/40 text-info',
                warning: 'bg-warning/16 border-warning/40 text-warning',
                danger:  'bg-danger/16 border-danger/40 text-danger',
              }[preset.tone];
              return (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => { setStatePreset(idx); setPage(0); }}
                  className={`px-3 py-1.5 rounded-[9px] text-[11px] transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ${
                    active
                      ? `font-semibold border shadow-glow3d ${activeTone}`
                      : 'font-medium border border-transparent text-muted-foreground hover:text-foreground hover:bg-muted'
                  }`}
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
              className="h-9 rounded-xl border border-border bg-card/40 px-2.5 text-xs cursor-pointer transition-colors duration-200 hover:border-border-strong focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
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
                className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
                aria-hidden="true"
              />
              <input
                type="text"
                value={search}
                onChange={e => { setSearch(e.target.value); setPage(0); }}
                placeholder="Buscar guía…"
                className="h-9 w-full rounded-xl border border-border bg-card/40 pl-8 pr-7 text-xs transition-colors duration-200 hover:border-border-strong focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
                aria-label="Buscar guía o ID externo"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => { setSearch(''); setPage(0); }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none rounded"
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
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left px-5 py-2.5 hud-label font-normal">Fecha</th>
                  <th className="text-left px-3 py-2.5 hud-label font-normal">Guía</th>
                  <th className="text-left px-3 py-2.5 hud-label font-normal">Estado</th>
                  <th className="text-left px-3 py-2.5 hud-label font-normal">Transportadora</th>
                  <th className="text-left px-3 py-2.5 hud-label font-normal hidden md:table-cell">Ciudad</th>
                  <th className="text-right px-5 py-2.5 hud-label font-normal">Valor</th>
                </tr>
              </thead>
              <tbody>
                {timeline.data?.entries.map(e => (
                  <tr key={e.id} className="border-b border-border/50 last:border-0 hover:bg-card/60 transition-colors duration-200">
                    <td className="px-5 py-2.5 font-mono tabular-nums text-muted-foreground whitespace-nowrap">
                      {e.fecha}
                    </td>
                    <td className="px-3 py-2.5 font-mono tabular-nums text-foreground">
                      {e.guia || <span className="text-muted-foreground/60">—</span>}
                    </td>
                    <td className="px-3 py-2.5">
                      {/* OJO: `e.estado` es dato de Dropi — nunca .hud-label acá
                          (mayusculizaría un texto que no escribimos nosotros). */}
                      <span className={`pill pill-${stateTone(e.estado)} text-[10px]`}>
                        {e.estado || '—'}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-foreground truncate max-w-[160px]" title={e.transportadora}>
                      {e.transportadora || <span className="text-muted-foreground/60">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground truncate max-w-[140px] hidden md:table-cell" title={e.ciudad}>
                      {e.ciudad || '—'}
                    </td>
                    <td className="px-5 py-2.5 text-right font-mono tabular-nums text-foreground">
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
            <span className="text-[10px] text-muted-foreground font-mono tabular-nums">
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
                className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-card/40 text-muted-foreground hover:text-foreground hover:border-border-strong transition-colors duration-200 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
                aria-label="Página anterior"
              >
                <ChevronLeft size={14} aria-hidden="true" />
              </button>
              <span className="text-[10px] font-mono tabular-nums text-muted-foreground px-2">
                Pág. {page + 1} / {Math.ceil(timeline.data.totalCount / PAGE_SIZE)}
              </span>
              <button
                type="button"
                onClick={() => setPage(p => p + 1)}
                disabled={(page + 1) * PAGE_SIZE >= timeline.data.totalCount}
                className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-card/40 text-muted-foreground hover:text-foreground hover:border-border-strong transition-colors duration-200 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
                aria-label="Página siguiente"
              >
                <ChevronRight size={14} aria-hidden="true" />
              </button>
            </div>
          </div>
        )}
      </motion.section>
    </div>
  );
});

interface HeroKpiProps {
  label: string;
  value: string;
  subline: string;
  tone: 'info' | 'success' | 'danger';
  icon: LucideIcon;
}
/**
 * KPI con la anatomía canónica del Dashboard: chip de ícono de 36px con glow
 * arriba, cifra grande debajo y el rótulo en .hud-label BAJO la cifra.
 *
 * No usa <StatTile> porque su <CountUp> imprime `value.toFixed(0)` — sin
 * separador de miles. Acá la cifra ya viene formateada en es-CO ("1.234") y
 * cambiarla por "1234" sería empeorar la lectura de un número real.
 */
function HeroKpi({ label, value, subline, tone, icon: Icon }: HeroKpiProps) {
  const styles = {
    info:    { chip: 'bg-info/14 border-info/30 text-info glow-info',          text: 'text-info' },
    success: { chip: 'bg-success/14 border-success/30 text-success glow-success', text: 'text-success' },
    danger:  { chip: 'bg-danger/14 border-danger/30 text-danger glow-danger',  text: 'text-danger' },
  }[tone];
  return (
    <article className="rounded-2xl border border-border bg-card/40 p-4 shadow-card3d hairline-top h-full flex flex-col transition-colors duration-200 hover:border-border-strong">
      <span className={`w-9 h-9 rounded-xl border flex items-center justify-center flex-shrink-0 ${styles.chip}`}>
        <Icon size={17} aria-hidden="true" />
      </span>
      <div className={`text-[34px] font-mono tabular-nums font-bold leading-none mt-3 ${styles.text}`}>
        {value}
      </div>
      <div className="hud-label mt-2">{label}</div>
      {/* tabular-nums + truncate: este subline lleva cifras ("1.234 de 5.678
          pedidos") y sin tabular los dígitos no alinean entre las 3 tarjetas. */}
      <div className="text-[11px] text-muted-foreground mt-2 leading-snug tabular-nums truncate">
        {subline}
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
/**
 * Fila con barra proporcional bajo el rótulo: el % que ya vive en la última
 * columna ahora también se LEE de un vistazo. No agrega ningún número nuevo —
 * la barra usa exactamente el mismo `pct` que se imprime al lado.
 *
 * Un 0 medido deja la pista vacía (no se fuerza un ancho mínimo): un cero tiene
 * que verse como cero. Los valores chicos pero distintos de cero sí reciben un
 * mínimo de 2% para no desaparecer.
 */
function Row({ tone, label, ventas, guias, pct }: RowProps) {
  const labelColor = {
    success: 'text-success',
    info:    'text-info',
    warning: 'text-warning',
    danger:  'text-danger',
  }[tone];
  const barColor = {
    success: 'bg-success',
    info:    'bg-info',
    warning: 'bg-warning',
    danger:  'bg-danger',
  }[tone];
  const width = pct <= 0 ? 0 : Math.max(2, Math.min(100, pct));
  return (
    <tr className="border-b border-border/50 last:border-b-0 hover:bg-card/60 transition-colors duration-200">
      <td className="px-5 py-2.5 align-middle">
        <div className={`font-semibold ${labelColor}`}>{label}</div>
        <div className="mt-1.5 h-1.5 rounded-full bg-foreground/10 overflow-hidden max-w-[220px]" aria-hidden="true">
          <div className={`h-full rounded-full ${barColor}`} style={{ width: `${width}%` }} />
        </div>
      </td>
      <td className="px-3 py-2.5 text-right font-mono tabular-nums text-foreground align-middle">
        {ventas === null
          ? <span className="text-muted-foreground/60" title="La fuente no desglosa el valor por tipo de pendiente">—</span>
          : formatCOP(ventas)}
      </td>
      <td className="px-3 py-2.5 text-right font-mono tabular-nums text-foreground align-middle">{guias.toLocaleString('es-CO')}</td>
      <td className="px-5 py-2.5 text-right font-mono tabular-nums text-muted-foreground align-middle">{pct.toFixed(1)}%</td>
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
/**
 * Tasa dibujada como aro (conic-gradient + máscara donut, la receta cruda del
 * lenguaje) en vez de una cifra suelta.
 *
 * NO usa <GaugeRing/> por dos razones concretas:
 *  1. GaugeRing imprime `Math.round(shown)` — perdería el decimal que esta
 *     pantalla muestra hoy ("62.4%" pasaría a "62%"): cambiar la precisión de
 *     un número medido no es un cambio visual, es otro dato.
 *  2. Su rampa es siempre accent→accent2→cyan; acá el color ES el veredicto
 *     (verde despacho / rojo cancelación) y perderlo borraría información.
 *
 * Sin medición (`pct === null`) NO se dibuja aro: va el círculo dashed con "—",
 * el mismo patrón que el hero del Dashboard cuando no hay resueltos. Pasarle 0
 * al aro pintaría un veredicto que nadie midió.
 */
function RateCard({ label, pct, subline, tone }: RateCardProps) {
  const noData = pct === null;
  const SIZE = 148;
  const THICKNESS = 16;
  const token = tone === 'success' ? '--success' : '--danger';
  const textColor = noData
    ? 'text-muted-foreground'
    : tone === 'success' ? 'text-success' : 'text-danger';
  const deg = noData ? 0 : Math.max(0, Math.min(100, pct)) * 3.6;
  const donutMask = `radial-gradient(farthest-side, transparent calc(100% - ${THICKNESS}px), #000 calc(100% - ${THICKNESS - 1}px))`;
  const tickMask = 'radial-gradient(farthest-side, transparent calc(100% - 6px), #000 calc(100% - 5px))';

  return (
    <article className="rounded-2xl border border-border bg-card/40 p-5 shadow-card3d hairline-top h-full flex flex-col items-center text-center transition-colors duration-200 hover:border-border-strong">
      <div className="hud-label self-start">{label}</div>

      <div className="py-4">
        {noData ? (
          <div
            className="flex flex-col items-center justify-center rounded-full border border-dashed border-border bg-muted/20 text-center px-6"
            style={{ width: SIZE, height: SIZE }}
            role="img"
            aria-label="Tasa sin datos todavía"
            title="No hay pedidos en el rango: no hay con qué calcular esta tasa"
          >
            <span className="text-5xl font-bold text-muted-foreground leading-none">—</span>
          </div>
        ) : (
          <div
            role="progressbar"
            aria-valuenow={Math.round(pct)}
            // El decimal importa (por eso este aro NO usa GaugeRing, que
            // redondea). `aria-valuenow` sólo acepta número, así que el texto
            // exacto viaja en `aria-valuetext`: quien usa lector de pantalla
            // escucha lo mismo que se ve, 62.4% y no 62%.
            aria-valuetext={`${pct.toFixed(1)}%`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={label}
            className="relative"
            style={{ width: SIZE, height: SIZE }}
          >
            {/* Marcas de tick del borde */}
            <div
              aria-hidden="true"
              className="absolute rounded-full opacity-50"
              style={{
                inset: -3,
                background: 'repeating-conic-gradient(from -90deg, hsl(var(--foreground) / .30) 0deg .7deg, transparent .7deg 15deg)',
                WebkitMask: tickMask,
                mask: tickMask,
              }}
            />
            {/* Pista + arco de progreso, teñido con el token del veredicto */}
            <div
              aria-hidden="true"
              className="absolute inset-0 rounded-full"
              style={{
                background: `conic-gradient(from 200deg, hsl(var(${token})) 0deg, hsl(var(${token})) ${deg}deg, hsl(var(--foreground) / .06) ${deg}deg)`,
                WebkitMask: donutMask,
                mask: donutMask,
                boxShadow: `0 0 40px -8px hsl(var(${token}) / .55)`,
              }}
            />
            <div className="absolute inset-0 flex items-center justify-center">
              <span className={`font-mono tabular-nums font-bold leading-none text-2xl ${textColor}`}>
                {pct.toFixed(1)}%
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="text-[11px] text-muted-foreground font-mono tabular-nums leading-snug">
        {subline}
      </div>
    </article>
  );
}

import { useMemo } from 'react';
import {
  Package as PackageIcon, Wallet, ArrowRight, TrendingDown, Info,
  Boxes, DollarSign, CheckCircle2, AlertTriangle, RefreshCw,
} from 'lucide-react';
import { buildMesResumen, buildMesResumenFromBreakdown, type BucketTone } from '@/lib/mesResumen';
import type { LogisticsSummary, LogisticsFilters } from '@/lib/logistics.types';
import { useEstadoBreakdown } from '@/hooks/useEstadoBreakdown';
import { useGananciaNetaDropi } from '@/hooks/useGananciaNetaDropi';
import { useOperativoCohorte } from '@/hooks/useOperativoCohorte';
import { useWalletSaldoHoy } from '@/hooks/useWalletMovements';
import { useWalletSyncHealth } from '@/hooks/useWalletSyncHealth';
import OrdersSyncBadge from '@/components/logistics/OrdersSyncBadge';
import NightlyCheckBadge from '@/components/logistics/NightlyCheckBadge';
import { Button } from '@/components/ui/button';
import { useResumenSync } from '@/hooks/useResumenSync';
import KpiCard from '@/components/logistics/finanzas/KpiCard';
import NetoRealCard from '@/components/logistics/NetoRealCard';
import SimuladorUnitEconomics from '@/components/logistics/SimuladorUnitEconomics';
import { useLogisticsCostBasis } from '@/hooks/useLogisticsCostBasis';
import { useLogisticaMonthlyCosts } from '@/hooks/useLogisticaMonthlyCosts';
import { useStore } from '@/contexts/StoreContext';
import { formatCOP } from '@/lib/utils';

// "Cómo voy este mes" — vive en Logística → Resumen (managerOnly, lo ven los
// socios). Pantalla única de rendimiento, reconciliada con el dashboard de Dropi:
//   1. Tiles Dropi-parity (generados / productos vendidos / total vendido /
//      entregados / ganancia neta real).
//   2. Embudo por estado SIN huecos (desde el desglose real; los estados sin
//      mapear se muestran por nombre, no en un "Otros" anónimo).
//   3. Conciliación: lo realizado (≈ "Utilidad Total" de Dropi, ya pagada) vs lo
//      pendiente (≈ "Estimada" de Dropi) vs lo perdido. + el saldo real del wallet.
//
// Datos: desglose por estado vía useEstadoBreakdown (RPC store-scoped). Si el RPC
// no está desplegado aún, cae al builder basado en el `summary` de logistics_summary.

// Color del bullet por estado — mismos tokens DS que el stacked bar de la tab.
const TONE_BAR: Record<BucketTone, string> = {
  pending:     'hsl(var(--muted-foreground))',
  preparacion: 'hsl(var(--ai))',
  transit:     'hsl(var(--info))',
  novedad:     'hsl(var(--warning))',
  entregado:   'hsl(var(--success))',
  devuelto:    'hsl(var(--danger))',
  rechazado:   'hsl(var(--danger) / 0.6)',
  cancelado:   'hsl(var(--muted-foreground) / 0.6)',
  otros:       'hsl(var(--muted-foreground) / 0.4)',
};

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Título: "Cómo voy — mayo 2026" si el rango es el mes calendario actual. */
function rangeTitle(filters: LogisticsFilters): string {
  const now = new Date();
  const firstOfMonth = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-01`;
  const today = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  if (filters.fromDate === firstOfMonth && filters.toDate === today) {
    const mes = now.toLocaleDateString('es-CO', { month: 'long', year: 'numeric' });
    return `Cómo voy — ${mes}`;
  }
  return 'Cómo voy — período seleccionado';
}

interface Props {
  summary: LogisticsSummary | null;
  filters: LogisticsFilters;
}

export default function MesActualResumen({ summary, filters }: Props) {
  // Desglose real por estado (RPC). Si no está desplegado → null → fallback.
  const { data: breakdown } = useEstadoBreakdown(filters.fromDate, filters.toDate);
  const full = useMemo(() => buildMesResumenFromBreakdown(breakdown ?? null), [breakdown]);
  const fallback = useMemo(() => buildMesResumen(summary), [summary]);
  const resumen = full ?? fallback;

  // El sync es solo del dueño (las edge functions validan isStoreOwner / membresía).
  const { isOwnerOfActive, activeStoreId } = useStore();
  const resumenSync = useResumenSync();
  const walletHealth = useWalletSyncHealth(activeStoreId);
  const walletStale = walletHealth.data?.status === 'stale' || walletHealth.data?.status === 'critical';

  const { data: ganancia, isLoading: gananciaLoading, isError: gananciaError } = useGananciaNetaDropi(
    filters.fromDate, filters.toDate,
  );
  // Saldo real de HOY (último movimiento, sin filtro de mes) — la card decía
  // "Saldo disponible hoy" pero mostraba el saldo al cierre del mes filtrado.
  const { data: saldoHoy, isLoading: walletLoading } = useWalletSaldoHoy();
  // Mes mostrado ('YYYY-MM'); el rango siempre arranca el 1ro del mes → slice OK.
  // Se computa ACÁ (antes del early return) porque el hook de cohorte lo necesita.
  const yearMonth = filters.fromDate.slice(0, 7);
  const cohorte = useOperativoCohorte(yearMonth);
  // Base de costos REAL (COGS + flete) + costos mensuales (pauta/admin) para el
  // simulador de unit-economics. Ambos store-scoped; degradan a null/ceros si la
  // migration no está aplicada (el simulador avisa, no rompe).
  const costBasis = useLogisticsCostBasis(filters.fromDate, filters.toDate, filters.ciudad);
  const monthlyCosts = useLogisticaMonthlyCosts(yearMonth);

  const title = rangeTitle(filters);

  if (!resumen) {
    return (
      <section className="rounded-xl border border-border bg-card p-5">
        <div className="h-40 animate-pulse bg-muted/30 rounded" />
      </section>
    );
  }

  // ── Valores derivados para tiles (funcionan con full o fallback) ──
  const canceladoCount = resumen.buckets.find((b) => b.key === 'cancelado')?.count ?? 0;
  const entregadoCount = resumen.buckets.find((b) => b.key === 'entregado')?.count ?? 0;
  const generadosSinCancel = full?.generadosSinCancel ?? Math.max(0, resumen.generadoTotal - canceladoCount);
  const pctCompletado = full?.pctCompletado
    ?? (generadosSinCancel > 0 ? (entregadoCount / generadosSinCancel) * 100 : 0);
  const unidadesVendidas = full?.unidadesVendidas ?? null;
  const totalVendido = full?.totalVendido ?? null;

  const gananciaNeta = ganancia?.ganancia_neta ?? 0;
  const totalEntradas = ganancia?.total_entradas ?? 0;
  const totalSalidas = ganancia?.total_salidas ?? 0;
  const saldoActual = saldoHoy ?? null;

  // OPERATIVO_BASE: utilidad de los pedidos CREADOS este mes (cohorte) — reconcilia
  // con la "Utilidad Total" de Dropi (~$4.8M). Fallback al wallet (gananciaNeta, por
  // fecha de movimiento, ~$7.2M) SOLO si el RPC operativo_mes_cohorte no está
  // desplegado aún. Punto ÚNICO de cambio del operativo.
  const operativoBase = cohorte.data?.operativo ?? gananciaNeta;
  const operativoLoading = cohorte.isLoading || gananciaLoading;
  const movimientosSinLink = cohorte.data?.movimientos_sin_link ?? 0;
  const valorPreparacion = full?.valorPreparacion ?? 0;
  const valorOtros = full?.valorOtros ?? 0;

  // "Pedidos en la calle" = lo que falta CERRAR = generado − (entregado + devuelto
  // + cancelado). Lo no-cerrado (pendiente + preparación + tránsito + novedad +
  // estados sin clasificar) es lo que el dueño mira primero.
  // devuelto = devoluciones REALES (sin rechazos, que ahora son bucket propio).
  const devueltoCount = resumen.buckets.find((b) => b.key === 'devuelto')?.count ?? 0;
  const rechazadoCount = resumen.buckets.find((b) => b.key === 'rechazado')?.count ?? 0;
  const valorRechazos = resumen.buckets.find((b) => b.key === 'rechazado')?.valor ?? 0;

  // Cerrado = ciclo terminado (entregado + devuelto + rechazado + cancelado).
  const closedCount = ['entregado', 'devuelto', 'rechazado', 'cancelado'].reduce(
    (a, k) => a + (resumen.buckets.find((b) => b.key === k)?.count ?? 0), 0,
  );
  const enLaCalleCount = Math.max(0, resumen.generadoTotal - closedCount);
  // Resta TODOS los cerrados (incluido rechazo) — si no, "en la calle" se infla por
  // el valor de los rechazos (que ya salieron del ciclo). Cuadra con closedCount.
  const enLaCalleValor = Math.max(
    0,
    resumen.valorGenerado
      - (resumen.valorEntregado + resumen.valorPerdido + valorRechazos + resumen.valorCancelado),
  );

  // Despachado = lo que salió a la transportadora (entregado + devuelto + rechazado
  // + tránsito + novedad). El rechazo SÍ se despachó (el cliente lo rechazó en la
  // puerta). Excluye pendiente/preparación/cancelado. Alimenta el simulador.
  const DISPATCHED_KEYS = ['entregado', 'devuelto', 'rechazado', 'en_transito', 'novedad'];
  const despachadosCount = DISPATCHED_KEYS.reduce(
    (a, k) => a + (resumen.buckets.find((b) => b.key === k)?.count ?? 0), 0,
  );
  const despachadoValor = DISPATCHED_KEYS.reduce(
    (a, k) => a + (resumen.buckets.find((b) => b.key === k)?.valor ?? 0), 0,
  );
  const facturadoValor = totalVendido ?? Math.max(0, resumen.valorGenerado - resumen.valorCancelado);

  // Detector de estados nuevos de Dropi sin clasificar: las barras `otros` del
  // desglose real (full) son estados que ningún bucket conoce. Si aparece alguno,
  // el dueño ve un aviso para mapearlo — así un estado nuevo no rompe los KPIs en
  // silencio. Solo con `full` (el fallback no itemiza por nombre).
  const sinMapear = full ? full.buckets.filter((b) => b.tone === 'otros') : [];

  // Detalle por estado CRUDO (tabla dinámica): cada estado individual con su
  // conteo, % y valor — sin agrupar en buckets. Reemplaza la tabla dinámica
  // manual del dueño. Ordenado por cantidad desc.
  const estadoDetalle = (breakdown ?? [])
    .map((r) => ({ estado: r.estado, pedidos: r.pedidos, valor: r.valor }))
    .sort((a, b) => b.pedidos - a.pedidos);
  const estadoDetalleTotal = estadoDetalle.reduce((a, r) => a + r.pedidos, 0);

  return (
    <section className="rounded-xl border border-accent/30 bg-card overflow-hidden">
      {/* Header */}
      <header className="px-5 py-3.5 border-b border-border flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <PackageIcon size={15} className="text-accent shrink-0" strokeWidth={2.25} />
          <h3 className="text-sm font-bold tracking-tight text-foreground capitalize truncate">
            {title}
          </h3>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[11px] text-muted-foreground">
            {resumen.generadoTotal.toLocaleString('es-CO')} pedidos generados
          </span>
          <OrdersSyncBadge size="sm" />
          <NightlyCheckBadge size="sm" />
          {isOwnerOfActive && (
            <Button
              onClick={() => resumenSync.mutate({ from: filters.fromDate, untill: filters.toDate })}
              disabled={resumenSync.isPending}
              size="sm"
              variant="outline"
            >
              <RefreshCw size={14} className={`mr-1.5 ${resumenSync.isPending ? 'animate-spin' : ''}`} />
              {resumenSync.isPending ? 'Sincronizando…' : 'Sincronizar'}
            </Button>
          )}
        </div>
      </header>

      {/* ── Pedidos en la calle (lo que falta cerrar) — lo primero que mira el dueño ── */}
      <div className="px-5 py-4 border-b border-border bg-accent/5 flex items-center gap-2.5">
        <ArrowRight size={18} className="text-accent shrink-0" />
        <div className="min-w-0">
          <div className="text-2xl font-bold tabular-nums text-foreground leading-tight">
            {enLaCalleCount.toLocaleString('es-CO')}
            <span className="text-sm font-medium text-muted-foreground ml-1.5">pedidos en la calle</span>
          </div>
          <div className="text-[11px] text-muted-foreground">
            {formatCOP(enLaCalleValor)} por definir · falta cerrar (sin contar entregados / devueltos / cancelados)
          </div>
        </div>
      </div>

      {/* Detector de estados sin clasificar — se dispara con cualquier estado nuevo
          de Dropi que aún no mapeamos. Solo el dueño lo ve. Ámbar informativo. */}
      {isOwnerOfActive && sinMapear.length > 0 && (
        <div className="px-5 py-2.5 border-b border-warning/30 bg-warning/8 flex items-start gap-2">
          <AlertTriangle size={14} className="text-warning shrink-0 mt-0.5" />
          <p className="text-[11px] text-warning leading-relaxed">
            <strong>{sinMapear.length} estado{sinMapear.length === 1 ? '' : 's'} sin clasificar:</strong>{' '}
            {sinMapear.map((b) => `${b.label} (${b.count})`).join(' · ')}. Avisá para mapearlos.
          </p>
        </div>
      )}

      {/* ── Tiles Dropi-parity ─────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 p-5 border-b border-border">
        <KpiCard
          label="Pedidos generados"
          value={generadosSinCancel.toLocaleString('es-CO')}
          icon={PackageIcon}
          tone="info"
          hint={canceladoCount > 0 ? `${canceladoCount} cancelados aparte` : 'sin cancelados'}
        />
        <KpiCard
          label="Productos vendidos"
          value={unidadesVendidas != null ? unidadesVendidas.toLocaleString('es-CO') : '—'}
          icon={Boxes}
          tone="info"
          hint="unidades (sin cancelar)"
        />
        <KpiCard
          label="Total vendido"
          value={totalVendido != null ? formatCOP(totalVendido) : '—'}
          icon={DollarSign}
          tone="accent"
          hint="solo despachado (sin pend./prep./rechazo) · = Dropi"
        />
        <KpiCard
          label="Entregados"
          value={entregadoCount.toLocaleString('es-CO')}
          icon={CheckCircle2}
          tone="success"
          hint={`${pctCompletado.toFixed(0)}% completado`}
        />
        {/* OPERATIVO_BASE — ver const operativoBase arriba: cohorte de pedido
            (reconcilia con la "Utilidad Total" de Dropi), con fallback al wallet. */}
        <KpiCard
          label="Operativo del mes"
          value={operativoLoading ? '…' : formatCOP(operativoBase)}
          icon={Wallet}
          tone={walletStale ? 'warning' : operativoBase >= 0 ? 'success' : 'danger'}
          hint={walletStale ? '⚠ wallet viejo, sincronizá' : 'pedidos del mes · realizado a hoy'}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-0 divide-y lg:divide-y-0 lg:divide-x divide-border">
        {/* ── Bloque A — Embudo por estado ─────────────────────────── */}
        <div className="p-5 space-y-3">
          <h4 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-muted-foreground">
            Embudo del mes · por estado
          </h4>
          <div className="space-y-2.5">
            {resumen.buckets.map((b) => (
              <div key={b.key}>
                <div className="flex items-baseline justify-between gap-2 mb-1">
                  <div className="min-w-0">
                    <span className="text-xs font-medium text-foreground">{b.label}</span>
                    {b.sublabel && (
                      <span className="text-[10px] text-muted-foreground ml-2">{b.sublabel}</span>
                    )}
                  </div>
                  <div className="flex items-baseline gap-2 shrink-0 tabular-nums">
                    <span className="text-sm font-bold text-foreground">{b.count}</span>
                    <span className="text-[10px] text-muted-foreground w-9 text-right">
                      {b.pct.toFixed(0)}%
                    </span>
                    <span className="text-[10px] font-mono text-muted-foreground w-24 text-right">
                      {b.valor > 0 ? formatCOP(b.valor) : '—'}
                    </span>
                  </div>
                </div>
                <div className="h-2 rounded-full bg-muted/30 overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.max(2, Math.min(100, b.pct))}%`,
                      background: TONE_BAR[b.tone],
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Bloque B — Conciliación de plata ──────────────────────── */}
        <div className="p-5 space-y-4">
          <h4 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-muted-foreground">
            Conciliación · de lo generado a lo real
          </h4>

          {/* Cascada: valor generado − fugas = realizado */}
          <div className="rounded-lg border border-border bg-muted/10 divide-y divide-border text-sm">
            <WaterfallRow label="Valor generado (con cancelados)" value={resumen.valorGenerado} tone="base" />
            {valorPreparacion > 0 && (
              <WaterfallRow label="En preparación" value={-valorPreparacion} tone="muted" />
            )}
            <WaterfallRow label="En tránsito (sin cobrar aún)" value={-resumen.valorEnTransito} tone="muted" />
            <WaterfallRow label="En novedad (en riesgo)" value={-resumen.valorNovedades} tone="muted" />
            <WaterfallRow label="Pendientes" value={-resumen.valorPendientes} tone="muted" />
            {valorOtros > 0 && (
              <WaterfallRow label="Otros estados" value={-valorOtros} tone="muted" />
            )}
            <WaterfallRow label="Devueltos (perdido)" value={-resumen.valorPerdido} tone="danger" />
            {valorRechazos > 0 && (
              <WaterfallRow label="Rechazados (cliente rechazó)" value={-valorRechazos} tone="danger" />
            )}
            <WaterfallRow label="Cancelados" value={-resumen.valorCancelado} tone="muted" />
            <WaterfallRow label="Valor entregado (realizado)" value={resumen.valorEntregado} tone="success" emphasis />
          </div>

          {/* Wallet REAL */}
          <div className={`rounded-lg border p-3.5 space-y-2.5 ${walletStale ? 'border-warning/40 bg-warning/5' : 'border-border bg-card'}`}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Wallet size={13} className="text-accent" />
                <span className="text-[11px] uppercase tracking-[0.08em] font-semibold text-muted-foreground">
                  Wallet REAL
                </span>
              </div>
              {walletStale && (
                <span className="inline-flex items-center gap-1 text-[10px] text-warning">
                  <AlertTriangle size={10} /> desactualizado — sincronizá
                </span>
              )}
            </div>
            {(gananciaLoading || walletLoading) ? (
              <div className="h-12 animate-pulse bg-muted/30 rounded" />
            ) : gananciaError ? (
              <div className="text-xs text-danger">
                No se pudo cargar la ganancia del wallet (error temporal, reintentando). Recargá o tocá Sincronizar — el número puede no ser real.
              </div>
            ) : (
              <div className={walletStale ? 'opacity-60' : ''}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    Caja bruta del wallet · NO es ganancia
                    <span className="block text-[10px] text-muted-foreground/70">
                      Entró {formatCOP(totalEntradas)} · salió {formatCOP(totalSalidas)} · por fecha de pago (mezcla meses)
                    </span>
                  </span>
                  <span className={`text-base font-bold tabular-nums shrink-0 ${gananciaNeta >= 0 ? 'text-green' : 'text-red'}`}>
                    {formatCOP(gananciaNeta)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2 border-t border-border pt-2.5 mt-2.5">
                  <span className="text-xs text-foreground font-medium">Saldo disponible hoy</span>
                  <span className="text-base font-bold tabular-nums text-foreground shrink-0">
                    {saldoActual != null ? formatCOP(saldoActual) : '—'}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Neto real = operativo − pauta − admin (inputs que persisten por mes,
              solo el dueño edita). El operativo es el OPERATIVO_BASE de arriba. */}
          <NetoRealCard
            operativo={operativoBase}
            yearMonth={yearMonth}
            canEdit={isOwnerOfActive}
            pedidosEnCalle={enLaCalleCount}
            movimientosSinLink={movimientosSinLink}
          />

          {/* Explicación llana del gap */}
          <div className="flex items-start gap-2 text-[11px] text-muted-foreground">
            <Info size={13} className="text-info shrink-0 mt-0.5" />
            <p>
              La cascada de arriba es el valor de los pedidos que <strong className="text-foreground">creaste este mes</strong>,
              por estado. La <strong className="text-foreground">caja bruta del wallet</strong> es la plata que entró y salió
              este mes — va por <strong className="text-foreground">fecha de pago</strong>, así que incluye pedidos de meses
              anteriores y <strong className="text-foreground">NO es tu ganancia</strong>. Tu ganancia confiable es el
              <strong className="text-foreground"> Operativo del mes</strong> (cohorte, arriba), que reconcilia con la
              "Utilidad Total" de Dropi. El <strong className="text-foreground">saldo</strong> del wallet es tu plata
              disponible hoy, después de fletes, devoluciones y retiros.
            </p>
          </div>
        </div>
      </div>

      {/* ── Tabla dinámica · detalle por estado (todos los estados crudos) ── */}
      {estadoDetalle.length > 0 && (
        <div className="border-t border-border px-5 py-5">
          <details className="group">
            <summary className="flex items-center gap-2 cursor-pointer list-none select-none">
              <span className="text-[11px] uppercase tracking-[0.08em] font-semibold text-muted-foreground">
                Detalle por estado · tabla dinámica
              </span>
              <span className="text-[10px] text-muted-foreground group-open:hidden">▸ ver todos</span>
              <span className="text-[10px] text-muted-foreground hidden group-open:inline">▾ ocultar</span>
              <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">
                {estadoDetalle.length} estados · {estadoDetalleTotal.toLocaleString('es-CO')} pedidos
              </span>
            </summary>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-xs tabular-nums">
                <thead>
                  <tr className="text-[10px] uppercase tracking-[0.06em] text-muted-foreground border-b border-border">
                    <th className="text-left font-semibold py-1.5">Estado</th>
                    <th className="text-right font-semibold py-1.5">Pedidos</th>
                    <th className="text-right font-semibold py-1.5 w-16">%</th>
                    <th className="text-right font-semibold py-1.5 w-32">Valor</th>
                  </tr>
                </thead>
                <tbody>
                  {estadoDetalle.map((r) => (
                    <tr key={r.estado} className="border-b border-border/40">
                      <td className="text-left py-1.5 text-foreground/90">{r.estado}</td>
                      <td className="text-right py-1.5 font-semibold text-foreground">{r.pedidos.toLocaleString('es-CO')}</td>
                      <td className="text-right py-1.5 text-muted-foreground">
                        {estadoDetalleTotal > 0 ? ((r.pedidos / estadoDetalleTotal) * 100).toFixed(1) : '0.0'}%
                      </td>
                      <td className="text-right py-1.5 font-mono text-muted-foreground">{formatCOP(r.valor)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border font-semibold text-foreground">
                    <td className="text-left py-1.5">Total</td>
                    <td className="text-right py-1.5">{estadoDetalleTotal.toLocaleString('es-CO')}</td>
                    <td className="text-right py-1.5">100%</td>
                    <td className="text-right py-1.5 font-mono">{formatCOP(resumen.valorGenerado)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </details>
        </div>
      )}

      {/* Indicadores & Simulador de unit-economics (KPIs reales + what-if) */}
      <div className="border-t border-border px-5 py-5">
        <SimuladorUnitEconomics
          generadosSinCancel={generadosSinCancel}
          totalVendido={facturadoValor}
          despachadosCount={despachadosCount}
          despachadoValor={despachadoValor}
          entregadosCount={entregadoCount}
          valorEntregado={resumen.valorEntregado}
          devueltosCount={devueltoCount}
          valorPerdido={resumen.valorPerdido}
          rechazadosCount={rechazadoCount}
          valorRechazos={valorRechazos}
          costBasis={costBasis.data ?? null}
          costBasisLoading={costBasis.isLoading}
          pautaTotal={(monthlyCosts.data?.pauta_meta ?? 0) + (monthlyCosts.data?.pauta_tiktok ?? 0)}
          adminTotal={monthlyCosts.data?.costos_admin ?? 0}
          fromDate={filters.fromDate}
          toDate={filters.toDate}
        />
      </div>
    </section>
  );
}

function WaterfallRow({
  label, value, tone, emphasis,
}: {
  label: string;
  value: number;
  tone: 'base' | 'muted' | 'success' | 'danger';
  emphasis?: boolean;
}) {
  const isNeg = value < 0;
  const valTone =
    tone === 'success' ? 'text-green'
    : tone === 'danger' ? 'text-red'
    : tone === 'muted' ? 'text-muted-foreground'
    : 'text-foreground';

  return (
    <div className={`flex items-center justify-between gap-2 px-3.5 py-2 ${emphasis ? 'bg-green/5' : ''}`}>
      <span className={`flex items-center gap-1.5 ${emphasis ? 'text-sm font-bold text-foreground' : 'text-xs text-foreground/90'}`}>
        {emphasis && <ArrowRight size={12} className="text-green" />}
        {tone === 'danger' && <TrendingDown size={11} className="text-red" />}
        {label}
      </span>
      <span className={`font-mono tabular-nums shrink-0 ${emphasis ? 'text-sm font-bold' : 'text-xs'} ${valTone}`}>
        {isNeg ? '−' : ''}{formatCOP(Math.abs(value))}
      </span>
    </div>
  );
}

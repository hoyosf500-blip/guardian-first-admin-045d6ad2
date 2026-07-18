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
import { useStoreAdSpendRange, sumAdSpend } from '@/hooks/useStoreAdSpend';
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
  const { data: breakdown } = useEstadoBreakdown(filters.fromDate, filters.toDate, filters.ciudad);
  const full = useMemo(() => buildMesResumenFromBreakdown(breakdown ?? null), [breakdown]);
  const fallback = useMemo(() => buildMesResumen(summary), [summary]);
  const resumen = full ?? fallback;

  // El sync es solo del dueño (las edge functions validan isStoreOwner / membresía).
  const { isOwnerOfActive, isManagerOfActive, activeStoreId } = useStore();
  const resumenSync = useResumenSync();
  const walletHealth = useWalletSyncHealth(activeStoreId);
  const walletStale = walletHealth.data?.status === 'stale' || walletHealth.data?.status === 'critical';

  const { data: ganancia, isLoading: gananciaLoading, isError: gananciaError } = useGananciaNetaDropi(
    filters.fromDate, filters.toDate,
  );
  // Saldo real de HOY (último movimiento, sin filtro de mes) — la card decía
  // "Saldo disponible hoy" pero mostraba el saldo al cierre del mes filtrado.
  const { data: saldoHoy, isLoading: walletLoading } = useWalletSaldoHoy();
  // Mes mostrado ('YYYY-MM'). OJO: el rango NO siempre arranca el 1ro — los
  // presets 7d/30d/90d/Histórico cruzan meses. El cohorte (que es de UN mes
  // calendario completo) solo aplica si el rango cubre el mes entero; si no,
  // el tile "Operativo" cae a la caja del wallet, que SÍ respeta el rango.
  // Mismo guard que FinanzasTab (auditoría 2026-07-07).
  const yearMonth = filters.fromDate.slice(0, 7);
  const isSingleMonth = (() => {
    if (yearMonth !== filters.toDate.slice(0, 7)) return false;
    if (filters.fromDate !== `${yearMonth}-01`) return false;
    const [yy, mm] = yearMonth.split('-').map(Number);
    const monthEnd = `${yearMonth}-${String(new Date(yy, mm, 0).getDate()).padStart(2, '0')}`;
    const todayStr = new Date().toLocaleDateString('en-CA');
    return filters.toDate >= monthEnd || filters.toDate >= todayStr;
  })();
  const cohorte = useOperativoCohorte(isSingleMonth ? yearMonth : '');
  // Base de costos REAL (COGS + flete) + costos mensuales (pauta/admin) para el
  // simulador de unit-economics. Ambos store-scoped; degradan a null/ceros si la
  // migration no está aplicada (el simulador avisa, no rompe).
  const costBasis = useLogisticsCostBasis(filters.fromDate, filters.toDate, filters.ciudad);
  const monthlyCosts = useLogisticaMonthlyCosts(yearMonth);

  // Pauta DIARIA (bitácora, store-scoped) — es la fuente de la pauta del Neto Real
  // desde 2026-07. Si el período tiene registros diarios, manda la suma diaria; si
  // no (mes viejo con solo el número mensual), cae al valor guardado en
  // logistica_monthly_costs. Así lo diario alimenta el Neto Real SIN doble descuento
  // ni doble carga, y los meses históricos no pierden su pauta. Degrada a 0 si la
  // migration de pauta diaria no está aplicada.
  const { data: adRows } = useStoreAdSpendRange(filters.fromDate, filters.toDate);
  const pautaDiariaTotal = sumAdSpend(adRows ?? []).total;
  const pautaMensualGuardada =
    (monthlyCosts.data?.pauta_meta ?? 0) + (monthlyCosts.data?.pauta_tiktok ?? 0);
  const pautaFromDaily = pautaDiariaTotal > 0;
  const pautaEfectiva = pautaFromDaily ? pautaDiariaTotal : pautaMensualGuardada;

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
  // con la "Utilidad Total" de Dropi (~$4.8M). Cae a la caja del wallet cuando:
  // el rango no es un mes completo, el RPC no está desplegado, o el RPC FALLÓ
  // (antes cohorte.isError caía en silencio al wallet inflado bajo la etiqueta
  // de cohorte — auditoría 2026-07-07: ahora el hint dice la base real).
  const usingCohorte = isSingleMonth && !cohorte.isError && cohorte.data?.operativo != null;
  const operativoBase = usingCohorte ? cohorte.data!.operativo : gananciaNeta;
  const operativoLoading = cohorte.isLoading || gananciaLoading;
  // La base cayó al wallet Y el wallet FALLÓ: `gananciaNeta` es 0 por el `?? 0`
  // de arriba, no por una medición. Sin este flag el tile pinta "$0" en verde,
  // indistinguible de un período real sin caja — y contradice al aviso de error
  // que la card "Wallet REAL" de al lado ya muestra. Mismo caso que FinanzasTab.
  const operativoSinDato = !usingCohorte && gananciaError;
  const movimientosSinLink = usingCohorte ? (cohorte.data?.movimientos_sin_link ?? 0) : 0;
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
    <section className="relative rounded-3xl border border-border bg-card/40 overflow-hidden shadow-card3d-lg hairline-top">
      {/* Sin corner-brackets: se posicionan a 14px del borde y aquí caerían
          justo encima del ícono y del botón Sincronizar del header. */}
      <span className="sheen animate-gb-sheen" aria-hidden="true" />
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
            <span className="font-mono tabular-nums">{resumen.generadoTotal.toLocaleString('es-CO')}</span> pedidos generados
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
      <div className="px-5 py-5 border-b border-border bg-accent/5 flex items-center gap-3">
        <span className="w-10 h-10 rounded-2xl bg-accent/14 border border-accent/30 text-accent glow-accent flex items-center justify-center shrink-0" aria-hidden="true">
          <ArrowRight size={18} />
        </span>
        <div className="min-w-0">
          <div className="text-[38px] font-bold font-mono tabular-nums text-accent leading-none num-glow-accent">
            {/* Sin <CountUp/>: formatea con toFixed y perdería el separador de
                miles es-CO ("1.284" → "1284"). */}
            {enLaCalleCount.toLocaleString('es-CO')}
            <span className="text-sm font-sans font-medium text-muted-foreground ml-2">pedidos en la calle</span>
          </div>
          <div className="text-[11px] text-muted-foreground mt-2">
            <span className="font-mono tabular-nums">{formatCOP(enLaCalleValor)}</span> por definir · falta cerrar (sin contar entregados / devueltos / cancelados)
          </div>
        </div>
      </div>

      {/* Detector de estados sin clasificar — se dispara con cualquier estado nuevo
          de Dropi que aún no mapeamos. Lo ven owner Y supervisores (managers): un
          socio que mira los KPIs también debe enterarse de que hay estados que los
          sesgan (auditoría EC 2026-07-07). Ámbar informativo. */}
      {isManagerOfActive && sinMapear.length > 0 && (
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
        {/* El hint es 0/0 cuando no hay pedidos sin cancelar: `pctOf` devuelve 0
            y el tile decía "0% completado", que se lee como "no entregamos
            nada" cuando en realidad no hay denominador. */}
        <KpiCard
          label="Entregados"
          value={entregadoCount.toLocaleString('es-CO')}
          icon={CheckCircle2}
          tone="success"
          hint={generadosSinCancel > 0
            ? `${pctCompletado.toFixed(0)}% completado`
            : '— sin base para el %'}
        />
        {/* OPERATIVO_BASE — ver const operativoBase arriba: cohorte de pedido
            (reconcilia con la "Utilidad Total" de Dropi), con fallback al wallet. */}
        <KpiCard
          label={usingCohorte ? 'Operativo del mes' : 'Caja del período'}
          value={operativoLoading ? '…' : operativoSinDato ? '—' : formatCOP(operativoBase)}
          icon={Wallet}
          tone={operativoSinDato || walletStale ? 'warning' : operativoBase >= 0 ? 'success' : 'danger'}
          hint={operativoSinDato
            ? '⚠ no se pudo cargar la caja del wallet — no es $0 real'
            : walletStale
            ? '⚠ wallet viejo, sincronizá'
            : usingCohorte
              ? 'pedidos del mes · realizado a hoy'
              : cohorte.isError
                ? '⚠ cohorte no cargó — mostrando caja del wallet del rango'
                : 'caja del wallet en el rango (el cohorte es solo por mes completo)'}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-0 divide-y lg:divide-y-0 lg:divide-x divide-border">
        {/* ── Bloque A — Embudo por estado ─────────────────────────── */}
        <div className="p-5 space-y-3">
          <h4 className="hud-label">
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
                  <div className="flex items-baseline gap-2 shrink-0 font-mono tabular-nums">
                    <span className="text-sm font-bold text-foreground">{b.count}</span>
                    <span className="text-[10px] text-muted-foreground w-9 text-right">
                      {b.pct.toFixed(0)}%
                    </span>
                    <span className="text-[10px] font-mono text-muted-foreground w-24 text-right">
                      {b.valor > 0 ? formatCOP(b.valor) : '—'}
                    </span>
                  </div>
                </div>
                <div className="h-1.5 rounded-full bg-foreground/10 overflow-hidden">
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
          <h4 className="hud-label">
            Conciliación · de lo generado a lo real
          </h4>

          {/* Cascada: valor generado − fugas = realizado */}
          <div className="rounded-2xl border border-border bg-card/40 shadow-card3d divide-y divide-border text-sm overflow-hidden">
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
          <div className={`rounded-2xl border p-4 space-y-2.5 shadow-card3d ${walletStale ? 'border-warning/40 bg-warning/8' : 'border-border bg-card/40'}`}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Wallet size={13} className="text-accent" />
                <span className="hud-label">
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
                  <span className={`text-base font-bold font-mono tabular-nums shrink-0 ${gananciaNeta >= 0 ? 'text-green' : 'text-red'}`}>
                    {formatCOP(gananciaNeta)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2 border-t border-border pt-2.5 mt-2.5">
                  <span className="text-xs text-foreground font-medium">Saldo disponible hoy</span>
                  <span className="text-base font-bold font-mono tabular-nums text-foreground shrink-0">
                    {saldoActual != null ? formatCOP(saldoActual) : '—'}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Neto real = operativo − pauta − admin (inputs que persisten por mes,
              solo el dueño edita). El operativo es el OPERATIVO_BASE de arriba.
              Solo con rango de MES COMPLETO: la pauta/admin son inputs mensuales
              y en un sub-rango restarían el mes entero de la caja de una semana. */}
          {isSingleMonth ? (
            /* Mientras el operativo CARGA, `operativoBase` todavía es 0 (ninguna
               de las dos queries respondió): la card mostraría "Neto real
               −$pauta −admin", una PÉRDIDA en pesos que nadie midió, y el bloque
               de error de abajo podría dispararse aunque el cohorte esté por
               llegar bien. Skeleton primero — mismo patrón que "Wallet REAL". */
            operativoLoading ? (
              <div className="h-24 animate-pulse bg-muted/30 rounded-2xl" />
            ) : operativoSinDato ? (
              /* Sin operativo medido, el Neto Real (operativo − pauta − admin)
                 sería 0 − pauta − admin = una PÉRDIDA en pesos que nadie midió.
                 Preferimos no mostrar la cifra y decir por qué. */
              <div className="rounded-2xl border border-warning/30 bg-warning/8 p-3.5 flex items-start gap-2">
                <AlertTriangle size={13} className="text-warning shrink-0 mt-0.5" />
                <p className="text-[11px] text-warning leading-relaxed">
                  No se pudo cargar el <strong>operativo del mes</strong>, así que el{' '}
                  <strong>Neto Real</strong> no se muestra: restarle pauta y admin a una base
                  que no se pudo medir daría una pérdida inventada. Recargá o tocá Sincronizar.
                </p>
              </div>
            ) : (
            <NetoRealCard
              operativo={operativoBase}
              yearMonth={yearMonth}
              canEdit={isOwnerOfActive}
              pautaTotal={pautaEfectiva}
              pautaFromDaily={pautaFromDaily}
              pedidosEnCalle={enLaCalleCount}
              movimientosSinLink={movimientosSinLink}
            />
            )
          ) : (
            <p className="text-[11px] text-muted-foreground">
              El <strong className="text-foreground">Neto Real</strong> (operativo − pauta − admin) se calcula
              por mes calendario completo — elegí el preset "Mes actual" para verlo.
            </p>
          )}

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
              <span className="hud-label">
                Detalle por estado · tabla dinámica
              </span>
              <span className="text-[10px] text-muted-foreground group-open:hidden">▸ ver todos</span>
              <span className="text-[10px] text-muted-foreground hidden group-open:inline">▾ ocultar</span>
              <span className="ml-auto text-[10px] text-muted-foreground font-mono tabular-nums">
                {estadoDetalle.length} estados · {estadoDetalleTotal.toLocaleString('es-CO')} pedidos
              </span>
            </summary>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-xs tabular-nums">
                <thead>
                  <tr className="hud-label border-b border-border">
                    <th className="text-left font-semibold py-1.5">Estado</th>
                    <th className="text-right font-semibold py-1.5">Pedidos</th>
                    <th className="text-right font-semibold py-1.5 w-16">%</th>
                    <th className="text-right font-semibold py-1.5 w-32">Valor</th>
                  </tr>
                </thead>
                <tbody>
                  {estadoDetalle.map((r) => (
                    <tr key={r.estado} className="border-b border-border/40 hover:bg-foreground/[0.03] transition-colors">
                      <td className="text-left py-1.5 text-foreground/90">{r.estado}</td>
                      <td className="text-right py-1.5 font-mono font-semibold text-foreground">{r.pedidos.toLocaleString('es-CO')}</td>
                      <td className="text-right py-1.5 font-mono text-muted-foreground">
                        {estadoDetalleTotal > 0 ? ((r.pedidos / estadoDetalleTotal) * 100).toFixed(1) : '0.0'}%
                      </td>
                      <td className="text-right py-1.5 font-mono text-muted-foreground">{formatCOP(r.valor)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border font-semibold text-foreground">
                    <td className="text-left py-1.5">Total</td>
                    <td className="text-right py-1.5 font-mono">{estadoDetalleTotal.toLocaleString('es-CO')}</td>
                    <td className="text-right py-1.5 font-mono">100%</td>
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
          pautaTotal={pautaEfectiva}
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

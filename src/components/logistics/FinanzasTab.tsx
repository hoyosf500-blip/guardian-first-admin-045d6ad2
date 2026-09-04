import { useFinancialSummary } from '@/hooks/useFinancialSummary';
import { useGananciaNetaDropi } from '@/hooks/useGananciaNetaDropi';
import { useOperativoCohorte } from '@/hooks/useOperativoCohorte';
import { useWalletDailySeries } from '@/hooks/useWalletMovements';
import { useResumenSync } from '@/hooks/useResumenSync';
import { useWalletSinClasificar } from '@/hooks/useWalletSinClasificar';
import { useStoreAdSpendRange, sumAdSpend } from '@/hooks/useStoreAdSpend';
import { useLogisticaMonthlyCosts } from '@/hooks/useLogisticaMonthlyCosts';
import { useStore } from '@/contexts/StoreContext';
import type { LogisticsFilters } from '@/lib/logistics.types';
import { deriveDeliveryMaturity } from '@/lib/logisticsRates';
import { isRpcMissing } from '@/lib/rpcError';
import { formatCOP } from '@/lib/utils';
import {
  TrendingUp, TrendingDown, Truck, RotateCcw,
  Target, Package, CheckCircle2, AlertTriangle, Receipt, Wallet, Info,
  Ban, Sparkles, ArrowDownToLine, ArrowUpFromLine, RefreshCw,
  Megaphone, PiggyBank, Crosshair,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { TiltCard } from '@/components/ui3d';
import KpiCard from './finanzas/KpiCard';
import WalletSyncBadge from '@/components/wallet/WalletSyncBadge';
import FinanzasHero from './finanzas/FinanzasHero';
import EstadoOrdenesDonut from './finanzas/EstadoOrdenesDonut';
import CashFlowChart from './finanzas/CashFlowChart';
import ComposicionList, { type ComposicionItem } from './finanzas/ComposicionList';
import ConciliacionDevolucionesCard from './finanzas/ConciliacionDevolucionesCard';

// Finanzas — cash flow operativo Dropi, contado en español llano (el dueño no
// es técnico: "cohorte", "Fase A" y el SQL de diagnóstico salieron de la UI).
//
// Layout (estilo Boostec ++ con identidad propia):
//   1. Banner "Cómo leer esta pestaña"
//   2. Hero strip (3 mega-KPIs): Ganancia Neta · Margen · Ingresos
//   3. Pauta y neto (client-side: bitácora diaria + fallback mensual)
//   4. Visualizaciones: Donut Estado órdenes + Cash Flow diario (grid 2-col)
//   5. Composición: Ingresos operativos + Gastos operativos (grid 2-col)
//   6. KPI grid secundario (7 cards — "Ingresos brutos" solo vive en el hero)
//   7. Volumen de operación + Wallet neto
//
// Tests existentes en FinanzasTab.test.tsx imponen presencia literal de:
// "Cómo leer esta pestaña", "Ganancia Neta Dropi", "Utilidad bruta contable",
// "87%", "100", "Wallet neto del período", "Cancelados", "Pauta y neto",
// "Pérdida por devoluciones", "Ganancia markup" + disclaimer. Cualquier
// cambio de copy debe respetar esos contracts.

/** Entrada escalonada del lenguaje del Dashboard: la pantalla se arma de arriba
 *  abajo. Duración fija 0.35s, y=14, y la cascada de delays es la que hace que
 *  se lea como una sola pieza y no como ocho bloques que aparecen de golpe. */
const fadeUp = (delay = 0) => ({
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35, delay, ease: 'easeOut' as const },
});

export default function FinanzasTab({ filters }: { filters: LogisticsFilters }) {
  const { fromDate, toDate } = filters;
  const { data, isLoading, isError, error } = useFinancialSummary(fromDate, toDate);
  const { data: gananciaNeta, isLoading: gananciaLoading, isError: gananciaError } = useGananciaNetaDropi(fromDate, toDate);
  const { data: sinClasificar } = useWalletSinClasificar(fromDate, toDate);
  // ⛔ `isError` SE LEE (4-sep-2026). Sin él, un fallo de la consulta del wallet
  // dejaba `dailySeries` en undefined, el gráfico recibía `[]` y anunciaba
  // "+$0 neto" en VERDE con "Sin movimientos en este rango".
  const { data: dailySeries, isLoading: seriesLoading, isError: seriesError } = useWalletDailySeries(fromDate, toDate);
  // Bug 3: el hero usa el OPERATIVO POR COHORTE (pedidos creados en el mes; por
  // fecha de pedido — reconcilia con la Utilidad de Dropi) en vez de la caja del
  // wallet por fecha de movimiento (infla por mezcla de meses). Solo aplica si el
  // rango es UN mes calendario; en rangos multi-mes el cohorte (1 solo mes) no
  // representa el período → cae a la caja del wallet. Mismo patrón que MesActualResumen.
  const yearMonth = fromDate.slice(0, 7);
  // Cohorte SOLO si el rango cubre el mes COMPLETO (día 1 → fin de mes, o hasta
  // hoy si es el mes en curso). Antes bastaba "mismo mes" y un sub-rango como
  // 1-7 julio mezclaba la ganancia del MES ENTERO (numerador) con los ingresos
  // de una semana (denominador) — margen inflado por construcción (auditoría
  // 2026-07-07). En sub-rangos cae a la caja del wallet, que sí respeta el rango.
  const isSingleMonth = (() => {
    if (yearMonth !== toDate.slice(0, 7)) return false;
    if (fromDate !== `${yearMonth}-01`) return false;
    const [yy, mm] = yearMonth.split('-').map(Number);
    const monthEnd = `${yearMonth}-${String(new Date(yy, mm, 0).getDate()).padStart(2, '0')}`;
    const todayStr = new Date().toLocaleDateString('en-CA');
    return toDate >= monthEnd || toDate >= todayStr;
  })();
  const cohorte = useOperativoCohorte(isSingleMonth ? yearMonth : '');

  // Botón "Sincronizar" (mismo hook + patrón que MesActualResumen): dispara
  // dropi-sync + dropi-wallet-sync con el rango del filtro actual e invalida las
  // queries de Finanzas (incluidas financial-summary y operativo-cohorte) → las
  // cards se refrescan sin cambiar de tab. Solo el dueño sincroniza.
  const { isOwnerOfActive } = useStore();
  const resumenSync = useResumenSync();

  // Pauta del período — MISMO patrón que MesActualResumen: manda la bitácora
  // diaria (store_ad_spend_daily); si el período no tiene registros diarios cae
  // al valor mensual guardado en logistica_monthly_costs. (Hooks acá arriba:
  // el early-return de error va después y no puede saltearlos.)
  const adQuery = useStoreAdSpendRange(fromDate, toDate);
  const monthlyCosts = useLogisticaMonthlyCosts(yearMonth);
  const pautaDiariaTotal = sumAdSpend(adQuery.data ?? []).total;
  const pautaMensualGuardada =
    (monthlyCosts.data?.pauta_meta ?? 0) + (monthlyCosts.data?.pauta_tiktok ?? 0);
  const pautaFromDaily = pautaDiariaTotal > 0;
  const pautaEfectiva = pautaFromDaily ? pautaDiariaTotal : pautaMensualGuardada;
  // Un error REAL leyendo la bitácora NO es "pauta $0": restar $0 en silencio
  // infla el neto sin señal. Migration sin aplicar (isRpcMissing) sí degrada al
  // fallback mensual, como siempre. Mismo principio que en MesActualResumen.
  const pautaSinDato = adQuery.isError && !isRpcMissing(adQuery.error);
  // Cobertura de la bitácora: un día sin anotar entra como $0 al neto — si
  // faltan muchos, el neto sale inflado y hay que decirlo en la cara.
  const diasConPauta = new Set((adQuery.data ?? []).map((r) => r.spend_date)).size;
  const diasPeriodo = (() => {
    const hoy = new Date().toLocaleDateString('en-CA');
    const hasta = toDate < hoy ? toDate : hoy;
    const f = new Date(`${fromDate}T12:00:00Z`);
    const t = new Date(`${hasta}T12:00:00Z`);
    if (isNaN(f.getTime()) || isNaN(t.getTime()) || t < f) return 0;
    return Math.round((t.getTime() - f.getTime()) / 86400000) + 1;
  })();
  const pautaLoading = adQuery.isLoading || monthlyCosts.isLoading;

  if (isError) {
    return (
      <div className="relative flex flex-col sm:flex-row sm:items-center gap-3 rounded-2xl border border-danger/30 bg-danger/10 px-4 pl-5 py-3 shadow-card3d">
        <span className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-danger" aria-hidden="true" />
        <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 bg-danger/20 glow-danger">
          <AlertTriangle size={18} className="text-danger" aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-xs font-semibold text-danger">No pudimos cargar las finanzas</h3>
          <p className="text-[10px] text-muted-foreground mt-0.5 font-mono">
            {(error as Error)?.message ?? 'Error desconocido'}
          </p>
        </div>
      </div>
    );
  }

  const loading = isLoading || gananciaLoading || (isSingleMonth && cohorte.isLoading);

  const fleteCombinado = (data?.flete_entregadas ?? 0) + (data?.flete_devoluciones ?? 0);
  const fleteDevs = data?.flete_devoluciones ?? 0;
  const cargoExtra = data?.costo_devoluciones ?? 0;
  const perdidaTotalDevs = fleteDevs + cargoExtra;
  const totalDevs = data?.total_devueltas ?? 0;
  // Sin Math.round: en EC estos promedios son USD de un dígito y el redondeo
  // se comía los centavos (formatCOP ya resuelve los decimales por país).
  const promedioDev = totalDevs > 0 ? perdidaTotalDevs / totalDevs : 0;
  const utilidad = data?.utilidad_bruta ?? 0;

  // Tasa de entrega MADURA: ÷ (entregadas + devueltas), no ÷ total_ordenes (que
  // incluye cancelados, pendientes y en-tránsito → diluye la tasa en rangos
  // recientes). El donut de al lado sigue mostrando la composición sobre el total.
  //
  // El `total` (madurez del cohorte) va SIN cancelados: un cancelado jamás va a
  // concluir logísticamente, así que dejarlo en el denominador subestimaba
  // pctConcluido para siempre — un mes cerrado hace meses con 32% de
  // cancelación quedaba "prelim." eterno mientras KPIs mensuales (que ya usa
  // despachables = generados − cancelados, y lo documenta) lo mostraba firme.
  const entregaMaturity = deriveDeliveryMaturity(
    data?.total_entregadas ?? 0, data?.total_devueltas ?? 0,
    Math.max(0, (data?.total_ordenes ?? 0) - (data?.total_cancelados ?? 0)),
    data?.total_rechazadas ?? 0,
  );

  const gn = gananciaNeta?.ganancia_neta ?? 0;
  const totalEntradas = gananciaNeta?.total_entradas ?? 0;
  const totalSalidas = gananciaNeta?.total_salidas ?? 0;
  const ingresosBrutos = data?.ingresos_brutos ?? 0;

  // Hero "Ganancia Neta": cohorte si está disponible (operativo real del mes),
  // si no la caja del wallet (gn). heroEntradas/heroSalidas siguen la misma base
  // que el valor, para que el desglose in/out cuadre con la cifra mostrada.
  const usingCohort = isSingleMonth && cohorte.data?.operativo != null;
  const operativoReal = usingCohort ? cohorte.data!.operativo : gn;
  const heroEntradas = usingCohort ? cohorte.data!.total_entradas : totalEntradas;
  const heroSalidas = usingCohort ? cohorte.data!.total_salidas : totalSalidas;
  // Margen aproximado: operativoReal / ingresosBrutos. OJO ventanas temporales:
  // en modo cohorte el numerador va por fecha de PEDIDO (creados en el mes) y el
  // denominador (ingresosBrutos de financial_summary) por entregados del período.
  // No son la misma cohorte exacta — es un margen indicativo, no contable preciso.
  const margenPct = ingresosBrutos > 0 ? (operativoReal / ingresosBrutos) * 100 : 0;

  // Sección "Pauta y neto": lo que queda después de pagar la publicidad.
  // Con pautaSinDato NADA se calcula — '—' antes que restar $0 en silencio.
  const totalEntregadasN = data?.total_entregadas ?? 0;
  const netoDespuesPauta = operativoReal - pautaEfectiva;
  // Sin dividir por cero ni redondear acá: formatCOP resuelve la moneda de la
  // tienda (EC imprime USD con centavos — un Math.round se los comería).
  const cpaReal =
    !pautaSinDato && pautaEfectiva > 0 && totalEntregadasN > 0
      ? pautaEfectiva / totalEntregadasN
      : null;
  const pautaIncompleta = pautaFromDaily && diasPeriodo > 0 && diasConPauta < diasPeriodo;
  // El fallback mensual (logistica_monthly_costs) trae solo el mes de fromDate:
  // en rangos multi-mes cubre una fracción del período.
  const pautaFallbackParcial =
    !pautaFromDaily && pautaMensualGuardada > 0 && yearMonth !== toDate.slice(0, 7);

  const desglose = gananciaNeta?.desglose;
  const ingresosItems: ComposicionItem[] = [
    { label: 'Dropi te paga por entregar (markup)', value: desglose?.ganancia_dropshipper ?? 0, color: 'hsl(var(--success))' },
    { label: 'Ganancia como proveedor (markup)',    value: desglose?.ganancia_proveedor ?? 0,   color: 'hsl(var(--success))' },
    { label: 'Reembolso flete',                     value: desglose?.reembolso_flete ?? 0,      color: 'hsl(var(--info))' },
    { label: 'Indemnizaciones',                     value: desglose?.indemnizacion ?? 0,        color: 'hsl(var(--accent))' },
  ];

  // 'Cargo extra Dropi' representa el costo_devolucion del wallet (~$22k típico
  // cuando NO entrega) — se nombra así para evitar confusión con la KPI "Pérdida
  // por devoluciones" que suma flete_devs + cargo_extra.
  // 'Comisión referidos' vuelve a la lista (auditoría 2026-07-02): el total
  // "Salidas" SÍ la incluye, y sin el ítem la composición no sumaba el total.
  // ComposicionList filtra los <= 0, así que en tiendas sin referidos no aparece.
  const gastosItems: ComposicionItem[] = [
    { label: 'Flete inicial',          value: desglose?.flete_inicial ?? 0,         color: 'hsl(var(--warning))' },
    { label: 'Cargo extra Dropi',      value: desglose?.costo_devolucion ?? 0,      color: 'hsl(var(--danger))', sublabel: 'Por entregas fallidas' },
    { label: 'Comisión referidos',     value: desglose?.comision_referidos ?? 0,    color: 'hsl(var(--muted-foreground))' },
    { label: 'Mantenimiento tarjeta',  value: desglose?.mantenimiento_tarjeta ?? 0, color: 'hsl(var(--muted-foreground))' },
    { label: 'Orden sin recaudo',      value: desglose?.orden_sin_recaudo ?? 0,     color: 'hsl(var(--danger))', sublabel: 'cargo cuando el pedido aún no recaudó' },
  ];

  return (
    <div className="space-y-5">
      {/* Banner "cómo leer" — recipe "banner de estado con barra lateral" */}
      <motion.div
        {...fadeUp(0)}
        className="relative rounded-2xl border border-info/30 bg-info/10 px-4 pl-5 py-3 shadow-card3d"
      >
        <span className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-info" aria-hidden="true" />
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 bg-info/20 glow-info">
            <Info size={17} className="text-info" aria-hidden="true" />
          </div>
          <div className="space-y-1 flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <h3 className="text-sm font-semibold text-foreground">
                Cómo leer esta pestaña
              </h3>
              <div className="flex items-center gap-2">
                {/* Frescura del wallet (scopeada a la tienda activa): si está vieja,
                    la Ganancia Neta de abajo no es de fiar. */}
                <WalletSyncBadge size="sm" showLabel />
                {isOwnerOfActive && (
                  <Button
                    onClick={() => resumenSync.mutate({ from: fromDate, untill: toDate })}
                    disabled={resumenSync.isPending}
                    size="sm"
                    variant="outline"
                  >
                    <RefreshCw size={14} className={`mr-1.5 ${resumenSync.isPending ? 'animate-spin' : ''}`} />
                    {resumenSync.isPending ? 'Sincronizando…' : 'Sincronizar'}
                  </Button>
                )}
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {/* La primera frase depende de QUÉ está mostrando el hero: solo en
                  rangos de un mes calendario completo es "los pedidos que creaste
                  en el mes"; en cualquier otro rango es la caja del wallet — decir
                  lo primero siempre sería mentirle al que filtró 3 meses. */}
              {usingCohort ? (
                <>La <strong className="text-foreground">Ganancia Neta</strong> grande es de los pedidos que <strong className="text-foreground">CREASTE</strong> en el mes — cuadra con la Utilidad de Dropi. </>
              ) : (
                <>La <strong className="text-foreground">Ganancia Neta</strong> grande acá es la plata que se movió en el wallet en este rango. Elegí un solo mes calendario para verla por pedidos creados en el mes (así cuadra con la Utilidad de Dropi). </>
              )}
              La composición y el wallet de abajo van por fecha de <strong className="text-foreground">PAGO</strong>, así que mezclan pedidos de meses anteriores. La pauta ahora sí se muestra (tarjeta más abajo).
            </p>
          </div>
        </div>
      </motion.div>

      {/* Aviso: la Ganancia Neta falló al cargar (error transitorio, NO "sin datos").
          Sin esto un socio veía $0 en silencio, indistinguible de un mes real sin
          ganancia. El hook ya distingue error de "función no desplegada". */}
      {gananciaError && !gananciaLoading && (
        <motion.div
          {...fadeUp(0.03)}
          className="relative flex items-center gap-3 rounded-2xl border border-danger/30 bg-danger/10 px-4 pl-5 py-3 shadow-card3d"
        >
          <span className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-danger" aria-hidden="true" />
          <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 bg-danger/20 glow-danger">
            <Info size={17} className="text-danger" aria-hidden="true" />
          </div>
          <span className="text-[11px] leading-relaxed text-foreground flex-1 min-w-0">
            No se pudo cargar la <strong>Ganancia Neta</strong> (error temporal, reintentando). El número de abajo puede no ser real — tocá <strong>Sincronizar</strong> o recargá.
          </span>
        </motion.div>
      )}

      {/* Movimientos del wallet SIN CLASIFICAR ('otro'): el unico modo de falla
          que el badge de salud NO puede ver — el sync queda verde pero esos
          movimientos NO entran a la Ganancia Neta (la RPC y el hook los
          excluyen). Si Dropi renombra un codigo, la ganancia se desvia en
          silencio; este banner es la alarma. Solo lo ve el admin (el SELECT
          es admin-only por RLS y el hook devuelve null para un socio). */}
      {(sinClasificar?.count ?? 0) > 0 && (
        <motion.div
          {...fadeUp(0.03)}
          className="relative flex items-center gap-3 rounded-2xl border border-warning/30 bg-warning/10 px-4 pl-5 py-3 shadow-card3d"
        >
          <span className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-warning" aria-hidden="true" />
          <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 bg-warning/20">
            <Info size={17} className="text-warning" aria-hidden="true" />
          </div>
          <span className="text-[11px] leading-relaxed text-foreground flex-1 min-w-0">
            <strong>{sinClasificar!.count} movimiento(s) del wallet sin clasificar</strong> por{' '}
            <strong>{sinClasificar!.montoParcial ? '≥ ' : ''}{formatCOP(sinClasificar!.monto)}</strong> en este rango.
            Suele pasar cuando Dropi cambia el texto de un código.
            Avisá para clasificarlos — mientras tanto no entran en la ganancia.
          </span>
        </motion.div>
      )}

      {loading ? (
        <>
          {/* Los skeletons calcan la GEOMETRÍA real de lo que va a llegar
              (hero 5/4/3, fila de pauta de 3, dos charts, grid de 7) para que
              no haya salto de layout cuando resuelven los hooks. */}
          <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
            <div className="md:col-span-5 rounded-3xl border border-border bg-card/40 shadow-card3d-lg animate-pulse h-[196px]" />
            <div className="md:col-span-4 rounded-2xl border border-border bg-card/40 shadow-card3d animate-pulse h-[196px]" />
            <div className="md:col-span-3 rounded-2xl border border-border bg-card/40 shadow-card3d animate-pulse h-[196px]" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="rounded-2xl border border-border bg-card/40 shadow-card3d hairline-top animate-pulse h-[132px]" />
            ))}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded-2xl border border-border bg-card/40 shadow-card3d hairline-top animate-pulse h-[340px]" />
            <div className="rounded-2xl border border-border bg-card/40 shadow-card3d hairline-top animate-pulse h-[340px]" />
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="rounded-2xl border border-border bg-card/40 shadow-card3d hairline-top animate-pulse h-[132px]" />
            ))}
          </div>
        </>
      ) : (
        <>
          {/* 1. Hero strip */}
          <motion.div {...fadeUp(0.05)}>
            <FinanzasHero
              gananciaNeta={operativoReal}
              totalEntradas={heroEntradas}
              totalSalidas={heroSalidas}
              ingresosBrutos={ingresosBrutos}
              totalEntregadas={data?.total_entregadas ?? 0}
              margenPct={margenPct}
              cohorte={usingCohort}
            />
          </motion.div>

          {/* 1b. Pauta y neto — client-side puro sobre la bitácora de pauta.
              La regla de la casa manda: si la lectura falla, las tres tarjetas
              van en '—' — NUNCA se resta $0 en silencio (cero no sustituye a
              "no se pudo medir"). */}
          <motion.div {...fadeUp(0.08)} className="flex items-end justify-between gap-3 pt-1">
            <h3 className="hud-label">Pauta y neto</h3>
            {pautaSinDato && (
              <span className="text-[10px] text-warning">
                No se pudo leer tu pauta — sin ese dato no restamos nada.
              </span>
            )}
          </motion.div>
          <motion.div {...fadeUp(0.1)} className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {pautaLoading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="rounded-2xl border border-border bg-card/40 shadow-card3d hairline-top animate-pulse h-[132px]" />
              ))
            ) : (
              <>
                <KpiCard
                  label="Pauta del período"
                  value={pautaSinDato ? '—' : formatCOP(pautaEfectiva)}
                  icon={Megaphone}
                  tone={pautaIncompleta || pautaFallbackParcial ? 'warning' : 'neutral'}
                  hint={
                    pautaSinDato ? 'no se pudo leer tu pauta'
                    : pautaFromDaily ? `${diasConPauta} de ${diasPeriodo} días anotados${pautaIncompleta ? ' — pueden faltar días' : ''}`
                    // El fallback mensual trae UN solo mes (el de la fecha
                    // inicial): en un rango de 90 días eso subresta pauta y el
                    // neto/CPA salen optimistas — se dice en la cara.
                    : pautaFallbackParcial ? `solo la pauta guardada de ${yearMonth} — el rango cruza varios meses`
                    : pautaEfectiva > 0 ? 'valor mensual guardado (sin detalle por día)'
                    : 'sin pauta anotada en este rango'
                  }
                />
                <KpiCard
                  label="Neto después de pauta"
                  value={pautaSinDato ? '—' : formatCOP(netoDespuesPauta)}
                  icon={PiggyBank}
                  tone={pautaSinDato ? 'neutral' : netoDespuesPauta >= 0 ? 'success' : 'danger'}
                  hint={
                    pautaSinDato ? 'no se pudo leer tu pauta'
                    : pautaEfectiva > 0 ? 'la Ganancia Neta de arriba menos la pauta'
                    : 'sin pauta anotada — igual a la Ganancia Neta de arriba'
                  }
                />
                <KpiCard
                  label="CPA real"
                  value={cpaReal == null ? '—' : formatCOP(cpaReal)}
                  icon={Crosshair}
                  tone={cpaReal == null || entregaMaturity.inmaduro ? 'neutral' : 'info'}
                  hint={
                    pautaSinDato ? 'no se pudo leer tu pauta'
                    // Cohorte inmaduro: la pauta ya se gastó completa pero la
                    // mayoría de los pedidos sigue viajando → el denominador
                    // está incompleto y el CPA sale ALTO; baja solo al madurar.
                    // Mismo criterio que el "(prelim.)" de la tasa de entrega.
                    : entregaMaturity.inmaduro ? 'pauta ÷ entregas del período · prelim. — aún hay pedidos en camino, va a bajar'
                    : 'pauta ÷ entregas del período'
                  }
                />
              </>
            )}
          </motion.div>

          {/* 2. Donut + Cash flow */}
          <motion.div {...fadeUp(0.12)} className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <EstadoOrdenesDonut
              totalOrdenes={data?.total_ordenes ?? 0}
              entregadas={data?.total_entregadas ?? 0}
              devueltas={data?.total_devueltas ?? 0}
              canceladas={data?.total_cancelados ?? 0}
              tasaEntregaMadura={entregaMaturity.tasaEntregaMadura}
              tasaPreliminar={entregaMaturity.inmaduro}
            />
            <CashFlowChart
              series={dailySeries ?? []}
              isLoading={seriesLoading}
              isError={seriesError}
            />
          </motion.div>

          {/* 3. Composición ingresos + gastos */}
          <motion.div {...fadeUp(0.15)} className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <ComposicionList
              title="Composición de ingresos"
              total={totalEntradas}
              totalLabel="Entradas"
              totalTone="success"
              icon={ArrowDownToLine}
              items={ingresosItems}
              emptyMessage="Sin ingresos en el período"
            />
            <ComposicionList
              title="Composición de gastos"
              total={totalSalidas}
              totalLabel="Salidas"
              totalTone="danger"
              icon={ArrowUpFromLine}
              items={gastosItems}
              emptyMessage="Sin gastos en el período"
            />
          </motion.div>

          {/* 4. KPI grid secundario */}
          <motion.div {...fadeUp(0.18)} className="flex items-end justify-between gap-3 pt-1">
            <h3 className="hud-label">
              Métricas detalladas
            </h3>
            <span className="text-[10px] text-muted-foreground">Vista contable + operativa</span>
          </motion.div>
          {/* "Ingresos brutos" ya NO va acá: duplicaba la tercera card del hero
              (mismo número dos veces en la misma pantalla = ruido). */}
          <motion.div {...fadeUp(0.2)} className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <KpiCard
              label="COGS (costo producto)"
              value={formatCOP(data?.cogs ?? 0)}
              icon={Package}
              tone="warning"
              hint="lo que cobra el proveedor por el producto"
            />
            <KpiCard
              label="Flete (entregados + devs.)"
              value={formatCOP(fleteCombinado)}
              icon={Truck}
              tone="warning"
              hint={`Entregadas: ${formatCOP(data?.flete_entregadas ?? 0)} · Devs: ${formatCOP(fleteDevs)}`}
            />
            <KpiCard
              label="Pérdida por devoluciones"
              value={formatCOP(perdidaTotalDevs)}
              icon={RotateCcw}
              tone="danger"
              hint={`${totalDevs} devs — promedio ${formatCOP(promedioDev)} c/u`}
            />
            <KpiCard
              label="Cancelados"
              value={formatCOP(data?.valor_cancelado ?? 0)}
              icon={Ban}
              tone="danger"
              hint={`${data?.total_cancelados ?? 0} órdenes (${
                // null/undefined → '—': si la RPC desplegada no trae el campo,
                // "0.0%" sería un dato inventado, no un dato en cero.
                data?.tasa_cancelacion_pct == null ? '—' : `${data.tasa_cancelacion_pct.toFixed(1)}%`
              }) — valor potencial perdido`}
            />
            <KpiCard
              label="Utilidad bruta contable"
              value={formatCOP(utilidad)}
              icon={utilidad >= 0 ? TrendingUp : TrendingDown}
              tone="neutral"
              hint="Ingresos − COGS − flete − devs (incluye COGS aunque Dropi lo pague directo al proveedor). OJO: devoluciones/comisiones se cuentan por fecha de PAGO del wallet e ingresos por fecha de CREACIÓN del pedido → en bordes de mes (fin/inicio) puede quedar inflada o subestimada."
            />
            <KpiCard
              label="Ganancia markup"
              value={formatCOP(data?.ganancia_markup ?? 0)}
              icon={Sparkles}
              tone="success"
              hint="Informativo — pendiente sanity check para sumar a utilidad"
            />
            <KpiCard
              label="Tasa de entrega"
              value={entregaMaturity.tasaEntregaMadura == null ? '—' : `${entregaMaturity.tasaEntregaMadura}%`}
              icon={Target}
              tone={entregaMaturity.inmaduro ? 'neutral'
                : (entregaMaturity.tasaEntregaMadura ?? 0) >= 60 ? 'success' : 'warning'}
              hint={`${data?.total_entregadas ?? 0} de ${entregaMaturity.resueltos} concluidas · ${entregaMaturity.pctConcluido}% del total${entregaMaturity.inmaduro ? ' (prelim.)' : ''}`}
            />
          </motion.div>

          {/* Notas al pie del grid — metadatos, no cifras: van al ritmo
              text-[10px] del lenguaje, no en itálica de 12px. */}
          <motion.div {...fadeUp(0.21)} className="space-y-1.5">
            {/* Mini-info: desglose pérdida devoluciones */}
            <div className="text-[10px] text-muted-foreground">
              Pérdida devoluciones = Flete de ida ({formatCOP(fleteDevs)}) + Cargo extra Dropi ({formatCOP(cargoExtra)})
            </div>

            {/* Disclaimer ganancia markup */}
            <div className="text-[10px] text-muted-foreground leading-relaxed">
              Nota: <strong>Ganancia Markup</strong> aparece como referencia. Aún no se suma a la utilidad bruta hasta confirmar (con sanity check) que no genera doble conteo con `cobro_entrega`. Una vez confirmado, lo sumamos.
            </div>
          </motion.div>

          {/* Conciliacion: la cifra de arriba dice CUANTO costaron las
              devoluciones; esta dice si estan TODAS. Va pegada a proposito —
              una perdida por devoluciones sin respaldo verificado es una cifra
              que no se puede defender. */}
          <ConciliacionDevolucionesCard fromDate={fromDate} toDate={toDate} />

          {/* 5. Volumen + ticket promedio.
              Los tres contadores eran cifras sueltas dentro de una card: dos
              gramáticas de KPI en la misma pantalla. Ahora son el MISMO KpiCard
              del grid de arriba (size sm), así que "Órdenes totales" se lee
              igual que "Ingresos brutos". Ticket promedio entra en la misma
              fila en vez de quedar de card huérfana al costado. */}
          <motion.div {...fadeUp(0.22)} className="flex items-end justify-between gap-3 pt-1">
            <h3 className="hud-label">
              Volumen de operación
            </h3>
          </motion.div>
          <motion.div {...fadeUp(0.23)} className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <KpiCard
              label="Órdenes totales"
              value={String(data?.total_ordenes ?? 0)}
              icon={Package}
              tone="neutral"
              size="sm"
            />
            <KpiCard
              label="Entregadas"
              value={String(data?.total_entregadas ?? 0)}
              icon={CheckCircle2}
              tone="success"
              size="sm"
            />
            <KpiCard
              label="Devueltas"
              value={String(data?.total_devueltas ?? 0)}
              icon={RotateCcw}
              tone="danger"
              size="sm"
            />
            <KpiCard
              label="Ticket promedio"
              value={formatCOP(data?.ticket_promedio ?? 0)}
              icon={Receipt}
              tone="info"
              size="sm"
              hint="Promedio por pedido entregado"
            />
          </motion.div>

          {/* 6. Wallet neto */}
          <motion.div {...fadeUp(0.24)}>
            <TiltCard className="bg-card/40 border border-border rounded-2xl p-5 shadow-card3d transition-colors duration-200 hover:border-border-strong">
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-3 min-w-0 tilt-layer-1">
                  <span className={`w-9 h-9 rounded-xl border flex items-center justify-center flex-shrink-0 ${
                    gn >= 0
                      ? 'bg-success/14 border-success/30 text-success glow-success'
                      : 'bg-danger/14 border-danger/30 text-danger glow-danger'
                  }`}>
                    <Wallet size={17} aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-foreground">Wallet neto del período</div>
                    <div className="text-[10px] text-muted-foreground leading-relaxed mt-0.5">
                      la misma caja del rango, en neto — no es la ganancia del mes. Entradas − salidas operativas de Dropi, igual al neto de la composición de arriba.
                    </div>
                  </div>
                </div>
                {/* Caja operativa real del wallet = gn (= totalEntradas − totalSalidas del
                    hook useGananciaNetaDropi, mismo origen que la composición). NO usamos
                    data.wallet_neto del RPC financial_summary: ese suma TODOS los movimientos
                    (incluye tesorería: retiros/depósitos), así que no cuadra con la
                    composición ni con el label de esta card. Ver review fix-first 2026-06-24. */}
                <div
                  className={`font-mono tabular-nums text-2xl font-bold leading-none shrink-0 tilt-layer-3 ${
                    gn >= 0 ? 'text-success num-glow-success' : 'text-danger num-glow-danger'
                  }`}
                >
                  {formatCOP(gn)}
                </div>
              </div>
            </TiltCard>
          </motion.div>
        </>
      )}
    </div>
  );
}

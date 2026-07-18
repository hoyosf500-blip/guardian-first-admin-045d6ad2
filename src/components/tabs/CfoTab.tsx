import { useMemo, useState } from 'react';
import {
  TrendingUp, TrendingDown, Minus, AlertTriangle, AlertCircle,
  CheckCircle2, DollarSign, Wallet, Target, Zap, Pencil, Loader2,
  Package as PackageIcon,
  Gauge, Megaphone, CreditCard, BookOpen,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { useFinancialSummary } from '@/hooks/useFinancialSummary';
import { useLogisticsStats } from '@/hooks/useLogisticsStats';
import { useWalletMovements } from '@/hooks/useWalletMovements';
import {
  useMonthlyBusinessInputs,
  useCostosFijosMensuales,
} from '@/hooks/useCfoMonthlyInputs';
import { useMonthlyAdSpend } from '@/hooks/useMonthlyAdSpend';
import { useSessionState } from '@/hooks/useSessionState';
import CfoInputsDialog from '@/components/cfo/CfoInputsDialog';
import CfoDebtTracker from '@/components/cfo/CfoDebtTracker';
import CfoAdSpendTracker from '@/components/cfo/CfoAdSpendTracker';
import CfoPersonalCardUploader from '@/components/cfo/CfoPersonalCardUploader';
import CfoPersonalSpendingTracker from '@/components/cfo/CfoPersonalSpendingTracker';
import CfoPaymentsVsDebt from '@/components/cfo/CfoPaymentsVsDebt';
import CfoPagosHistorico from '@/components/cfo/CfoPagosHistorico';
import CfoMonthlyRetrospective from '@/components/cfo/CfoMonthlyRetrospective';
import WalletSyncBadge from '@/components/wallet/WalletSyncBadge';
import WalletSyncButton from '@/components/wallet/WalletSyncButton';
import { useWalletSyncHealth } from '@/hooks/useWalletSyncHealth';
import { useStore } from '@/contexts/StoreContext';
import { TiltCard } from '@/components/ui3d';
import { formatCOP } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

// ─────────────────────────────────────────────────────────────────
// /cfo "Cómo voy" — vista del dueño. Reusa todas las RPCs admin que
// ya existen (financial_summary, logistics_summary, wallet_summary,
// logistics_by_product) y agrega los inputs manuales mensuales para
// calcular la UTILIDAD NETA REAL del mes.
//
// Cada bloque compara MES SELECCIONADO vs MES ANTERIOR.
// ─────────────────────────────────────────────────────────────────

function toYearMonth(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthRange(yearMonth: string): { from: string; to: string } {
  const [y, m] = yearMonth.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const last = new Date(y, m, 0); // día 0 del mes siguiente = último día del mes
  return {
    from: `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, '0')}-01`,
    to: `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`,
  };
}

function previousMonth(yearMonth: string): string {
  const [y, m] = yearMonth.split('-').map(Number);
  const d = new Date(y, m - 2, 1);
  return toYearMonth(d);
}

/**
 * Meses desde enero del año actual hasta el mes actual, en orden
 * descendente (más reciente primero). Evita mostrar meses del año pasado
 * cuando el negocio arrancó este año — Fabian se confundía viendo opciones
 * de 2024/2023 en el dropdown.
 */
function monthsFromJanuaryThisYear(): string[] {
  const now = new Date();
  const year = now.getFullYear();
  const currentMonth = now.getMonth(); // 0-11
  const out: string[] = [];
  for (let m = currentMonth; m >= 0; m--) {
    out.push(toYearMonth(new Date(year, m, 1)));
  }
  return out;
}

function monthLabel(yearMonth: string): string {
  const [y, m] = yearMonth.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('es-CO', {
    month: 'long', year: 'numeric',
  });
}

// HONESTIDAD DE DATOS: todo lo que sale de una RPC es `| null`.
// null = "no lo pudimos medir" (RPC caída, tienda sin resolver, período sin
// filas). NUNCA se colapsa a 0 con `?? 0`: un 0 en plata se lee como medición
// y acá se resta de la pauta/costos fijos → fabricaba una PÉRDIDA en pesos que
// nadie midió. La UI pinta "—" en tono neutro cuando el valor es null.
interface CfoSnapshot {
  loading: boolean;
  /** financial_summary no respondió → el P&L entero es incalculable. Corta el render. */
  hasFinError: boolean;
  /** costos fijos / inputs manuales / pauta no se pudieron leer → utilidad_neta = null. */
  hasInputsError: boolean;
  /** cayeron LAS DOS fuentes de pauta (granular + manual) → el gasto es desconocido. */
  ads_error: boolean;
  /** monthly_business_inputs no respondió → intereses de tarjeta desconocidos. */
  tarjeta_error: boolean;
  errorMessage: string | null;
  total_ordenes: number | null;
  total_entregadas: number | null;
  total_devueltas: number | null;
  total_cancelados: number | null;
  tasa_entrega: number | null;
  utilidad_bruta: number | null;
  ingresos_brutos: number | null;
  ads_meta: number;
  ads_tiktok: number;
  ads_total: number;
  /** null = no se pudo leer app_settings. 0 = leído pero sin configurar. */
  costos_fijos: number | null;
  /** costos fijos leídos pero en 0 → la utilidad neta queda sobreestimada. */
  costos_fijos_sin_cargar: boolean;
  tarjeta_interes: number;
  tarjeta_pago: number;
  utilidad_neta: number | null;
  roas: number | null;
  wallet_saldo: number | null;
  has_inputs: boolean;
  notas: string | null;
}

function useCfoSnapshot(yearMonth: string): CfoSnapshot {
  const range = useMemo(() => monthRange(yearMonth), [yearMonth]);
  const finQuery = useFinancialSummary(range.from, range.to);
  // T3-5: disableRealtime — useCfoSnapshot se monta 2 veces (curr + prev).
  // Solo el mount de logForProducts en CfoTab mantiene el canal único.
  const logQuery = useLogisticsStats({ fromDate: range.from, toDate: range.to }, { disableRealtime: true });
  const walletQuery = useWalletMovements({
    fromDate: range.from, toDate: range.to, page: 1, pageSize: 1,
  });
  const inputsQuery = useMonthlyBusinessInputs(yearMonth);
  const costosQuery = useCostosFijosMensuales();
  // Pauta REAL del mes (rows por cuenta en monthly_ad_spend). Tiene
  // prioridad sobre los campos `ads_meta`/`ads_tiktok` de
  // monthly_business_inputs (que son legacy/manual). Si querés cambiar
  // un valor, hacelo en el AdSpendTracker — el P&L se recalcula solo.
  const adSpendQuery = useMonthlyAdSpend(yearMonth);

  const loading =
    finQuery.isLoading || logQuery.summary.isLoading ||
    walletQuery.isLoading || inputsQuery.isLoading || costosQuery.isLoading ||
    adSpendQuery.isLoading;

  // financial_summary es la fuente de TODA la plata del P&L. useFinancialSummary
  // LANZA a propósito cuando el RPC falla o cuando no hay tienda activa resuelta
  // ("Sin tienda activa..."), justamente para que la pantalla pinte un banner en
  // vez de ceros. Antes acá nadie miraba isError → fin=undefined, isLoading=false
  // y `?? 0` convertía la caída en "UTILIDAD NETA REAL -$3.500.000" en rojo.
  const hasFinError = finQuery.isError;
  // Estos tres alimentan la RESTA de la utilidad neta. Si alguno no cargó, el
  // término desaparece en silencio y la utilidad sale INFLADA hacia arriba.
  const hasInputsError =
    costosQuery.isError || inputsQuery.isError || adSpendQuery.isError;
  const errorMessage =
    (finQuery.error as Error | null)?.message ??
    (costosQuery.error as Error | null)?.message ??
    (inputsQuery.error as Error | null)?.message ??
    (adSpendQuery.error as Error | null)?.message ??
    null;

  const fin = finQuery.data;
  const logSummary = logQuery.summary.data;
  const inputs = inputsQuery.data;
  // `?? null` (no `?? 0`): una query deshabilitada (sin tienda activa) o caída
  // deja data=undefined con isLoading=false. 0 sería una cifra inventada.
  const costos_fijos = costosQuery.data ?? null;
  const costos_fijos_sin_cargar = costos_fijos === 0;

  const adsByPlatform = (adSpendQuery.data ?? []).reduce(
    (acc, r) => {
      if (r.platform === 'meta')        acc.meta   += r.amount_cop;
      else if (r.platform === 'tiktok') acc.tiktok += r.amount_cop;
      return acc;
    },
    { meta: 0, tiktok: 0 },
  );
  // Granular (monthly_ad_spend) tiene prioridad. Si está vacío, fallback
  // al input manual viejo para no romper meses sin seeds.
  const ads_meta   = adsByPlatform.meta   > 0 ? adsByPlatform.meta   : (inputs?.ads_meta   ?? 0);
  const ads_tiktok = adsByPlatform.tiktok > 0 ? adsByPlatform.tiktok : (inputs?.ads_tiktok ?? 0);
  const ads_total = ads_meta + ads_tiktok;
  // La pauta tiene cadena de fallback (granular → manual): solo es DESCONOCIDA
  // si cayeron las dos fuentes. Los intereses salen únicamente de los inputs.
  const ads_error = adSpendQuery.isError && inputsQuery.isError;
  const tarjeta_error = inputsQuery.isError;
  const tarjeta_interes = inputs?.tarjeta_interes ?? 0;
  const tarjeta_pago = inputs?.tarjeta_pago ?? 0;

  // Sin la fila de financial_summary no hay utilidad bruta que reportar.
  const utilidad_bruta = fin ? fin.utilidad_bruta : null;
  const ingresos_brutos = fin ? fin.ingresos_brutos : null;
  // La FÓRMULA no cambia (bruta − pauta − costos fijos − intereses); lo que
  // cambia es que solo se calcula cuando TODOS sus términos existen de verdad.
  const utilidad_neta =
    utilidad_bruta != null && costos_fijos != null && !hasInputsError
      ? utilidad_bruta - ads_total - costos_fijos - tarjeta_interes
      : null;

  const roas: number | null =
    ads_total > 0 && ingresos_brutos != null ? ingresos_brutos / ads_total : null;

  // Se preserva el orden de fallback original (fin → logistics); solo se
  // reemplaza el `?? 0` final por `?? null`.
  const total_ordenes = fin?.total_ordenes ?? logSummary?.total_pedidos ?? null;
  // DENOMINADOR CERO: el RPC calcula tasa_entrega_pct = entregadas/total_ordenes
  // y devuelve 0 cuando total_ordenes = 0 (CASE WHEN ... ELSE 0, migration
  // 20260707120000). Ese 0 es 0/0, no una medición, y acá se pintaba rojo con la
  // alerta "Efectividad baja: 0% (umbral 55%)" en un mes donde no hubo un solo
  // pedido que medir. Con pedidos en el período un 0% SÍ es real y sigue en rojo.
  const tasa_raw = fin?.tasa_entrega_pct ?? logSummary?.tasa_entrega ?? null;
  const tasa_entrega = total_ordenes === 0 ? null : tasa_raw;

  return {
    loading,
    hasFinError, hasInputsError, ads_error, tarjeta_error, errorMessage,
    total_ordenes,
    total_entregadas: fin?.total_entregadas ?? logSummary?.entregados ?? null,
    total_devueltas: fin?.total_devueltas ?? logSummary?.devueltos ?? null,
    total_cancelados: fin?.total_cancelados ?? null,
    tasa_entrega,
    utilidad_bruta, ingresos_brutos,
    ads_meta, ads_tiktok, ads_total,
    costos_fijos, costos_fijos_sin_cargar, tarjeta_interes, tarjeta_pago,
    utilidad_neta, roas,
    wallet_saldo: walletQuery.data?.ultimoSaldo ?? null,
    has_inputs: Boolean(inputs),
    notas: inputs?.notas ?? null,
  };
}

function fmtPct(n: number): string {
  return `${Math.round(n)}%`;
}

function deltaArrow(curr: number, prev: number, opts?: { higherIsBetter?: boolean }) {
  const better = opts?.higherIsBetter ?? true;
  if (prev === 0 && curr === 0) {
    return { Icon: Minus, tone: 'text-muted-foreground', label: '—' };
  }
  if (prev === 0) {
    return curr > 0
      ? { Icon: TrendingUp, tone: better ? 'text-green' : 'text-red', label: 'nuevo' }
      : { Icon: Minus, tone: 'text-muted-foreground', label: '—' };
  }
  const delta = ((curr - prev) / Math.abs(prev)) * 100;
  if (Math.abs(delta) < 0.5) {
    return { Icon: Minus, tone: 'text-muted-foreground', label: '—' };
  }
  const up = delta > 0;
  const good = up === better;
  return {
    Icon: up ? TrendingUp : TrendingDown,
    tone: good ? 'text-green' : 'text-red',
    label: `${up ? '+' : ''}${delta.toFixed(0)}%`,
  };
}

// Los umbrales NO cambian. Lo único que se agrega es el caso null → 'muted':
// sin dato no hay veredicto, y el rojo diría "está mal" sobre algo que nadie midió.
function utilidadTone(v: number | null): 'success' | 'warning' | 'danger' | 'muted' {
  if (v == null) return 'muted';
  if (v > 0) return 'success';
  if (v === 0) return 'warning';
  return 'danger';
}
function efectividadTone(v: number | null): 'success' | 'warning' | 'danger' | 'muted' {
  if (v == null) return 'muted';
  if (v >= 65) return 'success';
  if (v >= 55) return 'warning';
  return 'danger';
}
function roasTone(v: number | null): 'success' | 'warning' | 'danger' | 'muted' {
  if (v == null) return 'muted';
  if (v >= 3.5) return 'success';
  if (v >= 2.5) return 'warning';
  return 'danger';
}
function walletTone(saldo: number | null, costosFijos: number | null): 'success' | 'warning' | 'danger' | 'muted' {
  if (saldo == null) return 'muted';
  if (costosFijos == null || costosFijos === 0) return 'muted';
  const meses = saldo / costosFijos;
  if (meses >= 2) return 'success';
  if (meses >= 1) return 'warning';
  return 'danger';
}

const TONE_CLASSES: Record<string, { border: string; bg: string; text: string; glow: string }> = {
  success: { border: 'border-success/28', bg: 'bg-success/[0.07]', text: 'text-success', glow: 'shadow-[0_0_30px_-18px_hsl(var(--success))]' },
  warning: { border: 'border-warning/28', bg: 'bg-warning/[0.07]', text: 'text-warning', glow: 'shadow-[0_0_30px_-18px_hsl(var(--warning))]' },
  danger:  { border: 'border-danger/28',  bg: 'bg-danger/[0.07]',  text: 'text-danger',  glow: 'shadow-[0_0_30px_-18px_hsl(var(--danger))]' },
  muted:   { border: 'border-border',     bg: 'bg-card/40',        text: 'text-foreground', glow: 'shadow-card3d' },
};

// Pills de sub-tab (patrón 3D). Se pasan por className a los TabsTrigger de
// shadcn — solo presentación, el estado sigue siendo el de <Tabs>.
const TABS_LIST_CLS =
  'inline-flex flex-wrap w-full justify-start gap-2 h-auto p-0 bg-transparent';
const TAB_PILL_CLS = [
  'shrink-0 px-4 py-2 rounded-xl text-sm font-medium transition-colors',
  'bg-card/40 border border-border text-muted-foreground',
  'hover:text-foreground hover:border-border-strong',
  'data-[state=active]:bg-accent/16 data-[state=active]:border-accent/40',
  'data-[state=active]:text-accent data-[state=active]:font-semibold',
  'data-[state=active]:shadow-glow3d',
].join(' ');

/**
 * Parte una cifra ya formateada ("$ 18.400.000") en símbolo + número para
 * poder pintar el símbolo más chico, como en el diseño. Presentación pura:
 * NO reformatea ni recalcula nada, solo separa el prefijo no numérico.
 */
function splitCurrency(formatted: string): { symbol: string; rest: string } {
  const m = /^([^0-9-]*)(.*)$/.exec(formatted);
  if (!m) return { symbol: '', rest: formatted };
  const symbol = m[1].trim();
  const rest = m[2].trim();
  // Sin símbolo, sin resto, o resto sin dígitos (ej. "—", "63%") → se pinta
  // la cadena tal cual. Nunca se pierde ni un carácter del valor original.
  if (!symbol || !/\d/.test(rest)) return { symbol: '', rest: formatted };
  return { symbol, rest };
}

export default function CfoTab() {
  const [yearMonth, setYearMonth] = useState<string>(() => toYearMonth(new Date()));
  const [editOpen, setEditOpen] = useState(false);

  // Sub-tab activo dentro de /cfo. Persiste en sessionStorage para que F5
  // no devuelva al usuario al "Cómo voy". Las 3 ex-tabs de /logistica
  // (Finanzas, Billetera, Rentabilidad) se consolidaron acá para no tener
  // doble fuente sobre la misma plata.
  const [activeSubTab, setActiveSubTab] = useSessionState<string>('cfo:tab', 'como-voy');

  // Solo meses del año en curso (enero → mes actual). El negocio arrancó
  // este año; mostrar 12 meses para atrás incluía opciones del año pasado
  // sin datos que confundían al usuario.
  const months = useMemo(() => monthsFromJanuaryThisYear(), []);
  // T3-4: previousMonth puede caer fuera del dropdown (ej. seleccionando
  // enero, prev = diciembre del año pasado, no listado). En ese caso
  // devolvemos null y los componentes que dependen de prev muestran
  // "primer mes — sin comparación" en vez de hacer un fetch silencioso
  // que falla.
  const prevYearMonthRaw = useMemo(() => previousMonth(yearMonth), [yearMonth]);
  const hasPrevMonth = months.includes(prevYearMonthRaw);
  const prevYearMonth = hasPrevMonth ? prevYearMonthRaw : yearMonth;

  const curr = useCfoSnapshot(yearMonth);
  const prev = useCfoSnapshot(prevYearMonth);
  const inputsQuery = useMonthlyBusinessInputs(yearMonth);
  const adSpendForCurrent = useMonthlyAdSpend(yearMonth);
  const { activeStoreId } = useStore();
  const walletHealth = useWalletSyncHealth(activeStoreId);
  const range = useMemo(() => monthRange(yearMonth), [yearMonth]);
  const logForProducts = useLogisticsStats({ fromDate: range.from, toDate: range.to });
  const topProducts = (logForProducts.products.data ?? [])
    .slice()
    .sort((a, b) => b.entregados - a.entregados)
    .slice(0, 5);

  const alerts = useMemo(() => {
    const out: Array<{ tone: 'danger' | 'warning'; text: string }> = [];
    if (curr.loading) return out;
    // Ningún veredicto se emite sobre un valor ausente: una alerta roja sobre
    // "0%" que en realidad es "no cargó" hace que el dueño cambie de
    // transportadora o apriete al equipo por un número que nadie midió.
    if (curr.utilidad_neta != null && curr.utilidad_neta < 0) {
      out.push({ tone: 'danger', text: `Utilidad neta negativa: ${formatCOP(curr.utilidad_neta)}` });
    }
    if (curr.tasa_entrega != null && curr.tasa_entrega < 55) {
      out.push({ tone: 'danger', text: `Efectividad baja: ${fmtPct(curr.tasa_entrega)} (umbral 55%)` });
    }
    if (curr.ads_total > 0 && curr.roas != null && curr.roas < 2.5) {
      out.push({ tone: 'danger', text: `ROAS bajo: ${curr.roas.toFixed(2)}x (umbral 2.5x)` });
    }
    if (
      curr.wallet_saldo != null && curr.costos_fijos != null && curr.costos_fijos > 0 &&
      curr.wallet_saldo < curr.costos_fijos
    ) {
      out.push({ tone: 'danger', text: `Wallet < 1 mes de costos fijos (${formatCOP(curr.wallet_saldo)})` });
    }
    if (curr.tasa_entrega != null && curr.tasa_entrega >= 55 && curr.tasa_entrega < 65) {
      out.push({ tone: 'warning', text: `Efectividad: ${fmtPct(curr.tasa_entrega)} — apuntar a ≥65%` });
    }
    if (curr.ads_total > 0 && curr.roas != null && curr.roas >= 2.5 && curr.roas < 3.5) {
      out.push({ tone: 'warning', text: `ROAS: ${curr.roas.toFixed(2)}x — meta ≥3.5x` });
    }
    if (curr.tarjeta_pago > 0 && curr.tarjeta_pago < curr.tarjeta_interes) {
      out.push({ tone: 'warning', text: 'Pago de tarjeta no cubre los intereses del mes' });
    }
    if (walletHealth.data?.status === 'critical') {
      const hours = walletHealth.data.hoursSinceSync ?? 0;
      const days = Math.round(hours / 24);
      out.push({
        tone: 'danger',
        text: `Wallet desactualizado hace ${days} día${days > 1 ? 's' : ''} — los KPIs pueden estar mal. Sincronizá ahora.`,
      });
    } else if (walletHealth.data?.status === 'stale') {
      out.push({
        tone: 'warning',
        text: `Wallet sin sincronizar hace ${Math.round(walletHealth.data.hoursSinceSync ?? 0)}h`,
      });
    }
    // T3-2: warning cuando hay pauta cargada en monthly_ad_spend (granular)
    // Y también en monthly_business_inputs (manual legacy). El código usa
    // el granular y descarta el manual silenciosamente; si difieren mucho,
    // Fabian puede pensar que cambió el manual y la pantalla muestra otra cosa.
    const inputs = inputsQuery.data;
    const adsByPlatform = (adSpendForCurrent.data ?? []).reduce(
      (acc, r) => {
        if (r.platform === 'meta') acc.meta += r.amount_cop;
        else if (r.platform === 'tiktok') acc.tiktok += r.amount_cop;
        return acc;
      },
      { meta: 0, tiktok: 0 },
    );
    if (
      adsByPlatform.meta > 0 && (inputs?.ads_meta ?? 0) > 0
      && Math.abs(adsByPlatform.meta - (inputs?.ads_meta ?? 0)) > 1000
    ) {
      out.push({
        tone: 'warning',
        text: `Pauta Meta cargada en 2 lugares (granular ${formatCOP(adsByPlatform.meta)} vs manual ${formatCOP(inputs?.ads_meta ?? 0)}) — se está usando el granular. Borrá el manual para evitar confusión.`,
      });
    }
    if (
      adsByPlatform.tiktok > 0 && (inputs?.ads_tiktok ?? 0) > 0
      && Math.abs(adsByPlatform.tiktok - (inputs?.ads_tiktok ?? 0)) > 1000
    ) {
      out.push({
        tone: 'warning',
        text: `Pauta TikTok cargada en 2 lugares (granular ${formatCOP(adsByPlatform.tiktok)} vs manual ${formatCOP(inputs?.ads_tiktok ?? 0)}) — se está usando el granular. Borrá el manual para evitar confusión.`,
      });
    }
    return out;
  }, [curr, walletHealth.data, inputsQuery.data, adSpendForCurrent.data]);

  const utilTone = utilidadTone(curr.utilidad_neta);
  const efTone = efectividadTone(curr.tasa_entrega);
  const rTone = roasTone(curr.roas);
  const wTone = walletTone(curr.wallet_saldo, curr.costos_fijos);

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="hud-label text-accent truncate whitespace-nowrap">
            CFO · Cómo voy
          </div>
          <h2 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-3">
            <span className="w-11 h-11 shrink-0 rounded-2xl bg-success/14 border border-success/30 text-success glow-success flex items-center justify-center">
              <DollarSign size={20} strokeWidth={2.25} />
            </span>
            <span className="capitalize truncate">{monthLabel(yearMonth)}</span>
          </h2>
          <p className="text-sm text-muted-foreground capitalize pl-14">
            {hasPrevMonth ? `Comparativa vs ${monthLabel(prevYearMonth)}` : 'Primer mes — sin comparación'}
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <WalletSyncBadge size="sm" />
          <WalletSyncButton size="sm" variant="outline" label="Sync wallet" />
          <Select value={yearMonth} onValueChange={setYearMonth}>
            <SelectTrigger className="h-9 w-48 text-xs rounded-xl bg-card/40 border-border hover:border-border-strong transition-colors">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {months.map((m) => (
                <SelectItem key={m} value={m} className="text-xs capitalize">
                  {monthLabel(m)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </header>

      {/* Los inputs manuales que se RESTAN de la utilidad no se pudieron leer.
          Sin este aviso el término desaparecía en silencio y la utilidad neta
          salía inflada hacia arriba sin que nada lo indicara. */}
      {curr.hasInputsError && !curr.loading && (
        <div className="relative rounded-2xl border border-danger/40 bg-danger/5 px-4 py-3 pl-5 shadow-card3d flex items-start gap-3">
          <span className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-danger" aria-hidden="true" />
          <AlertTriangle size={16} className="text-danger shrink-0 mt-0.5" />
          <div className="text-xs text-foreground/90">
            <span className="font-semibold">No pudimos leer los costos fijos / inputs del mes</span>
            <span className="text-muted-foreground">
              {' '}— la utilidad neta no se puede calcular. Reintentá recargando la página.
            </span>
          </div>
        </div>
      )}

      {/* "Sin inputs cargados" solo es un diagnóstico válido si las consultas
          RESPONDIERON. Con una consulta caída, has_inputs también sería false. */}
      {!curr.has_inputs && !curr.loading && !curr.hasInputsError && !curr.hasFinError && (
        <div className="relative rounded-2xl border border-warning/30 bg-warning/5 px-4 py-3 pl-5 shadow-card3d flex items-start gap-3">
          <span className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-warning" aria-hidden="true" />
          <AlertCircle size={16} className="text-warning shrink-0 mt-0.5" />
          <div className="text-xs text-foreground/90">
            <span className="font-semibold">Sin inputs cargados</span>
            <span className="text-muted-foreground"> — edita para ver utilidad neta real (incluye pauta y tarjeta).</span>
          </div>
        </div>
      )}

      <Tabs value={activeSubTab} onValueChange={setActiveSubTab} className="w-full">
        <div className="overflow-x-auto -mx-1 px-1">
          <TabsList
            className={TABS_LIST_CLS}
            aria-label="Secciones del CFO"
          >
            <TabsTrigger value="como-voy" className={TAB_PILL_CLS}><Gauge size={13} className="mr-1.5" /> Cómo voy</TabsTrigger>
            <TabsTrigger value="pauta" className={TAB_PILL_CLS}><Megaphone size={13} className="mr-1.5" /> Pauta</TabsTrigger>
            <TabsTrigger value="tarjeta" className={TAB_PILL_CLS}><CreditCard size={13} className="mr-1.5" /> Tarjeta</TabsTrigger>
            <TabsTrigger value="bitacora" className={TAB_PILL_CLS}><BookOpen size={13} className="mr-1.5" /> Bitácora</TabsTrigger>
          </TabsList>
        </div>

        {/* TAB: Cómo voy — KPIs + embudo + P&L + top productos + alertas */}
        <TabsContent value="como-voy" className="mt-4 space-y-5">
          {curr.hasFinError ? (
            /* Corte duro: financial_summary es la fuente de TODA la plata de
               esta vista. Con el RPC caído no se pinta ni un KPI — antes se
               mostraba una pérdida en pesos (bruta=0 menos pauta y costos
               fijos) que se leía como un mes desastroso medido de verdad.
               Mismo banner que /logistica → Finanzas. */
            <div className="rounded-xl border border-danger/40 bg-danger/5 p-6">
              <div className="flex items-start gap-3">
                <AlertTriangle size={18} className="text-danger shrink-0 mt-0.5" />
                <div>
                  <h3 className="text-sm font-semibold text-danger">
                    No pudimos cargar las finanzas del mes
                  </h3>
                  <p className="text-xs text-muted-foreground mt-1">
                    {curr.errorMessage ?? 'Error desconocido'}
                  </p>
                  <p className="text-xs text-muted-foreground mt-2">
                    No se muestra ningún número para no mostrar cifras sin
                    respaldo. Recargá la página para reintentar.
                  </p>
                </div>
              </div>
            </div>
          ) : (
          <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <KpiCard
              label="Utilidad neta real"
              value={curr.utilidad_neta != null ? formatCOP(curr.utilidad_neta) : '—'}
              tone={utilTone}
              icon={<DollarSign size={14} />}
              delta={
                curr.utilidad_neta != null && prev.utilidad_neta != null
                  ? deltaArrow(curr.utilidad_neta, prev.utilidad_neta, { higherIsBetter: true })
                  : { Icon: Minus, tone: 'text-muted-foreground', label: '—' }
              }
              loading={curr.loading}
              subtitle={curr.utilidad_neta == null ? 'No se pudo calcular' : undefined}
              hero
            />
            <KpiCard
              label="Tasa de efectividad"
              value={curr.tasa_entrega != null ? fmtPct(curr.tasa_entrega) : '—'}
              tone={efTone}
              icon={<Target size={14} />}
              delta={
                curr.tasa_entrega != null && prev.tasa_entrega != null
                  ? deltaArrow(curr.tasa_entrega, prev.tasa_entrega, { higherIsBetter: true })
                  : { Icon: Minus, tone: 'text-muted-foreground', label: '—' }
              }
              loading={curr.loading}
              subtitle={curr.tasa_entrega == null ? 'Sin datos del período' : undefined}
            />
            <KpiCard
              label="ROAS bruto"
              value={curr.roas != null ? `${curr.roas.toFixed(2)}x` : '—'}
              tone={rTone}
              icon={<Zap size={14} />}
              delta={
                curr.roas != null && prev.roas != null
                  ? deltaArrow(curr.roas, prev.roas, { higherIsBetter: true })
                  : { Icon: Minus, tone: 'text-muted-foreground', label: '—' }
              }
              loading={curr.loading}
            />
            <KpiCard
              label="Wallet Dropi"
              value={curr.wallet_saldo != null ? formatCOP(curr.wallet_saldo) : '—'}
              tone={wTone}
              icon={<Wallet size={14} />}
              delta={null}
              loading={curr.loading}
              subtitle={
                /* PROYECCIÓN, no medición: asume ingreso futuro CERO y una
                   quema igual a los costos fijos (que no incluyen pauta, el
                   gasto más grande del negocio). El rótulo lo dice explícito
                   para que no se lea como un dato medido. */
                curr.wallet_saldo != null && curr.costos_fijos != null && curr.costos_fijos > 0
                  ? `≈${(curr.wallet_saldo / curr.costos_fijos).toFixed(1)} meses estimados si no entrara nada más (no cuenta pauta)`
                  : undefined
              }
            />
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            <PnlTable snap={curr} onEdit={() => setEditOpen(true)} />
            <TopProductsBlock
              products={topProducts}
              loading={logForProducts.products.isLoading}
              isError={logForProducts.products.isError}
            />
            <Funnel
              generados={curr.total_ordenes}
              entregados={curr.total_entregadas}
              devueltos={curr.total_devueltas}
              loading={curr.loading}
            />
          </div>

          {/* "Todo en orden" es un VEREDICTO: solo vale si los dos números que
              disparan las alertas de plata y de efectividad existen. Sin ellos
              la lista queda vacía porque no se pudo evaluar nada, no porque
              esté todo bien. */}
          <AlertsBlock
            alerts={alerts}
            loading={curr.loading}
            evaluable={curr.utilidad_neta != null && curr.tasa_entrega != null}
          />
          </>
          )}
        </TabsContent>

        {/* Las sub-tabs Finanzas + Billetera + Rentabilidad viven ahora
            unificadas en /logistica → Finanzas (una sola pantalla con todo
            apilado). Acá solo queda la visión "cómo voy" del dueño + sus
            tareas mensuales (pauta, tarjeta, bitácora). */}

        {/* TAB: Pauta — gasto Meta/TikTok por mes + ROAS por canal */}
        <TabsContent value="pauta" className="mt-4">
          <CfoAdSpendTracker
            yearMonth={yearMonth}
            prevYearMonth={prevYearMonth}
            /* undefined (no 0) cuando la bruta no se pudo medir: el tracker
               guarda `walletGenerated != null` y así no compara la pauta
               contra un wallet inventado en $0. */
            walletGenerated={curr.utilidad_bruta ?? undefined}
          />
        </TabsContent>

        {/* TAB: Tarjeta — deuda TC, pagos vs deuda, histórico de pagos
            y análisis de extractos personales. */}
        <TabsContent value="tarjeta" className="mt-4 space-y-4">
          <CfoDebtTracker />
          <CfoPagosHistorico walletDisponible={curr.wallet_saldo} />
          <CfoPaymentsVsDebt />
          <section className="space-y-3">
            <header className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-foreground">
                Análisis tarjetas (gasto personal)
              </h3>
              <span className="text-xs text-muted-foreground">
                Subí extractos PDF para ver dónde se va la plata mes a mes
              </span>
            </header>
            <CfoPersonalCardUploader />
            <CfoPersonalSpendingTracker />
          </section>
        </TabsContent>

        {/* TAB: Bitácora — fugas/aciertos/decisiones por mes */}
        <TabsContent value="bitacora" className="mt-4">
          <CfoMonthlyRetrospective defaultYearMonth={yearMonth} />
        </TabsContent>
      </Tabs>

      <CfoInputsDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        yearMonth={yearMonth}
        current={inputsQuery.data ?? null}
      />
    </div>
  );
}

interface KpiCardProps {
  label: string;
  value: string;
  tone: 'success' | 'warning' | 'danger' | 'muted';
  icon: React.ReactNode;
  delta: { Icon: typeof TrendingUp; tone: string; label: string } | null;
  loading: boolean;
  subtitle?: string;
  /** Card héroe de la pantalla (sheen + brackets + radio/sombra mayor). */
  hero?: boolean;
}

function KpiCard({ label, value, tone, icon, delta, loading, subtitle, hero }: KpiCardProps) {
  const cls = TONE_CLASSES[tone];
  const money = splitCurrency(value);
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}
    >
      <TiltCard
        sheen={hero}
        brackets={hero}
        className={`${hero ? 'rounded-3xl p-5 shadow-card3d-lg' : 'rounded-2xl p-5 shadow-card3d'} border ${cls.border} ${cls.bg} ${cls.glow} space-y-2 min-h-[130px]`}
      >
        <div className="tilt-layer-1 flex items-center gap-1.5 hud-label text-muted-foreground">
          <span className={cls.text}>{icon}</span>
          {label}
        </div>
        {loading ? (
          <div className="h-9 w-28 rounded bg-muted/40 animate-pulse" />
        ) : (
          <div className={`tilt-layer-2 font-mono tabular-nums font-bold leading-none ${hero ? 'text-3xl' : 'text-[28px]'} ${cls.text}`}>
            {money.symbol && (
              <span className="text-[0.6em] font-semibold mr-1.5 align-baseline opacity-80">{money.symbol}</span>
            )}
            {money.rest}
          </div>
        )}
        {subtitle && !loading && (
          <div className="text-[11px] font-mono tabular-nums text-muted-foreground">{subtitle}</div>
        )}
        {delta && !loading && (
          <div className={`text-[11px] inline-flex items-center gap-1 ${delta.tone}`}>
            <delta.Icon size={11} />
            <span className="font-mono tabular-nums">{delta.label}</span>
            <span className="text-muted-foreground">vs mes anterior</span>
          </div>
        )}
      </TiltCard>
    </motion.div>
  );
}

function Funnel({
  generados, entregados, devueltos, loading,
}: {
  generados: number | null; entregados: number | null;
  devueltos: number | null; loading: boolean;
}) {
  if (loading) {
    return (
      <section className="h-full rounded-2xl border border-border bg-card/40 p-4 shadow-card3d">
        <div className="h-32 animate-pulse bg-muted/30 rounded" />
      </section>
    );
  }

  // Sin conteos no hay embudo. Antes se pintaba "Generados 0 / Entregados 0",
  // indistinguible de un mes real sin ventas.
  if (generados == null || entregados == null || devueltos == null) {
    return (
      <TiltCard
        wrapperClassName="h-full"
        className="h-full bg-card/40 border border-border rounded-2xl p-5 shadow-card3d"
      >
        <section className="space-y-3">
          <header className="flex items-center gap-2 mb-1">
            <span className="w-7 h-7 rounded-lg bg-accent/14 border border-accent/30 text-accent flex items-center justify-center shrink-0">
              <PackageIcon size={14} />
            </span>
            <h3 className="text-sm font-semibold text-foreground">Embudo del mes</h3>
          </header>
          <p className="text-sm text-muted-foreground">Sin datos en este mes</p>
        </section>
      </TiltCard>
    );
  }

  const netos = Math.max(0, entregados - devueltos);
  const pctEnt = generados > 0 ? (entregados / generados) * 100 : 0;
  const pctNetos = generados > 0 ? (netos / generados) * 100 : 0;

  return (
    <TiltCard
      wrapperClassName="h-full"
      className="h-full bg-card/40 border border-border rounded-2xl p-5 shadow-card3d"
    >
      <section className="space-y-3">
        <header className="flex items-center gap-2 mb-1">
          <span className="w-7 h-7 rounded-lg bg-accent/14 border border-accent/30 text-accent flex items-center justify-center shrink-0">
            <PackageIcon size={14} />
          </span>
          <h3 className="text-sm font-semibold text-foreground">Embudo del mes</h3>
        </header>
        <div className="space-y-3">
          <FunnelBar label="Generados" value={generados} pct={100} tone="bg-accent-gradient" />
          <FunnelBar
            label="Entregados"
            value={entregados}
            pct={pctEnt}
            tone="bg-success"
            extra={`${fmtPct(pctEnt)}`}
          />
          <FunnelBar
            label="Netos cobrados"
            value={netos}
            pct={pctNetos}
            tone="bg-success"
            extra={`${fmtPct(pctNetos)} · entregados − devueltos`}
          />
        </div>
      </section>
    </TiltCard>
  );
}

function FunnelBar({
  label, value, pct, tone, extra,
}: { label: string; value: number; pct: number; tone: string; extra?: string }) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1.5 gap-3">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="text-sm font-bold font-mono tabular-nums text-foreground">
          {value}
          {extra && <span className="text-[10px] text-muted-foreground ml-2 font-normal">{extra}</span>}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-foreground/10 overflow-hidden">
        <div
          className={`h-full rounded-full ${tone}`}
          style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
        />
      </div>
    </div>
  );
}

function PnlTable({ snap, onEdit }: { snap: CfoSnapshot; onEdit: () => void }) {
  const neta = snap.utilidad_neta;
  const isNegative = neta != null && neta < 0;

  return (
    <section className="rounded-2xl border border-border bg-card/40 shadow-card3d overflow-hidden">
      <header className="px-5 py-3.5 border-b border-border flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">P&L del mes</h3>
        <Button size="sm" variant="outline" onClick={onEdit} className="h-8 rounded-xl">
          <Pencil size={12} className="mr-1.5" />
          Editar inputs manuales
        </Button>
      </header>
      {snap.loading ? (
        <div className="p-8"><div className="h-32 animate-pulse bg-muted/30 rounded" /></div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-foreground/[0.03] text-muted-foreground">
              <tr>
                <th className="px-5 py-2.5 text-left font-semibold">Concepto</th>
                <th className="px-5 py-2.5 text-right font-semibold">Valor</th>
                <th className="px-5 py-2.5 text-left font-semibold">Origen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              <PnlRow label="Utilidad bruta Dropi" value={snap.utilidad_bruta} sign="+" origin="financial_summary" />
              <PnlRow label="Inversión Meta Ads" value={snap.ads_error ? null : snap.ads_meta} sign="-" origin="monthly_ad_spend" />
              <PnlRow label="Inversión TikTok Ads" value={snap.ads_error ? null : snap.ads_tiktok} sign="-" origin="monthly_ad_spend" />
              <PnlRow label="Costos fijos" value={snap.costos_fijos} sign="-" origin="app_settings" />
              <PnlRow label="Intereses tarjeta" value={snap.tarjeta_error ? null : snap.tarjeta_interes} sign="-" origin="input manual" />
              {/* Sin valor: fondo neutro, NUNCA el rojo de "perdiste plata". */}
              <tr
                className={
                  neta == null
                    ? 'bg-foreground/[0.04]'
                    : isNegative ? 'bg-danger/[0.09]' : 'bg-success/[0.09]'
                }
              >
                <td className="px-5 py-3.5 font-bold text-foreground whitespace-nowrap">UTILIDAD NETA REAL</td>
                <td className={`px-5 py-3.5 text-right font-bold font-mono tabular-nums whitespace-nowrap ${
                  neta == null
                    ? 'text-muted-foreground'
                    : isNegative ? 'text-danger' : 'text-success'
                }`}>
                  {neta != null ? `= ${formatCOP(neta)}` : '—'}
                </td>
                <td className="px-5 py-3.5 text-xs text-muted-foreground">
                  {neta != null ? 'calculado' : 'sin datos suficientes'}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      {/* Costos fijos leídos pero en $0: el término se resta como 0 y la
          utilidad neta queda por encima de la real. Se dice en vez de callarlo. */}
      {snap.costos_fijos_sin_cargar && !snap.loading && (
        <div className="px-5 py-3 border-t border-border bg-warning/[0.06] text-xs text-warning">
          Costos fijos sin cargar — la utilidad neta está sobreestimada.
        </div>
      )}
      {snap.notas && !snap.loading && (
        <div className="px-5 py-3 border-t border-border bg-foreground/[0.02] text-xs text-muted-foreground">
          <span className="font-semibold text-foreground">Nota: </span>{snap.notas}
        </div>
      )}
    </section>
  );
}

function PnlRow({
  label, value, sign, origin,
}: { label: string; value: number | null; sign: '+' | '-'; origin: string }) {
  // value == null → "—" en tono neutro. Un "+ $0" con el sello "financial_summary"
  // al lado hacía pasar una RPC que no respondió por una medición en cero.
  const missing = value == null;
  return (
    <tr className="hover:bg-foreground/[0.035] transition-colors">
      <td className="px-5 py-2.5 text-foreground">{label}</td>
      <td className={`px-5 py-2.5 text-right font-mono tabular-nums whitespace-nowrap ${
        missing ? 'text-muted-foreground' : sign === '-' ? 'text-danger' : 'text-success'
      }`}>
        {missing ? '—' : `${sign === '-' ? '-' : '+'}${formatCOP(value)}`}
      </td>
      <td className="px-5 py-2.5 text-xs font-mono text-muted-foreground">
        {missing ? 'sin datos' : origin}
      </td>
    </tr>
  );
}

interface ProductRow {
  producto: string;
  entregados: number;
  tasa_entrega: number;
  valor_entregado?: number;
}

function TopProductsBlock({
  products, loading, isError,
}: { products: ProductRow[]; loading: boolean; isError?: boolean }) {
  return (
    <section className="rounded-2xl border border-border bg-card/40 shadow-card3d overflow-hidden">
      <header className="px-5 py-3.5 border-b border-border">
        <h3 className="text-sm font-semibold text-foreground">Top 5 productos por entregados</h3>
      </header>
      {loading ? (
        <div className="p-5"><div className="h-32 animate-pulse bg-muted/30 rounded" /></div>
      ) : isError ? (
        /* La consulta falló: lista vacía ≠ "no hubo productos". */
        <div className="p-5 text-sm text-danger text-center">
          No pudimos cargar los productos
        </div>
      ) : products.length === 0 ? (
        <div className="p-5 text-sm text-muted-foreground text-center">Sin datos en este mes</div>
      ) : (
        <ul className="divide-y divide-border">
          {products.map((p, i) => (
            <li
              key={p.producto}
              className="px-5 py-3 flex items-center justify-between gap-3 hover:bg-foreground/[0.035] transition-colors"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="text-[10px] font-mono text-muted-foreground tabular-nums">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span className="text-xs text-foreground truncate" title={p.producto}>
                  {p.producto}
                </span>
              </div>
              <div className="flex items-center gap-3 text-xs shrink-0 font-mono tabular-nums">
                <span className="text-foreground font-semibold">{p.entregados}</span>
                <span className="text-muted-foreground">{fmtPct(p.tasa_entrega)}</span>
                <span className={p.valor_entregado != null ? 'text-success text-[10px]' : 'text-muted-foreground text-[10px]'}>
                  {p.valor_entregado != null ? formatCOP(p.valor_entregado) : '—'}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AlertsBlock({
  alerts, loading, evaluable = true,
}: {
  alerts: Array<{ tone: 'danger' | 'warning'; text: string }>;
  loading: boolean;
  /** false = faltan los datos que disparan las alertas → sin lista vacía "verde". */
  evaluable?: boolean;
}) {
  return (
    <section className="rounded-2xl border border-border bg-card/40 shadow-card3d overflow-hidden">
      <header className="px-5 py-3.5 border-b border-border">
        <h3 className="text-sm font-semibold text-foreground">Alertas</h3>
      </header>
      {loading ? (
        <div className="p-5"><Loader2 size={16} className="animate-spin text-muted-foreground" /></div>
      ) : alerts.length === 0 ? (
        <div className="p-5">
          {evaluable ? (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-success/14 border border-success/30 text-success">
              <CheckCircle2 size={13} />
              Todo en orden
            </span>
          ) : (
            /* Tono neutro, nunca verde: no sabemos si está en orden. */
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-foreground/[0.04] border border-border text-muted-foreground">
              <Minus size={13} />
              Sin datos suficientes para evaluar
            </span>
          )}
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {alerts.map((a, i) => (
            <li
              key={i}
              className={`relative px-5 py-3 pl-6 flex items-start gap-2.5 text-xs transition-colors ${
                a.tone === 'danger'
                  ? 'bg-danger/[0.06] hover:bg-danger/[0.1]'
                  : 'bg-warning/[0.06] hover:bg-warning/[0.1]'
              }`}
            >
              <span
                className={`absolute left-0 top-2.5 bottom-2.5 w-1 rounded-full ${
                  a.tone === 'danger' ? 'bg-danger' : 'bg-warning'
                }`}
                aria-hidden="true"
              />
              {a.tone === 'danger' ? (
                <AlertCircle size={14} className="text-danger shrink-0 mt-0.5" />
              ) : (
                <AlertTriangle size={14} className="text-warning shrink-0 mt-0.5" />
              )}
              <span className="text-foreground">{a.text}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

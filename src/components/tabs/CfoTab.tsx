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

interface CfoSnapshot {
  loading: boolean;
  total_ordenes: number;
  total_entregadas: number;
  total_devueltas: number;
  total_cancelados: number;
  tasa_entrega: number;
  utilidad_bruta: number;
  ingresos_brutos: number;
  ads_meta: number;
  ads_tiktok: number;
  ads_total: number;
  costos_fijos: number;
  tarjeta_interes: number;
  tarjeta_pago: number;
  utilidad_neta: number;
  roas: number | null;
  wallet_saldo: number | null;
  has_inputs: boolean;
  notas: string | null;
}

function useCfoSnapshot(yearMonth: string): CfoSnapshot {
  const range = useMemo(() => monthRange(yearMonth), [yearMonth]);
  const finQuery = useFinancialSummary(range.from, range.to);
  const logQuery = useLogisticsStats({ fromDate: range.from, toDate: range.to });
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

  const fin = finQuery.data;
  const logSummary = logQuery.summary.data;
  const inputs = inputsQuery.data;
  const costos_fijos = costosQuery.data ?? 0;

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
  const tarjeta_interes = inputs?.tarjeta_interes ?? 0;
  const tarjeta_pago = inputs?.tarjeta_pago ?? 0;

  const utilidad_bruta = fin?.utilidad_bruta ?? 0;
  const ingresos_brutos = fin?.ingresos_brutos ?? 0;
  const utilidad_neta = utilidad_bruta - ads_total - costos_fijos - tarjeta_interes;

  const roas: number | null = ads_total > 0 ? ingresos_brutos / ads_total : null;

  return {
    loading,
    total_ordenes: fin?.total_ordenes ?? logSummary?.total_pedidos ?? 0,
    total_entregadas: fin?.total_entregadas ?? logSummary?.entregados ?? 0,
    total_devueltas: fin?.total_devueltas ?? logSummary?.devueltos ?? 0,
    total_cancelados: fin?.total_cancelados ?? 0,
    tasa_entrega: fin?.tasa_entrega_pct ?? logSummary?.tasa_entrega ?? 0,
    utilidad_bruta, ingresos_brutos,
    ads_meta, ads_tiktok, ads_total,
    costos_fijos, tarjeta_interes, tarjeta_pago,
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

function utilidadTone(v: number): 'success' | 'warning' | 'danger' {
  if (v > 0) return 'success';
  if (v === 0) return 'warning';
  return 'danger';
}
function efectividadTone(v: number): 'success' | 'warning' | 'danger' {
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
function walletTone(saldo: number | null, costosFijos: number): 'success' | 'warning' | 'danger' | 'muted' {
  if (saldo == null) return 'muted';
  if (costosFijos === 0) return 'muted';
  const meses = saldo / costosFijos;
  if (meses >= 2) return 'success';
  if (meses >= 1) return 'warning';
  return 'danger';
}

const TONE_CLASSES: Record<string, { border: string; bg: string; text: string }> = {
  success: { border: 'border-green/40', bg: 'bg-green/5', text: 'text-green' },
  warning: { border: 'border-orange/40', bg: 'bg-orange/5', text: 'text-orange' },
  danger:  { border: 'border-red/40',   bg: 'bg-red/5',   text: 'text-red' },
  muted:   { border: 'border-border',   bg: 'bg-card',    text: 'text-muted-foreground' },
};

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
  const walletHealth = useWalletSyncHealth();
  const range = useMemo(() => monthRange(yearMonth), [yearMonth]);
  const logForProducts = useLogisticsStats({ fromDate: range.from, toDate: range.to });
  const topProducts = (logForProducts.products.data ?? [])
    .slice()
    .sort((a, b) => b.entregados - a.entregados)
    .slice(0, 5);

  const alerts = useMemo(() => {
    const out: Array<{ tone: 'danger' | 'warning'; text: string }> = [];
    if (curr.loading) return out;
    if (curr.utilidad_neta < 0) {
      out.push({ tone: 'danger', text: `Utilidad neta negativa: ${formatCOP(curr.utilidad_neta)}` });
    }
    if (curr.tasa_entrega < 55) {
      out.push({ tone: 'danger', text: `Efectividad baja: ${fmtPct(curr.tasa_entrega)} (umbral 55%)` });
    }
    if (curr.ads_total > 0 && curr.roas != null && curr.roas < 2.5) {
      out.push({ tone: 'danger', text: `ROAS bajo: ${curr.roas.toFixed(2)}x (umbral 2.5x)` });
    }
    if (
      curr.wallet_saldo != null && curr.costos_fijos > 0 &&
      curr.wallet_saldo < curr.costos_fijos
    ) {
      out.push({ tone: 'danger', text: `Wallet < 1 mes de costos fijos (${formatCOP(curr.wallet_saldo)})` });
    }
    if (curr.tasa_entrega >= 55 && curr.tasa_entrega < 65) {
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
    return out;
  }, [curr, walletHealth.data]);

  const utilTone = utilidadTone(curr.utilidad_neta);
  const efTone = efectividadTone(curr.tasa_entrega);
  const rTone = roasTone(curr.roas);
  const wTone = walletTone(curr.wallet_saldo, curr.costos_fijos);

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          <div className="text-[11px] uppercase tracking-[0.12em] font-semibold text-muted-foreground">
            CFO · Cómo voy
          </div>
          <h2 className="text-xl font-bold tracking-tight text-foreground leading-none flex items-center gap-2">
            <DollarSign size={18} className="text-accent" strokeWidth={2.25} />
            <span className="capitalize">{monthLabel(yearMonth)}</span>
          </h2>
          <p className="text-sm text-muted-foreground capitalize">
            {hasPrevMonth ? `Comparativa vs ${monthLabel(prevYearMonth)}` : 'Primer mes — sin comparación'}
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <WalletSyncBadge size="sm" />
          <WalletSyncButton size="sm" variant="outline" label="Sync wallet" />
          <Select value={yearMonth} onValueChange={setYearMonth}>
            <SelectTrigger className="h-9 w-48 text-xs">
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

      {!curr.has_inputs && !curr.loading && (
        <div className="rounded-xl border border-orange/30 bg-orange/5 px-4 py-3 flex items-start gap-3">
          <AlertCircle size={16} className="text-orange shrink-0 mt-0.5" />
          <div className="text-xs text-foreground/90">
            <span className="font-semibold">Sin inputs cargados</span>
            <span className="text-muted-foreground"> — edita para ver utilidad neta real (incluye pauta y tarjeta).</span>
          </div>
        </div>
      )}

      <Tabs value={activeSubTab} onValueChange={setActiveSubTab} className="w-full">
        <div className="overflow-x-auto -mx-1 px-1">
          <TabsList
            className="inline-flex w-full justify-start gap-0.5 h-auto p-1"
            aria-label="Secciones del CFO"
          >
            <TabsTrigger value="como-voy" className="shrink-0"><Gauge size={13} className="mr-1.5" /> Cómo voy</TabsTrigger>
            <TabsTrigger value="pauta" className="shrink-0"><Megaphone size={13} className="mr-1.5" /> Pauta</TabsTrigger>
            <TabsTrigger value="tarjeta" className="shrink-0"><CreditCard size={13} className="mr-1.5" /> Tarjeta</TabsTrigger>
            <TabsTrigger value="bitacora" className="shrink-0"><BookOpen size={13} className="mr-1.5" /> Bitácora</TabsTrigger>
          </TabsList>
        </div>

        {/* TAB: Cómo voy — KPIs + embudo + P&L + top productos + alertas */}
        <TabsContent value="como-voy" className="mt-4 space-y-5">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <KpiCard
              label="Utilidad neta real"
              value={formatCOP(curr.utilidad_neta)}
              tone={utilTone}
              icon={<DollarSign size={14} />}
              delta={deltaArrow(curr.utilidad_neta, prev.utilidad_neta, { higherIsBetter: true })}
              loading={curr.loading}
            />
            <KpiCard
              label="Tasa de efectividad"
              value={fmtPct(curr.tasa_entrega)}
              tone={efTone}
              icon={<Target size={14} />}
              delta={deltaArrow(curr.tasa_entrega, prev.tasa_entrega, { higherIsBetter: true })}
              loading={curr.loading}
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
                curr.wallet_saldo != null && curr.costos_fijos > 0
                  ? `${(curr.wallet_saldo / curr.costos_fijos).toFixed(1)} meses de runway`
                  : undefined
              }
            />
          </div>

          <Funnel
            generados={curr.total_ordenes}
            entregados={curr.total_entregadas}
            devueltos={curr.total_devueltas}
            loading={curr.loading}
          />

          <PnlTable snap={curr} onEdit={() => setEditOpen(true)} />

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <TopProductsBlock
              products={topProducts}
              loading={logForProducts.products.isLoading}
            />
            <AlertsBlock alerts={alerts} loading={curr.loading} />
          </div>
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
            walletGenerated={curr.utilidad_bruta}
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
}

function KpiCard({ label, value, tone, icon, delta, loading, subtitle }: KpiCardProps) {
  const cls = TONE_CLASSES[tone];
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}
      className={`rounded-xl border ${cls.border} ${cls.bg} p-4 space-y-1.5 min-h-[112px]`}
    >
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
        <span className={cls.text}>{icon}</span>
        {label}
      </div>
      {loading ? (
        <div className="h-7 w-24 rounded bg-muted/40 animate-pulse" />
      ) : (
        <div className={`text-2xl font-bold tabular-nums ${cls.text}`}>{value}</div>
      )}
      {subtitle && !loading && (
        <div className="text-[10px] text-muted-foreground">{subtitle}</div>
      )}
      {delta && !loading && (
        <div className={`text-[11px] inline-flex items-center gap-1 ${delta.tone}`}>
          <delta.Icon size={11} />
          <span className="font-mono">{delta.label}</span>
          <span className="text-muted-foreground">vs mes anterior</span>
        </div>
      )}
    </motion.div>
  );
}

function Funnel({
  generados, entregados, devueltos, loading,
}: { generados: number; entregados: number; devueltos: number; loading: boolean }) {
  const netos = Math.max(0, entregados - devueltos);
  const pctEnt = generados > 0 ? (entregados / generados) * 100 : 0;
  const pctNetos = generados > 0 ? (netos / generados) * 100 : 0;

  if (loading) {
    return (
      <section className="rounded-xl border border-border bg-card p-4">
        <div className="h-32 animate-pulse bg-muted/30 rounded" />
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-border bg-card p-5 space-y-3">
      <header className="flex items-center gap-2 mb-1">
        <PackageIcon size={14} className="text-accent" />
        <h3 className="text-sm font-semibold text-foreground">Embudo del mes</h3>
      </header>
      <div className="space-y-2">
        <FunnelBar label="Generados" value={generados} pct={100} tone="bg-accent" />
        <FunnelBar
          label="Entregados"
          value={entregados}
          pct={pctEnt}
          tone="bg-green"
          extra={`${fmtPct(pctEnt)}`}
        />
        <FunnelBar
          label="Netos cobrados"
          value={netos}
          pct={pctNetos}
          tone="bg-orange"
          extra={`${fmtPct(pctNetos)} · entregados − devueltos`}
        />
      </div>
    </section>
  );
}

function FunnelBar({
  label, value, pct, tone, extra,
}: { label: string; value: number; pct: number; tone: string; extra?: string }) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="text-sm font-bold tabular-nums text-foreground">
          {value}
          {extra && <span className="text-[10px] text-muted-foreground ml-2 font-normal">{extra}</span>}
        </span>
      </div>
      <div className="h-2.5 rounded-full bg-muted/30 overflow-hidden">
        <div
          className={`h-full ${tone}`}
          style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
        />
      </div>
    </div>
  );
}

function PnlTable({ snap, onEdit }: { snap: CfoSnapshot; onEdit: () => void }) {
  const isNegative = snap.utilidad_neta < 0;

  return (
    <section className="rounded-xl border border-border bg-card overflow-hidden">
      <header className="px-5 py-3 border-b border-border flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">P&L del mes</h3>
        <Button size="sm" variant="outline" onClick={onEdit} className="h-8">
          <Pencil size={12} className="mr-1.5" />
          Editar inputs manuales
        </Button>
      </header>
      {snap.loading ? (
        <div className="p-8"><div className="h-32 animate-pulse bg-muted/30 rounded" /></div>
      ) : (
        <table className="w-full text-sm">
          <thead className="bg-muted/30 text-muted-foreground text-[10px] uppercase tracking-wider">
            <tr>
              <th className="px-5 py-2 text-left font-semibold">Concepto</th>
              <th className="px-5 py-2 text-right font-semibold">Valor</th>
              <th className="px-5 py-2 text-left font-semibold">Origen</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            <PnlRow label="Utilidad bruta Dropi" value={snap.utilidad_bruta} sign="+" origin="financial_summary" />
            <PnlRow label="Inversión Meta Ads" value={snap.ads_meta} sign="-" origin="monthly_ad_spend" />
            <PnlRow label="Inversión TikTok Ads" value={snap.ads_tiktok} sign="-" origin="monthly_ad_spend" />
            <PnlRow label="Costos fijos" value={snap.costos_fijos} sign="-" origin="app_settings" />
            <PnlRow label="Intereses tarjeta" value={snap.tarjeta_interes} sign="-" origin="input manual" />
            <tr className={isNegative ? 'bg-red/10' : 'bg-green/10'}>
              <td className="px-5 py-3 font-bold text-foreground">UTILIDAD NETA REAL</td>
              <td className={`px-5 py-3 text-right font-bold tabular-nums ${isNegative ? 'text-red' : 'text-green'}`}>
                {`= ${formatCOP(snap.utilidad_neta)}`}
              </td>
              <td className="px-5 py-3 text-xs text-muted-foreground">calculado</td>
            </tr>
          </tbody>
        </table>
      )}
      {snap.notas && !snap.loading && (
        <div className="px-5 py-3 border-t border-border bg-muted/20 text-xs text-muted-foreground">
          <span className="font-semibold text-foreground">Nota: </span>{snap.notas}
        </div>
      )}
    </section>
  );
}

function PnlRow({
  label, value, sign, origin,
}: { label: string; value: number; sign: '+' | '-'; origin: string }) {
  return (
    <tr>
      <td className="px-5 py-2 text-foreground">{label}</td>
      <td className={`px-5 py-2 text-right font-mono tabular-nums ${sign === '-' ? 'text-red' : 'text-green'}`}>
        {sign === '-' ? '-' : '+'}{formatCOP(value)}
      </td>
      <td className="px-5 py-2 text-xs text-muted-foreground">{origin}</td>
    </tr>
  );
}

interface ProductRow {
  producto: string;
  entregados: number;
  tasa_entrega: number;
  valor_entregado?: number;
}

function TopProductsBlock({ products, loading }: { products: ProductRow[]; loading: boolean }) {
  return (
    <section className="rounded-xl border border-border bg-card overflow-hidden">
      <header className="px-5 py-3 border-b border-border">
        <h3 className="text-sm font-semibold text-foreground">Top 5 productos por entregados</h3>
      </header>
      {loading ? (
        <div className="p-5"><div className="h-32 animate-pulse bg-muted/30 rounded" /></div>
      ) : products.length === 0 ? (
        <div className="p-5 text-sm text-muted-foreground text-center">Sin datos en este mes</div>
      ) : (
        <ul className="divide-y divide-border">
          {products.map((p, i) => (
            <li key={p.producto} className="px-5 py-2.5 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="text-[10px] font-mono text-muted-foreground tabular-nums">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span className="text-xs text-foreground truncate" title={p.producto}>
                  {p.producto}
                </span>
              </div>
              <div className="flex items-center gap-3 text-xs shrink-0 tabular-nums">
                <span className="text-foreground font-semibold">{p.entregados}</span>
                <span className="text-muted-foreground">{fmtPct(p.tasa_entrega)}</span>
                <span className="text-green font-mono text-[10px]">
                  {formatCOP(p.valor_entregado ?? 0)}
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
  alerts, loading,
}: { alerts: Array<{ tone: 'danger' | 'warning'; text: string }>; loading: boolean }) {
  return (
    <section className="rounded-xl border border-border bg-card overflow-hidden">
      <header className="px-5 py-3 border-b border-border">
        <h3 className="text-sm font-semibold text-foreground">Alertas</h3>
      </header>
      {loading ? (
        <div className="p-5"><Loader2 size={16} className="animate-spin text-muted-foreground" /></div>
      ) : alerts.length === 0 ? (
        <div className="p-5 inline-flex items-center gap-2 text-sm text-green">
          <CheckCircle2 size={14} />
          <span>Todo en orden</span>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {alerts.map((a, i) => (
            <li
              key={i}
              className={`px-5 py-2.5 flex items-start gap-2.5 text-xs ${
                a.tone === 'danger' ? 'bg-red/5' : 'bg-orange/5'
              }`}
            >
              {a.tone === 'danger' ? (
                <AlertCircle size={14} className="text-red shrink-0 mt-0.5" />
              ) : (
                <AlertTriangle size={14} className="text-orange shrink-0 mt-0.5" />
              )}
              <span className="text-foreground">{a.text}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

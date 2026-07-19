import { useMemo, useState } from 'react';
import {
  Megaphone, Plus, Pencil, AlertCircle, AlertTriangle, CheckCircle2,
  CalendarClock, Loader2, TrendingUp, TrendingDown,
} from 'lucide-react';
import {
  useAdSpendCompare, useMonthlyAdSpend,
  type AdPaymentMethod, type AdSpendRow, type AdPlatform,
} from '@/hooks/useMonthlyAdSpend';
import { PieChart, Pie, Cell, Tooltip as RTooltip, ResponsiveContainer } from 'recharts';
import { formatCOP } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import CfoAdSpendDialog from './CfoAdSpendDialog';
import { CHART_TOOLTIP_STYLE } from '@/components/logistics/charts/chartTokens';
import {
  MoneyFigure, GradientBar,
} from './cfoVisuals';
import {
  barGlow, ringOf, CHART_SUCCESS, CHART_WARNING, CHART_DANGER, CHART_MUTED,
} from './cfoChartTokens';

// ─────────────────────────────────────────────────────────────────
// /cfo → bloque "Pauta del mes + Control de cargos a TC"
//
// Lee monthly_ad_spend (filas individuales por cuenta) y muestra:
// 1. KPIs Meta + TikTok + Total con delta vs mes anterior
// 2. Distribución por método de pago (qué porción se difiere a TC USD)
// 3. Tabla de cuentas individuales (editable)
// 4. Calendario de pagos (cierres + vencimientos)
// 5. Alertas operativas (pauta a TC USD, pauta > wallet, etc.)
// ─────────────────────────────────────────────────────────────────

interface Props {
  yearMonth: string;
  prevYearMonth: string;
  /** OJO — el nombre miente por historia: CfoTab pasa acá `curr.utilidad_bruta`
   *  (utilidad bruta CONTABLE de financial_summary, por fecha de entrega), NO el
   *  saldo del wallet (`curr.wallet_saldo`, la card "Wallet Dropi"). La alerta de
   *  abajo lo nombra por lo que realmente es. */
  walletGenerated?: number;
}

const PLATFORM_LABELS: Record<AdPlatform, string> = {
  meta: 'Meta Ads',
  tiktok: 'TikTok Ads',
  other: 'Otros',
};

const PAYMENT_METHOD_INFO: Record<AdPaymentMethod, { label: string; tone: 'success' | 'warning' | 'danger' | 'muted'; icon: string }> = {
  mastercard_usd: { label: 'Mastercard USD', tone: 'danger',  icon: '🔴' },
  mastercard_cop: { label: 'Mastercard COP', tone: 'warning', icon: '🟡' },
  amex_cop:       { label: 'Amex pesos',     tone: 'success', icon: '🟢' },
  wallet:         { label: 'Wallet directo', tone: 'success', icon: '🟢' },
  other:          { label: 'Otro',           tone: 'muted',   icon: '⚪' },
};

const TONE_TEXT: Record<string, string> = {
  success: 'text-success',
  warning: 'text-warning',
  danger:  'text-danger',
  muted:   'text-muted-foreground',
};

/** El mismo tono, como color de dibujo (token HSL) para barras y dona. */
const TONE_STROKE: Record<string, string> = {
  success: CHART_SUCCESS,
  warning: CHART_WARNING,
  danger:  CHART_DANGER,
  muted:   CHART_MUTED,
};

function deltaPct(curr: number, prev: number): number | null {
  if (prev === 0 && curr === 0) return null;
  if (prev === 0) return null;
  return Math.round(((curr - prev) / Math.abs(prev)) * 100);
}

function fmtMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  if (!y || !m) return ym;
  return new Date(y, m - 1, 1).toLocaleDateString('es-CO', { month: 'long', year: 'numeric' });
}

/**
 * Próximo cierre y vencimiento para una tarjeta con cierre el día N.
 * Hardcoded para Mastercard *9999 (cierre 15, vence ~02 mes siguiente).
 */
function nextCutOffDates(cutDay: number, dueOffsetDays: number, today = new Date()): { cierre: Date; vencimiento: Date } {
  const y = today.getFullYear();
  const m = today.getMonth();
  let cierre = new Date(y, m, cutDay);
  if (cierre <= today) {
    cierre = new Date(y, m + 1, cutDay);
  }
  const vencimiento = new Date(cierre);
  vencimiento.setDate(vencimiento.getDate() + dueOffsetDays);
  return { cierre, vencimiento };
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' });
}

function daysUntil(d: Date, today = new Date()): number {
  const diffMs = d.getTime() - today.getTime();
  return Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
}

export default function CfoAdSpendTracker({ yearMonth, prevYearMonth, walletGenerated }: Props) {
  const { isLoading, isError, rows, curr, prev } = useAdSpendCompare(yearMonth, prevYearMonth);
  // monthly_ad_spend es carga MANUAL y `prev` sale de aggregateSpend([]) → todos
  // los campos en 0 cuando el mes anterior no tiene filas. Sin este flag, "no
  // cargué la pauta" y "no pauté" se ven idénticos ($0). Misma queryKey que usa
  // useAdSpendCompare por dentro → React Query la deduplica, no hay request extra.
  // (Si esta query fallara, el early-return de `isError` ya corta antes.)
  const prevHasRows = (useMonthlyAdSpend(prevYearMonth).data?.length ?? 0) > 0;
  const [editingDialog, setEditingDialog] = useState<{ open: boolean; row: AdSpendRow | null }>({ open: false, row: null });

  const cutoffMC = useMemo(() => nextCutOffDates(15, 18), []);

  const totalDelta = deltaPct(curr.total, prev.total);
  const metaDelta = deltaPct(curr.meta, prev.meta);
  const tiktokDelta = deltaPct(curr.tiktok, prev.tiktok);

  const alerts = useMemo(() => {
    const out: Array<{ tone: 'danger' | 'warning' | 'success'; text: string }> = [];
    if (isLoading) return out;
    if (curr.byPaymentMethod.mastercard_usd > 0) {
      out.push({
        tone: 'danger',
        text: `${formatCOP(curr.byPaymentMethod.mastercard_usd)} de pauta van a Mastercard USD — se difieren a 36 cuotas 25.5% EA si no pagás antes del cierre`,
      });
    }
    if (walletGenerated != null && walletGenerated > 0 && curr.total > walletGenerated) {
      const exceso = curr.total - walletGenerated;
      out.push({
        tone: 'warning',
        text: `Pauta total (${formatCOP(curr.total)}) supera a la utilidad bruta del mes (${formatCOP(walletGenerated)}) por ${formatCOP(exceso)} — es utilidad bruta contable, no el saldo del wallet; si no hay caja, ese exceso se financia con deuda`,
      });
    }
    if (curr.total === 0 && !isLoading) {
      out.push({
        tone: 'warning',
        text: 'Sin pauta cargada para este mes — agregá las cuentas de Meta/TikTok para tener control',
      });
    }
    if (curr.byPaymentMethod.amex_cop > 0 || curr.byPaymentMethod.wallet > 0) {
      const seguro = curr.byPaymentMethod.amex_cop + curr.byPaymentMethod.wallet;
      out.push({
        tone: 'success',
        text: `${formatCOP(seguro)} de pauta paga sin diferir (Amex pesos / wallet directo) — bien hecho`,
      });
    }
    return out;
  }, [curr, prev, isLoading, walletGenerated]);

  if (isLoading) {
    return (
      <section className="rounded-2xl border border-border bg-card/40 shadow-card3d p-5">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 size={14} className="animate-spin" />
          Cargando pauta…
        </div>
      </section>
    );
  }

  if (isError) {
    return (
      <section className="relative rounded-2xl border border-danger/30 bg-danger/[0.07] p-4 pl-5 shadow-card3d">
        <span className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-danger" aria-hidden="true" />
        <div className="flex items-start gap-2 text-sm text-danger">
          <AlertCircle size={14} className="shrink-0 mt-0.5" />
          <div>
            <span className="font-semibold">No pude leer la pauta.</span>{' '}
            <span className="text-foreground/80">
              Probablemente la migration <code className="text-xs bg-card px-1 rounded">monthly_ad_spend</code> no se aplicó. Corré el SQL en Supabase.
            </span>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="w-9 h-9 shrink-0 rounded-xl bg-accent/14 border border-accent/30 text-accent glow-accent flex items-center justify-center">
            <Megaphone size={17} aria-hidden="true" />
          </span>
          <h3 className="text-sm font-semibold text-foreground truncate">
            Pauta — <span className="capitalize">{fmtMonth(yearMonth)}</span>
          </h3>
        </div>
        <Button size="sm" variant="outline" onClick={() => setEditingDialog({ open: true, row: null })} className="h-8 rounded-xl shrink-0">
          <Plus size={12} className="mr-1.5" />
          Agregar cuenta
        </Button>
      </header>

      {/* Sección 1: KPIs por plataforma */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <KpiCard label="Meta Ads" value={curr.meta} prev={prev.meta} delta={metaDelta} prevHasRows={prevHasRows} />
        <KpiCard label="TikTok Ads" value={curr.tiktok} prev={prev.tiktok} delta={tiktokDelta} prevHasRows={prevHasRows} />
        <KpiCard
          label="TOTAL pauta"
          value={curr.total}
          prev={prev.total}
          delta={totalDelta}
          prevHasRows={prevHasRows}
          bold
        />
      </div>

      {/* Sección 2: Distribución por método de pago */}
      {curr.total > 0 && <PaymentMethodSplit total={curr.total} byMethod={curr.byPaymentMethod} />}

      {/* Sección 3: Tabla de cuentas */}
      {rows.length > 0 ? (
        <div className="rounded-2xl border border-border bg-card/40 shadow-card3d hairline-top overflow-hidden overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-foreground/[0.03] text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left hud-label">Plataforma</th>
                <th className="px-4 py-3 text-left hud-label">Cuenta</th>
                <th className="px-4 py-3 text-right hud-label">Monto COP</th>
                <th className="px-4 py-3 text-left hud-label">Pago</th>
                <th className="px-4 py-3 text-right hud-label">Acción</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => {
                const info = PAYMENT_METHOD_INFO[row.payment_method];
                return (
                  <tr key={row.id} className="hover:bg-foreground/[0.035] transition-colors">
                    <td className="px-4 py-2 text-xs text-foreground">{PLATFORM_LABELS[row.platform]}</td>
                    <td className="px-4 py-2 text-xs text-foreground">{row.account_name}</td>
                    <td className="px-4 py-2 text-right text-xs font-mono tabular-nums text-foreground">{formatCOP(row.amount_cop)}</td>
                    <td className={`px-4 py-2 text-xs ${TONE_TEXT[info.tone]}`}>
                      {info.icon} {info.label}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <button
                        onClick={() => setEditingDialog({ open: true, row })}
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors duration-200 cursor-pointer"
                      >
                        <Pencil size={11} />
                        Editar
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed border-border bg-card/40 p-6 text-center">
          <p className="text-sm text-muted-foreground mb-2">Sin pauta cargada para este mes</p>
          <Button size="sm" variant="outline" onClick={() => setEditingDialog({ open: true, row: null })}>
            <Plus size={12} className="mr-1.5" />
            Cargar la primera cuenta
          </Button>
        </div>
      )}

      {/* Sección 4: Calendario de cierres */}
      <div className="rounded-2xl border border-border bg-card/40 shadow-card3d p-4 space-y-2.5">
        <div className="flex items-center gap-1.5 hud-label text-muted-foreground mb-1">
          <CalendarClock size={12} />
          Próximo ciclo TC
        </div>
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div className="rounded-2xl border border-border bg-card/40 p-3 shadow-card3d hairline-top hover:border-border-strong transition-colors">
            <div className="hud-label text-muted-foreground">Cierre Mastercard</div>
            <div className="text-sm font-bold font-mono tabular-nums text-foreground mt-1">{fmtDate(cutoffMC.cierre)}</div>
            <div className="text-[10px] font-mono tabular-nums text-muted-foreground">en {daysUntil(cutoffMC.cierre)} días</div>
          </div>
          <div className="relative rounded-2xl border border-danger/30 bg-danger/[0.06] p-3 pl-4 shadow-card3d">
            <span className="absolute left-0 top-2.5 bottom-2.5 w-1 rounded-full bg-danger" aria-hidden="true" />
            <div className="hud-label text-danger">Vence pago</div>
            <div className="text-sm font-bold font-mono tabular-nums text-danger mt-1">{fmtDate(cutoffMC.vencimiento)}</div>
            <div className="text-[10px] font-mono tabular-nums text-muted-foreground">en {daysUntil(cutoffMC.vencimiento)} días</div>
          </div>
        </div>
        <p className="text-[10px] text-muted-foreground leading-relaxed">
          Si pagás <strong>Pago Total</strong> antes del vencimiento → corte limpio, no se difiere.
          Si pagás solo <strong>mínimo</strong> → cargos USD se difieren a 36 cuotas al 25.5% EA.
        </p>
      </div>

      {/* Sección 5: Alertas */}
      <div className="rounded-2xl border border-border bg-card/40 shadow-card3d overflow-hidden">
        <header className="px-4 py-3 border-b border-border flex items-center gap-1.5">
          <AlertTriangle size={12} className="text-accent" />
          <span className="hud-label text-muted-foreground">Alertas operativas</span>
        </header>
        {alerts.length === 0 ? (
          <div className="px-4 py-3">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-success/14 border border-success/30 text-success">
              <CheckCircle2 size={13} />
              Todo en orden
            </span>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {alerts.map((a, i) => (
              <li
                key={i}
                className={`relative px-4 py-3 pl-5 flex items-start gap-2.5 text-xs transition-colors ${
                  a.tone === 'danger'
                    ? 'bg-danger/[0.06] hover:bg-danger/[0.1]'
                    : a.tone === 'warning'
                      ? 'bg-warning/[0.06] hover:bg-warning/[0.1]'
                      : 'bg-success/[0.06] hover:bg-success/[0.1]'
                }`}
              >
                <span
                  className={`absolute left-0 top-2.5 bottom-2.5 w-1 rounded-full ${
                    a.tone === 'danger' ? 'bg-danger' : a.tone === 'warning' ? 'bg-warning' : 'bg-success'
                  }`}
                  aria-hidden="true"
                />
                {a.tone === 'danger' ? (
                  <AlertCircle size={14} className="text-danger shrink-0 mt-0.5" />
                ) : a.tone === 'warning' ? (
                  <AlertTriangle size={14} className="text-warning shrink-0 mt-0.5" />
                ) : (
                  <CheckCircle2 size={14} className="text-success shrink-0 mt-0.5" />
                )}
                <span className="text-foreground">{a.text}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <CfoAdSpendDialog
        open={editingDialog.open}
        onOpenChange={(open) => setEditingDialog({ open, row: open ? editingDialog.row : null })}
        yearMonth={yearMonth}
        editing={editingDialog.row}
      />
    </section>
  );
}

/**
 * Distribución de la pauta por método de pago: dona + leyenda-ranking.
 *
 * Antes eran 5 barritas planas apiladas verticalmente; el reparto (cuánto se
 * está difiriendo a la TC en dólares vs cuánto se paga limpio) es una
 * PROPORCIÓN, y una dona la cuenta de un vistazo. Los montos y los porcentajes
 * son exactamente los mismos que ya se imprimían.
 */
function PaymentMethodSplit({
  total, byMethod,
}: { total: number; byMethod: Record<AdPaymentMethod, number> }) {
  const slices = (['mastercard_usd', 'mastercard_cop', 'amex_cop', 'wallet', 'other'] as const)
    .filter((m) => byMethod[m] > 0)
    .map((m) => {
      const info = PAYMENT_METHOD_INFO[m];
      const amount = byMethod[m];
      return {
        key: m,
        label: info.label,
        icon: info.icon,
        tone: info.tone,
        color: TONE_STROKE[info.tone] ?? CHART_MUTED,
        amount,
        pct: total > 0 ? (amount / total) * 100 : 0,
      };
    })
    .sort((a, b) => b.amount - a.amount);

  if (slices.length === 0) return null;
  const top = slices[0];

  return (
    <div className="rounded-2xl border border-border bg-card/40 shadow-card3d hairline-top p-5">
      <div className="hud-label text-muted-foreground mb-4">
        Por método de pago
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-center">
        <div className="relative h-[220px]">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={slices}
                dataKey="amount"
                nameKey="label"
                innerRadius={58}
                outerRadius={96}
                paddingAngle={2}
                cornerRadius={6}
                stroke="hsl(var(--card))"
                strokeWidth={2}
              >
                {slices.map((s) => (
                  <Cell key={s.key} fill={s.color} style={barGlow(s.color)} />
                ))}
              </Pie>
              <RTooltip
                contentStyle={CHART_TOOLTIP_STYLE}
                formatter={(v: number) => formatCOP(v)}
              />
            </PieChart>
          </ResponsiveContainer>
          {/* Cifra al centro: el método que más pesa. Mismo porcentaje que su
              fila de la leyenda, no un número nuevo. */}
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            <div className="text-[34px] font-bold text-foreground font-mono tabular-nums leading-none num-glow-accent">
              {Math.round(top.pct)}%
            </div>
            <div className="text-[11px] text-muted-foreground font-medium mt-2 truncate max-w-[130px] text-center">
              {top.label}
            </div>
          </div>
        </div>

        <ul className="space-y-1.5">
          {slices.map((s) => (
            <li
              key={s.key}
              className="flex flex-col gap-1.5 px-3 py-2 rounded-xl border border-transparent transition-colors duration-200 hover:bg-card/60 hover:border-border"
            >
              <div className="flex items-center justify-between text-xs gap-2">
                <span className="flex items-center gap-2 min-w-0">
                  <span
                    className="h-2.5 w-2.5 rounded-full shrink-0"
                    style={{ background: s.color, boxShadow: `0 0 0 3px ${ringOf(s.color)}` }}
                    aria-hidden="true"
                  />
                  <span aria-hidden="true">{s.icon}</span>
                  <span className="text-foreground truncate">{s.label}</span>
                </span>
                <span className="font-mono tabular-nums shrink-0 ml-2 flex items-baseline gap-2">
                  <span className={`font-bold ${TONE_TEXT[s.tone]}`}>{formatCOP(s.amount)}</span>
                  <span className="text-muted-foreground w-9 text-right">{Math.round(s.pct)}%</span>
                </span>
              </div>
              <GradientBar pct={s.pct} color={s.color} height={4} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

interface KpiCardProps {
  label: string;
  value: number;
  prev: number;
  delta: number | null;
  /** false = el mes anterior no tiene NINGUNA fila cargada, así que `prev` es
   *  relleno, no una medición. Un mes cargado que sumó 0 sí muestra $0. */
  prevHasRows?: boolean;
  bold?: boolean;
}

function KpiCard({ label, value, prev, delta, prevHasRows = true, bold }: KpiCardProps) {
  const goingUp = delta !== null && delta > 0;
  // En pauta, SUBIR es la señal roja: el delta ya venía con ese criterio.
  const deltaSkin = goingUp
    ? 'bg-danger/14 border-danger/30 text-danger'
    : delta !== null && delta < 0
      ? 'bg-success/14 border-success/30 text-success'
      : 'bg-muted/50 border-border text-muted-foreground';
  return (
    <div className={`rounded-2xl border shadow-card3d hairline-top p-4 transition-colors duration-200 hover:border-border-strong ${bold ? 'border-accent/40 bg-accent/[0.07]' : 'border-border bg-card/40'}`}>
      <div className="flex items-start justify-between gap-2">
        <span className={`w-9 h-9 rounded-xl border flex items-center justify-center shrink-0 ${
          bold
            ? 'bg-accent/14 border-accent/30 text-accent glow-accent'
            : 'bg-muted/60 border-border text-muted-foreground'
        }`}>
          <Megaphone size={17} aria-hidden="true" />
        </span>
        {delta !== null && (
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-lg border text-[10px] font-semibold whitespace-nowrap ${deltaSkin}`}>
            {goingUp ? <TrendingUp size={10} aria-hidden="true" /> : <TrendingDown size={10} aria-hidden="true" />}
            <span className="font-mono tabular-nums">{delta > 0 ? '+' : ''}{delta}%</span>
          </span>
        )}
      </div>

      <MoneyFigure
        text={formatCOP(value)}
        className={`text-[28px] font-bold leading-none mt-3 ${bold ? 'text-accent num-glow-accent' : 'text-foreground'}`}
      />

      <div className="hud-label text-subtle mt-2">{label}</div>

      {delta !== null ? (
        <div className="text-[11px] text-muted-foreground mt-1.5">
          vs mes anterior (<span className="font-mono tabular-nums">{formatCOP(prev)}</span>)
        </div>
      ) : (
        <div className="text-[11px] text-muted-foreground mt-1.5">
          mes anterior: {prevHasRows ? <span className="font-mono tabular-nums">{formatCOP(prev)}</span> : 'sin pauta cargada'}
        </div>
      )}
    </div>
  );
}

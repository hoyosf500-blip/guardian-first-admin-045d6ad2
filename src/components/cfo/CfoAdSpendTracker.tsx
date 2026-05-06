import { useMemo, useState } from 'react';
import {
  Megaphone, Plus, Pencil, AlertCircle, AlertTriangle, CheckCircle2,
  CalendarClock, Loader2, TrendingUp, TrendingDown,
} from 'lucide-react';
import {
  useAdSpendCompare,
  type AdPaymentMethod, type AdSpendRow, type AdPlatform,
} from '@/hooks/useMonthlyAdSpend';
import { formatCOP } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import CfoAdSpendDialog from './CfoAdSpendDialog';

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

const TONE_BG: Record<string, string> = {
  success: 'bg-green',
  warning: 'bg-orange',
  danger:  'bg-red',
  muted:   'bg-muted-foreground',
};

const TONE_TEXT: Record<string, string> = {
  success: 'text-green',
  warning: 'text-orange',
  danger:  'text-red',
  muted:   'text-muted-foreground',
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
        text: `Pauta total (${formatCOP(curr.total)}) supera al wallet del mes (${formatCOP(walletGenerated)}) por ${formatCOP(exceso)} — el resto se está financiando con deuda`,
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
      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 size={14} className="animate-spin" />
          Cargando pauta…
        </div>
      </section>
    );
  }

  if (isError) {
    return (
      <section className="rounded-xl border border-red/40 bg-red/5 p-4">
        <div className="flex items-start gap-2 text-sm text-red">
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
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Megaphone size={14} className="text-accent" />
          <h3 className="text-sm font-semibold text-foreground">
            Pauta — <span className="capitalize">{fmtMonth(yearMonth)}</span>
          </h3>
        </div>
        <Button size="sm" variant="outline" onClick={() => setEditingDialog({ open: true, row: null })} className="h-8">
          <Plus size={12} className="mr-1.5" />
          Agregar cuenta
        </Button>
      </header>

      {/* Sección 1: KPIs por plataforma */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <KpiCard label="Meta Ads" value={curr.meta} prev={prev.meta} delta={metaDelta} />
        <KpiCard label="TikTok Ads" value={curr.tiktok} prev={prev.tiktok} delta={tiktokDelta} />
        <KpiCard
          label="TOTAL pauta"
          value={curr.total}
          prev={prev.total}
          delta={totalDelta}
          bold
        />
      </div>

      {/* Sección 2: Distribución por método de pago */}
      {curr.total > 0 && (
        <div className="rounded-xl border border-border bg-card p-4 space-y-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
            Por método de pago
          </div>
          {(['mastercard_usd', 'mastercard_cop', 'amex_cop', 'wallet', 'other'] as const)
            .filter((m) => curr.byPaymentMethod[m] > 0)
            .map((m) => {
              const info = PAYMENT_METHOD_INFO[m];
              const amount = curr.byPaymentMethod[m];
              const pct = curr.total > 0 ? (amount / curr.total) * 100 : 0;
              return (
                <div key={m}>
                  <div className="flex items-baseline justify-between text-xs mb-1">
                    <span className="flex items-center gap-1.5">
                      <span>{info.icon}</span>
                      <span className="text-foreground">{info.label}</span>
                    </span>
                    <span className={`font-bold tabular-nums ${TONE_TEXT[info.tone]}`}>
                      {formatCOP(amount)}
                      <span className="text-muted-foreground font-normal ml-1.5">{Math.round(pct)}%</span>
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-muted/30 overflow-hidden">
                    <div className={`h-full ${TONE_BG[info.tone]}`} style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
        </div>
      )}

      {/* Sección 3: Tabla de cuentas */}
      {rows.length > 0 ? (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/30 text-muted-foreground text-[10px] uppercase tracking-wider">
              <tr>
                <th className="px-4 py-2 text-left font-semibold">Plataforma</th>
                <th className="px-4 py-2 text-left font-semibold">Cuenta</th>
                <th className="px-4 py-2 text-right font-semibold">Monto COP</th>
                <th className="px-4 py-2 text-left font-semibold">Pago</th>
                <th className="px-4 py-2 text-right font-semibold">Acción</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => {
                const info = PAYMENT_METHOD_INFO[row.payment_method];
                return (
                  <tr key={row.id} className="hover:bg-muted/20">
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
        <div className="rounded-xl border border-dashed border-border bg-card/50 p-6 text-center">
          <p className="text-sm text-muted-foreground mb-2">Sin pauta cargada para este mes</p>
          <Button size="sm" variant="outline" onClick={() => setEditingDialog({ open: true, row: null })}>
            <Plus size={12} className="mr-1.5" />
            Cargar la primera cuenta
          </Button>
        </div>
      )}

      {/* Sección 4: Calendario de cierres */}
      <div className="rounded-xl border border-border bg-card p-4 space-y-2.5">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
          <CalendarClock size={12} />
          Próximo ciclo TC
        </div>
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div className="rounded-lg border border-border bg-card/50 p-2.5">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Cierre Mastercard</div>
            <div className="text-sm font-bold text-foreground">{fmtDate(cutoffMC.cierre)}</div>
            <div className="text-[10px] text-muted-foreground">en {daysUntil(cutoffMC.cierre)} días</div>
          </div>
          <div className="rounded-lg border border-red/30 bg-red/5 p-2.5">
            <div className="text-[10px] uppercase tracking-wider text-red font-semibold">Vence pago</div>
            <div className="text-sm font-bold text-red">{fmtDate(cutoffMC.vencimiento)}</div>
            <div className="text-[10px] text-muted-foreground">en {daysUntil(cutoffMC.vencimiento)} días</div>
          </div>
        </div>
        <p className="text-[10px] text-muted-foreground leading-relaxed">
          Si pagás <strong>Pago Total</strong> antes del vencimiento → corte limpio, no se difiere.
          Si pagás solo <strong>mínimo</strong> → cargos USD se difieren a 36 cuotas al 25.5% EA.
        </p>
      </div>

      {/* Sección 5: Alertas */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <header className="px-4 py-2.5 border-b border-border flex items-center gap-1.5">
          <AlertTriangle size={12} className="text-accent" />
          <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">Alertas operativas</span>
        </header>
        {alerts.length === 0 ? (
          <div className="px-4 py-3 inline-flex items-center gap-2 text-sm text-green">
            <CheckCircle2 size={14} />
            <span>Todo en orden</span>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {alerts.map((a, i) => (
              <li
                key={i}
                className={`px-4 py-2.5 flex items-start gap-2.5 text-xs ${
                  a.tone === 'danger' ? 'bg-red/5' : a.tone === 'warning' ? 'bg-orange/5' : 'bg-green/5'
                }`}
              >
                {a.tone === 'danger' ? (
                  <AlertCircle size={14} className="text-red shrink-0 mt-0.5" />
                ) : a.tone === 'warning' ? (
                  <AlertTriangle size={14} className="text-orange shrink-0 mt-0.5" />
                ) : (
                  <CheckCircle2 size={14} className="text-green shrink-0 mt-0.5" />
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

interface KpiCardProps {
  label: string;
  value: number;
  prev: number;
  delta: number | null;
  bold?: boolean;
}

function KpiCard({ label, value, prev, delta, bold }: KpiCardProps) {
  const goingUp = delta !== null && delta > 0;
  const tone = goingUp ? 'text-red' : delta !== null && delta < 0 ? 'text-green' : 'text-muted-foreground';
  return (
    <div className={`rounded-xl border ${bold ? 'border-accent/40 bg-accent/5' : 'border-border bg-card'} p-3 space-y-1`}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{label}</div>
      <div className={`text-xl font-bold tabular-nums ${bold ? 'text-accent' : 'text-foreground'}`}>
        {formatCOP(value)}
      </div>
      {delta !== null ? (
        <div className={`text-[11px] inline-flex items-center gap-1 ${tone}`}>
          {goingUp ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
          <span className="font-mono">{delta > 0 ? '+' : ''}{delta}%</span>
          <span className="text-muted-foreground">vs mes anterior ({formatCOP(prev)})</span>
        </div>
      ) : (
        <div className="text-[11px] text-muted-foreground">
          mes anterior: {formatCOP(prev)}
        </div>
      )}
    </div>
  );
}

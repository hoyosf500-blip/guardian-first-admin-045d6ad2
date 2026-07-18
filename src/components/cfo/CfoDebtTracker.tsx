import { useMemo } from 'react';
import { CreditCard, AlertCircle, TrendingDown, Loader2 } from 'lucide-react';
import {
  useTcDebtSnapshots,
  totalCop,
  cupoUsadoPct,
  latestSnapshot,
  type TcDebtSnapshot,
  type TcCard,
} from '@/hooks/useTcDebtSnapshots';
import { formatCOP } from '@/lib/utils';
import { TiltCard } from '@/components/ui3d';

// ─────────────────────────────────────────────────────────────────
// /cfo → bloque "Deuda TC"
//
// Muestra el progreso de la deuda de las 2 tarjetas (Amex *6109 y
// Mastercard *9999) con barra estilo "cuánto debo / cuánto del cupo
// usado / cuánto en USD diferida". Cada snapshot histórico se ve como
// un punto en una mini línea temporal.
//
// Tono semántico: % del cupo usado decide el color del card.
//   < 50%  → success (verde)
//   50-75% → warning (naranja)
//   > 75%  → danger (rojo)
// ─────────────────────────────────────────────────────────────────

const CARD_LABELS: Record<TcCard, { label: string; sublabel: string }> = {
  amex_6109: { label: 'Amex *6109', sublabel: 'Personal Bancolombia' },
  mc_9999:   { label: 'Mastercard *9999', sublabel: 'Bancolombia (USD diferida)' },
};

interface DebtTone { border: string; bg: string; text: string; bar: string; }

const TONE: Record<'success' | 'warning' | 'danger' | 'muted', DebtTone> = {
  success: { border: 'border-success/28', bg: 'bg-success/[0.07]', text: 'text-success', bar: 'bg-success' },
  warning: { border: 'border-warning/28', bg: 'bg-warning/[0.07]', text: 'text-warning', bar: 'bg-warning' },
  danger:  { border: 'border-danger/28',  bg: 'bg-danger/[0.07]',  text: 'text-danger',  bar: 'bg-danger' },
  muted:   { border: 'border-border',     bg: 'bg-card/40',        text: 'text-muted-foreground', bar: 'bg-muted' },
};

function toneFor(pct: number): 'success' | 'warning' | 'danger' {
  if (pct < 0.5) return 'success';
  if (pct < 0.75) return 'warning';
  return 'danger';
}

function fmtPct01(p: number): string { return `${Math.round(p * 100)}%`; }

function fmtFecha(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso;
  const d = new Date(`${iso.slice(0, 10)}T12:00:00`);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function CfoDebtTracker() {
  const { data: snaps, isLoading, isError, error } = useTcDebtSnapshots();

  const groups = useMemo(() => {
    const list = snaps ?? [];
    return {
      mc: list.filter((s) => s.tarjeta === 'mc_9999')
              .sort((a, b) => (a.fecha_corte < b.fecha_corte ? 1 : -1)),
      amex: list.filter((s) => s.tarjeta === 'amex_6109')
                .sort((a, b) => (a.fecha_corte < b.fecha_corte ? 1 : -1)),
    };
  }, [snaps]);

  const totalGlobal = useMemo(() => {
    const mcLast = latestSnapshot(snaps ?? [], 'mc_9999');
    const amexLast = latestSnapshot(snaps ?? [], 'amex_6109');
    const mcCop = mcLast ? totalCop(mcLast) : 0;
    const amexCop = amexLast ? totalCop(amexLast) : 0;
    const usdTotal = (mcLast?.saldo_usd ?? 0) + (amexLast?.saldo_usd ?? 0);
    return { total: mcCop + amexCop, mcCop, amexCop, usdTotal };
  }, [snaps]);

  if (isLoading) {
    return (
      <section className="rounded-2xl border border-border bg-card/40 shadow-card3d p-5">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 size={14} className="animate-spin" />
          Cargando deuda TC…
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
            <span className="font-semibold">No pude leer la deuda TC.</span>{' '}
            <span className="text-foreground/80">
              {error instanceof Error ? error.message : 'Error desconocido'}.
              Probablemente la migration <code className="text-xs bg-card px-1 rounded">tc_debt_snapshots</code> no se aplicó todavía — corré el SQL en Supabase.
            </span>
          </div>
        </div>
      </section>
    );
  }

  if (!snaps || snaps.length === 0) {
    return (
      <section className="relative rounded-2xl border border-warning/30 bg-warning/[0.07] p-4 pl-5 shadow-card3d flex items-start gap-3">
        <span className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-warning" aria-hidden="true" />
        <AlertCircle size={16} className="text-warning shrink-0 mt-0.5" />
        <div className="text-xs text-foreground/90">
          <span className="font-semibold">Sin snapshots de deuda cargados.</span>
          <span className="text-muted-foreground"> — ejecutá la migration <code>20260505260000_tc_debt_snapshots.sql</code> que ya trae los seeds históricos.</span>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="w-8 h-8 shrink-0 rounded-xl bg-accent/14 border border-accent/30 text-accent flex items-center justify-center">
            <CreditCard size={14} />
          </span>
          <h3 className="text-sm font-semibold text-foreground truncate">Deuda Tarjetas de Crédito</h3>
        </div>
        <div className="text-right shrink-0">
          <div className="hud-label text-muted-foreground">Deuda total HOY</div>
          <div className="text-2xl font-bold font-mono tabular-nums text-danger">{formatCOP(totalGlobal.total)}</div>
          {totalGlobal.usdTotal > 0 && (
            <div className="text-[10px] font-mono text-muted-foreground tabular-nums">
              de los cuales <span className="text-danger font-semibold">US$ {totalGlobal.usdTotal.toLocaleString('en-US', { maximumFractionDigits: 0 })}</span> en USD diferida
            </div>
          )}
        </div>
      </header>

      <CardBlock card="mc_9999" history={groups.mc} />
      <CardBlock card="amex_6109" history={groups.amex} />
    </section>
  );
}

interface CardBlockProps { card: TcCard; history: TcDebtSnapshot[]; }

function CardBlock({ card, history }: CardBlockProps) {
  if (history.length === 0) {
    return (
      <div className="rounded-2xl border border-border bg-card/40 shadow-card3d p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-foreground">{CARD_LABELS[card].label}</div>
            <div className="text-[11px] text-muted-foreground">{CARD_LABELS[card].sublabel}</div>
          </div>
          <div className="text-xs text-muted-foreground">Sin snapshots</div>
        </div>
      </div>
    );
  }

  const current = history[0];                              // más reciente
  const previous = history.length > 1 ? history[1] : null; // 2do más reciente
  const earliest = history[history.length - 1];            // más antiguo

  const currentCop = totalCop(current);
  const earliestCop = totalCop(earliest);
  const previousCop = previous ? totalCop(previous) : 0;
  const cupoPct = cupoUsadoPct(current);
  const cupoTone = current.cupo_cop > 0 ? toneFor(cupoPct) : 'muted';
  const tone = TONE[cupoTone];

  // ¿La deuda creció o bajó desde el primer snapshot?
  const deltaDesdeInicio = currentCop - earliestCop;
  const subio = deltaDesdeInicio > 0;
  const deltaPct = earliestCop > 0
    ? Math.round((deltaDesdeInicio / earliestCop) * 100)
    : null;

  const usdCop = current.saldo_usd * current.trm;
  const usdShare = currentCop > 0 ? Math.min(1, Math.max(0, usdCop / currentCop)) : 0;

  return (
    <TiltCard className={`rounded-2xl border ${tone.border} ${tone.bg} p-5 shadow-card3d space-y-3`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground">{CARD_LABELS[card].label}</div>
          <div className="text-[11px] text-muted-foreground">{CARD_LABELS[card].sublabel}</div>
        </div>
        <div className="text-right shrink-0">
          <div className={`text-2xl font-bold font-mono tabular-nums ${tone.text}`}>
            {formatCOP(currentCop)}
          </div>
          <div className="text-[10px] font-mono tabular-nums text-muted-foreground">
            al {fmtFecha(current.fecha_corte)}
          </div>
        </div>
      </div>

      {/* Barra principal: % del cupo usado */}
      {current.cupo_cop > 0 ? (
        <div>
          <div className="flex items-baseline justify-between mb-1">
            <span className="text-[11px] text-muted-foreground">Cupo usado</span>
            <span className={`text-xs font-bold font-mono tabular-nums ${tone.text}`}>
              {fmtPct01(cupoPct)}
              <span className="text-muted-foreground font-normal ml-1.5">
                de {formatCOP(current.cupo_cop)}
              </span>
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-foreground/10 overflow-hidden relative">
            <div
              className={`absolute inset-y-0 left-0 rounded-full ${tone.bar}`}
              style={{ width: `${cupoPct * 100}%` }}
            />
            {usdShare > 0 && (
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-danger/60"
                style={{ width: `${cupoPct * usdShare * 100}%` }}
                title="Porción en USD diferida"
              />
            )}
          </div>
          {usdShare > 0 && (
            <div className="text-[10px] text-muted-foreground mt-1">
              <span className="text-red">█</span> COP{' '}
              <span className="text-red/80">█</span> USD diferida ({Math.round(usdShare * 100)}% del total)
            </div>
          )}
        </div>
      ) : (
        <div className="text-[10px] text-muted-foreground italic">
          Cupo total no registrado — agregá los datos del extracto para ver % usado.
        </div>
      )}

      {/* Métricas: COP vs USD diferida */}
      <div className="grid grid-cols-2 gap-2 pt-1">
        <div className="rounded-xl border border-border bg-card/40 p-2.5 hover:border-border-strong transition-colors">
          <div className="hud-label text-muted-foreground">Saldo COP</div>
          <div className="text-sm font-bold font-mono tabular-nums text-foreground mt-1">{formatCOP(current.saldo_cop)}</div>
        </div>
        <div className="rounded-xl border border-border bg-card/40 p-2.5 hover:border-border-strong transition-colors">
          <div className="hud-label text-muted-foreground">Saldo USD diferido</div>
          <div className={`text-sm font-bold font-mono tabular-nums mt-1 ${current.saldo_usd > 0 ? 'text-danger' : 'text-foreground'}`}>
            {current.saldo_usd > 0
              ? `US$ ${current.saldo_usd.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
              : '—'}
          </div>
          {current.saldo_usd > 0 && (
            <div className="text-[10px] text-muted-foreground tabular-nums">
              ≈ {formatCOP(usdCop)} @ TRM {current.trm.toLocaleString('es-CO')}
            </div>
          )}
        </div>
      </div>

      {/* Historial mini (timeline de barras) */}
      {history.length > 1 && (
        <div className="pt-2 border-t border-border/50">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
            Evolución ({history.length} snapshots)
          </div>
          <div className="flex items-end gap-1 h-12">
            {[...history].reverse().map((s) => {
              const v = totalCop(s);
              const max = Math.max(...history.map(totalCop), 1);
              const h = Math.max(4, (v / max) * 100);
              const isCurrent = s.id === current.id;
              return (
                <div
                  key={s.id}
                  className="flex-1 flex flex-col items-center gap-0.5"
                  title={`${fmtFecha(s.fecha_corte)}: ${formatCOP(v)}`}
                >
                  <div
                    className={`w-full rounded-sm ${isCurrent ? tone.bar : 'bg-muted/60'}`}
                    style={{ height: `${h}%` }}
                  />
                  <div className="text-[9px] text-muted-foreground tabular-nums">
                    {s.fecha_corte.slice(5, 7)}/{s.fecha_corte.slice(2, 4)}
                  </div>
                </div>
              );
            })}
          </div>
          {deltaPct !== null && (
            <div className={`mt-2 text-[11px] inline-flex items-center gap-1 ${subio ? 'text-danger' : 'text-success'}`}>
              <TrendingDown size={11} className={subio ? 'rotate-180' : ''} />
              <span className="font-mono tabular-nums">{subio ? '+' : ''}{deltaPct}%</span>
              <span className="text-muted-foreground">
                desde {fmtFecha(earliest.fecha_corte)} ({formatCOP(earliestCop)} → {formatCOP(currentCop)})
              </span>
            </div>
          )}
          {previous && (
            <div className="text-[10px] text-muted-foreground mt-1">
              Vs corte anterior ({fmtFecha(previous.fecha_corte)}, {formatCOP(previousCop)}):{' '}
              <span className={currentCop > previousCop ? 'text-danger font-semibold font-mono tabular-nums' : 'text-success font-semibold font-mono tabular-nums'}>
                {currentCop > previousCop ? '+' : ''}{formatCOP(currentCop - previousCop)}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Notas del snapshot actual */}
      {current.notas && (
        <div className="pt-2 border-t border-border/50">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
            Nota del último snapshot
          </div>
          <div className="text-[11px] text-foreground/80 leading-relaxed">{current.notas}</div>
        </div>
      )}
    </TiltCard>
  );
}

import { useState } from 'react';
import { OrderData, formatPhone } from '@/lib/orderUtils';
import { calcPriority, getPriorityLevel, PRIORITY_CONFIG } from '@/lib/alertSystem';
import { CheckCircle2, XCircle, PhoneOff, RotateCcw } from 'lucide-react';
import { TruncatedText } from '@/components/TruncatedText';

interface Props {
  items: OrderData[];
  onOpenCall: (idx: number) => void;
}

function timeAgo(dias: number): string {
  if (dias === 0) return 'hoy';
  if (dias === 1) return 'hace 1 día';
  return `hace ${dias}d`;
}

export default function WorkList({ items, onOpenCall }: Props) {
  const [visibleCount, setVisibleCount] = useState(50);

  if (!items.length) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <CheckCircle2 size={36} className="mx-auto mb-3 text-green opacity-60" aria-hidden="true" />
        <p className="text-sm">No hay pedidos en este filtro</p>
      </div>
    );
  }

  return (
    <div className="space-y-0 rounded-xl border border-border overflow-hidden">
      {items.slice(0, visibleCount).map((o, i) => {
        const pLevel = getPriorityLevel(calcPriority(o));
        const pCfg = PRIORITY_CONFIG[pLevel];
        /* Badge color for estado "Pendiente" */
        const isPending = !o.result;
        const resultBg = o.result === 'conf'
          ? 'bg-green/15 text-green border-green/20'
          : o.result === 'canc'
            ? 'bg-red/15 text-red border-red/20'
            : 'bg-card text-muted-foreground border-border';

        return (
          <div
            key={`${o.phone}-${o.idx}`}
            role="button"
            tabIndex={0}
            onClick={() => onOpenCall(i)}
            onKeyDown={(e) => e.key === 'Enter' && onOpenCall(i)}
            aria-label={`Gestionar pedido de ${o.nombre}`}
            className={[
              'flex items-center gap-3 px-4 py-0 border-b border-border last:border-b-0',
              'min-h-[56px] cursor-pointer transition-colors duration-200',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
              o.result
                ? 'opacity-50 bg-background'
                : isPending
                  ? 'bg-surface hover:bg-card'
                  : 'bg-surface hover:bg-card',
              o.dias >= 7 && !o.result ? 'urgent-pulse' : '',
            ].join(' ')}
          >
            {/* Priority bar */}
            <div className={`w-1 self-stretch flex-shrink-0 ${
              o.dias >= 7 ? 'bg-red' : o.dias >= 4 ? 'bg-yellow' : 'bg-green/50'
            }`} aria-hidden="true" />

            {/* Two-line content */}
            <div className="flex-1 min-w-0 py-3">
              {/* Line 1: Name + phone */}
              <div className="flex items-center gap-2">
                <TruncatedText
                  text={o.nombre}
                  cssTruncate
                  className="block text-sm font-semibold text-foreground truncate flex-1"
                />
                <span className="font-mono text-xs text-subtle flex-shrink-0 hidden sm:block">
                  {formatPhone(o.phone)}
                </span>
              </div>
              {/* Line 2: Product · city · time */}
              <div className="flex items-center gap-1.5 mt-0.5 text-xs text-muted-foreground">
                <TruncatedText text={o.producto || '—'} maxChars={20} className="truncate" />
                <span className="text-subtle" aria-hidden="true">·</span>
                <span className="flex-shrink-0">{o.ciudad || '—'}</span>
                <span className="text-subtle" aria-hidden="true">·</span>
                <span className="flex-shrink-0">{timeAgo(o.dias)}</span>
              </div>
            </div>

            {/* Right side: value + badge */}
            <div className="flex items-center gap-2 flex-shrink-0">
              {o.valor > 0 && (
                <span className="font-mono font-semibold text-xs text-foreground tabular-nums hidden sm:block">
                  ${o.valor.toLocaleString()}
                </span>
              )}
              {/* Priority badge (high/critical only) */}
              {pLevel !== 'low' && (
                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border flex-shrink-0 ${pCfg.bgClass} ${pCfg.color}`}>
                  {pCfg.label}
                </span>
              )}
              {/* Retry badge */}
              {o.retryCount && !o.result && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-md font-bold bg-orange-500/15 text-orange-500 border border-orange-500/20 inline-flex items-center gap-0.5 flex-shrink-0" aria-label={`Reintento ${o.retryCount} de 3`}>
                  <RotateCcw size={9} aria-hidden="true" /> {o.retryCount}/3
                </span>
              )}
              {/* Status badge */}
              {o.result ? (
                <span className={`text-[10px] px-2 py-0.5 rounded-md font-semibold border inline-flex items-center gap-1 flex-shrink-0 ${resultBg}`}>
                  {o.result === 'conf' ? <CheckCircle2 size={11} aria-hidden="true" /> : o.result === 'canc' ? <XCircle size={11} aria-hidden="true" /> : <PhoneOff size={11} aria-hidden="true" />}
                  {o.result === 'conf' ? 'Confirmado' : o.result === 'canc' ? 'Cancelado' : 'N/R'}
                </span>
              ) : (
                <span className="text-[10px] px-2 py-0.5 rounded-md font-semibold border bg-accent/12 text-accent border-accent/30 flex-shrink-0">
                  Pendiente
                </span>
              )}
            </div>
          </div>
        );
      })}
      {items.length > visibleCount && (
        <div className="px-4 py-3 flex items-center justify-between bg-card border-t border-border">
          <p className="text-xs text-muted-foreground">Mostrando {visibleCount} de {items.length}</p>
          <button
            onClick={() => setVisibleCount(prev => prev + 50)}
            className="text-xs px-4 py-1.5 rounded-lg bg-accent text-accent-foreground font-semibold hover:opacity-90 transition-opacity cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          >
            Ver más
          </button>
        </div>
      )}
    </div>
  );
}

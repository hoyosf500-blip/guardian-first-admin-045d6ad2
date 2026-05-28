import { useState } from 'react';
import { CheckCircle2, Phone, MessageCircle, Truck, Home, RotateCcw, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SEG_METHODS, SEG_CLOSERS } from '@/lib/segDailyReview';

/**
 * Botonera simplificada de Seguimiento (reemplaza los 7 botones planos).
 * Un primario "Gestioné hoy" que despliega los métodos (Llamé / WhatsApp /
 * Reclamé transportadora / Cliente recoge) + cierre (Resuelto / Devolución).
 * Cada acción llama `onAction(<acción>)` — el consumidor la mapea al pedido y
 * registra el touchpoint. Ver SegActionButtons en CrmCallView y CrmTable.
 */

const METHOD_ICON: Record<string, typeof Phone> = {
  'Llamé': Phone,
  'WhatsApp': MessageCircle,
  'Reclamé transportadora': Truck,
  'Cliente recoge': Home,
};

interface SegActionButtonsProps {
  /** Acción elegida (método o cierre). Ya viene sin prefijo de módulo. */
  onAction: (action: string) => void;
  /** 'call' = vista de llamada (botones grandes); 'list' = card compacta. */
  variant?: 'call' | 'list';
}

export default function SegActionButtons({ onAction, variant = 'list' }: SegActionButtonsProps) {
  const [showMethods, setShowMethods] = useState(false);
  const big = variant === 'call';

  const pick = (action: string) => {
    setShowMethods(false);
    onAction(action);
  };

  return (
    <div className="space-y-2">
      {/* Primario: Gestioné hoy → despliega métodos */}
      <button
        type="button"
        onClick={() => setShowMethods(v => !v)}
        aria-expanded={showMethods}
        className={cn(
          'w-full inline-flex items-center justify-center gap-2 rounded-xl font-bold transition-colors',
          'bg-accent text-accent-foreground hover:bg-accent/90 active:scale-[0.99]',
          'focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none',
          big ? 'py-3.5 text-sm' : 'py-2.5 text-[13px]',
        )}
      >
        <CheckCircle2 size={big ? 17 : 15} aria-hidden="true" />
        Gestioné hoy
        <ChevronDown size={14} className={cn('transition-transform', showMethods && 'rotate-180')} aria-hidden="true" />
      </button>

      {/* Métodos (cómo lo gestioné) */}
      {showMethods && (
        <div className="grid grid-cols-2 gap-1.5 rounded-xl border border-accent/25 bg-accent/5 p-1.5">
          {SEG_METHODS.map(m => {
            const Icon = METHOD_ICON[m] ?? CheckCircle2;
            return (
              <button
                key={m}
                type="button"
                onClick={() => pick(m)}
                className={cn(
                  'inline-flex items-center justify-center gap-1.5 rounded-lg font-semibold transition-colors',
                  'bg-card border border-border text-foreground hover:border-accent/50 hover:bg-accent/10',
                  'focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none',
                  big ? 'py-2.5 text-xs' : 'py-2 text-[11px]',
                )}
              >
                <Icon size={13} aria-hidden="true" /> {m}
              </button>
            );
          })}
        </div>
      )}

      {/* Cierre: sale de Seguimiento. Contraste subido (12/25 → 20/50) para
          que en light mode pasen WCAG 4.5:1 y el borde sea visible. */}
      <div className="grid grid-cols-2 gap-1.5">
        <button
          type="button"
          onClick={() => pick(SEG_CLOSERS[0])}
          aria-label={`${SEG_CLOSERS[0]} — saca el pedido de Seguimiento`}
          className={cn(
            'inline-flex items-center justify-center gap-1.5 rounded-xl font-semibold transition-colors',
            'bg-success/20 text-success border border-success/50 hover:bg-success/30',
            'focus-visible:ring-2 focus-visible:ring-success focus-visible:outline-none',
            big ? 'py-3 text-xs' : 'py-2 text-[11px] min-h-[40px]',
          )}
        >
          <CheckCircle2 size={13} aria-hidden="true" /> {SEG_CLOSERS[0]}
        </button>
        <button
          type="button"
          onClick={() => pick(SEG_CLOSERS[1])}
          aria-label={`${SEG_CLOSERS[1]} — saca el pedido de Seguimiento`}
          className={cn(
            'inline-flex items-center justify-center gap-1.5 rounded-xl font-semibold transition-colors',
            'bg-danger/20 text-danger border border-danger/50 hover:bg-danger/30',
            'focus-visible:ring-2 focus-visible:ring-danger focus-visible:outline-none',
            big ? 'py-3 text-xs' : 'py-2 text-[11px] min-h-[40px]',
          )}
        >
          <RotateCcw size={13} aria-hidden="true" /> {SEG_CLOSERS[1]}
        </button>
      </div>
    </div>
  );
}

import { Clock, AlertTriangle, Ban } from 'lucide-react';
import type { InactivityWarning } from '@/hooks/useInactivityGuard';
import { formatLostTime } from '@/lib/inactivityWindow';

/**
 * Modal BLOQUEANTE de inactividad. Tapa toda la pantalla y solo se cierra al
 * tocar "Entendido" (no cierra por click afuera — es a propósito). Escala el
 * tono según el número de advertencia del día. NUNCA bloquea de verdad el CRM:
 * la 3ª solo lo amenaza (presión psicológica, decisión del dueño).
 */
export default function InactivityWarningModal({
  warning,
  onAcknowledge,
}: {
  warning: InactivityWarning;
  onAcknowledge: () => void;
}) {
  const n = warning.number;
  const isFinal = n >= 3;

  const title =
    n === 1 ? 'Tiempo de inactividad detectado'
    : n === 2 ? 'Segunda advertencia'
    : 'Tercera advertencia';

  const message =
    n === 1
      ? 'El sistema registró tu tiempo de inactividad. Mantené el ritmo para no perder pedidos. 💪'
      : n === 2
      ? 'Si volvés a quedar inactiva, en la próxima el CRM se te bloqueará.'
      : 'El CRM se bloqueará por inactividad reiterada.';

  const Icon = n === 1 ? Clock : isFinal ? Ban : AlertTriangle;

  return (
    <div
      className="fixed inset-0 z-[3000] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="inactivity-title"
    >
      <div className="bg-surface rounded-2xl p-6 w-full max-w-[420px] shadow-2xl border border-red/30 text-center animate-slide-up">
        <div
          className={`mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full ${
            isFinal ? 'bg-red/20' : 'bg-yellow/20'
          }`}
        >
          <Icon size={28} className={isFinal ? 'text-red' : 'text-yellow'} aria-hidden="true" />
        </div>

        <h2 id="inactivity-title" className="text-lg font-bold text-foreground mb-1">
          {title}
        </h2>

        <p className="text-sm text-muted-foreground mb-3">
          Estuviste{' '}
          <span className="font-bold text-foreground">{formatLostTime(warning.lostSeconds)}</span>{' '}
          sin actividad.
        </p>

        <p className={`text-sm font-medium mb-5 ${isFinal ? 'text-red' : 'text-foreground'}`}>
          {message}
        </p>

        <button
          onClick={onAcknowledge}
          autoFocus
          className="w-full py-3 rounded-xl bg-red text-white font-bold text-sm hover:bg-red/90 active:scale-[0.98] transition-all focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          Entendido
        </button>

        <p className="mt-3 text-[11px] text-muted-foreground">
          Advertencia {n} de hoy · queda registrada en tu reporte
        </p>
      </div>
    </div>
  );
}

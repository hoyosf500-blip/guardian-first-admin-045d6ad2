import { useEffect, useState } from 'react';
import { Clock, AlertTriangle, Lock } from 'lucide-react';
import type { InactivityWarning } from '@/hooks/useInactivityGuard';
import { formatLostTime } from '@/lib/inactivityWindow';

/**
 * Modal de inactividad. Tapa toda la pantalla.
 *  - 1º/2º aviso: se cierra con "Entendido" (psicológico).
 *  - 3º (lockedUntil set): BLOQUEO REAL de 5 min con cuenta regresiva — NO se
 *    puede cerrar hasta que el contador llegue a 0 (ahí se auto-cierra).
 */
function fmtCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function InactivityWarningModal({
  warning,
  onAcknowledge,
}: {
  warning: InactivityWarning;
  onAcknowledge: () => void;
}) {
  const n = warning.number;
  const locked = warning.lockedUntil != null;
  const [remaining, setRemaining] = useState(() =>
    locked ? Math.max(0, (warning.lockedUntil as number) - Date.now()) : 0,
  );

  // Cuenta regresiva del bloqueo: al llegar a 0 se auto-acusa (desbloquea).
  useEffect(() => {
    if (!locked) return;
    const id = window.setInterval(() => {
      const rem = Math.max(0, (warning.lockedUntil as number) - Date.now());
      setRemaining(rem);
      if (rem <= 0) {
        window.clearInterval(id);
        onAcknowledge();
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [locked, warning.lockedUntil, onAcknowledge]);

  const title =
    n === 1 ? 'Tiempo de inactividad detectado'
    : n === 2 ? 'Segunda advertencia'
    : 'CRM bloqueado por inactividad';

  const message =
    n === 1
      ? 'El sistema registró tu tiempo de inactividad. Tenés trabajo pendiente — mantené el ritmo. 💪'
      : n === 2
      ? 'Si volvés a quedar inactiva con trabajo pendiente, el CRM se te bloqueará 5 minutos.'
      : 'Quedaste inactiva con trabajo pendiente. El CRM se bloqueó 5 minutos.';

  const Icon = n === 1 ? Clock : locked ? Lock : AlertTriangle;
  const stillLocked = locked && remaining > 0;

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
            locked ? 'bg-red/20' : 'bg-yellow/20'
          }`}
        >
          <Icon size={28} className={locked ? 'text-red' : 'text-yellow'} aria-hidden="true" />
        </div>

        <h2 id="inactivity-title" className="text-lg font-bold text-foreground mb-1">
          {title}
        </h2>

        <p className="text-sm text-muted-foreground mb-3">
          Estuviste{' '}
          <span className="font-bold text-foreground">{formatLostTime(warning.lostSeconds)}</span>{' '}
          sin actividad.
        </p>

        <p className={`text-sm font-medium mb-5 ${locked ? 'text-red' : 'text-foreground'}`}>
          {message}
        </p>

        {stillLocked ? (
          <div className="w-full py-3 rounded-xl bg-red/10 border border-red/30 text-red font-bold text-base tabular-nums inline-flex items-center justify-center gap-2">
            <Lock size={16} aria-hidden="true" />
            Desbloqueo en {fmtCountdown(remaining)}
          </div>
        ) : (
          <button
            onClick={onAcknowledge}
            autoFocus
            className="w-full py-3 rounded-xl bg-red text-danger-foreground font-bold text-sm hover:bg-red/90 active:scale-[0.98] transition-all focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            Entendido
          </button>
        )}

        <p className="mt-3 text-[11px] text-muted-foreground">
          Advertencia {n} de hoy · queda registrada en tu reporte
        </p>
      </div>
    </div>
  );
}

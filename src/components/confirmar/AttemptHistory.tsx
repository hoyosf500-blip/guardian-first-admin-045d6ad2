import { useMemo, useState } from 'react';
import { History } from 'lucide-react';
import { useOperatorNames } from '@/hooks/useOperatorNames';
import { attemptLabel, attemptTone, attemptClock, attemptDaySuffix, type AttemptRow } from '@/lib/attemptFormat';
import { bogotaToday } from '@/lib/utils';

const TONE_DOT: Record<string, string> = {
  green: 'bg-success',
  red: 'bg-danger',
  yellow: 'bg-warning',
  muted: 'bg-muted-foreground',
};

/**
 * Historial de intentos por asesor de UN pedido, mostrado en la ficha de
 * Confirmar/CRM. Objetivo (Fase 2a): que la asesora vea de un vistazo qué hizo
 * cada quién ("Roberto · no contestó · 14:30") y no repita trabajo, sin abrir la
 * página de detalle. No se muestra si no hay intentos previos (pedido fresco).
 */
export default function AttemptHistory({ attempts }: { attempts: AttemptRow[] }) {
  const { nameOf } = useOperatorNames();
  const [expanded, setExpanded] = useState(false);
  const today = useMemo(() => bogotaToday(), []);

  if (!attempts.length) return null;

  const MAX_COLLAPSED = 4;
  const shown = expanded ? attempts : attempts.slice(0, MAX_COLLAPSED);
  const hidden = attempts.length - shown.length;

  return (
    <div className="mb-3 rounded-2xl border border-border bg-card/40 px-3 py-2.5 shadow-card3d hairline-top">
      <div className="hud-label flex items-center gap-1.5 mb-1.5 text-muted-foreground">
        <History size={12} />
        Intentos previos ({attempts.length})
      </div>
      <ul className="space-y-1">
        {shown.map((a, i) => {
          const clock = attemptClock(a);
          const day = attemptDaySuffix(a, today);
          return (
            <li key={a.id || i} className="flex items-center gap-2 text-xs">
              <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${TONE_DOT[attemptTone(a.result)]}`} />
              <span className="font-medium text-foreground truncate max-w-[120px]">{nameOf(a.operator_id)}</span>
              <span className="text-muted-foreground">·</span>
              <span className="text-muted-foreground">{attemptLabel(a.result)}</span>
              {a.result === 'canc' && a.reason && (
                <span className="text-muted-foreground/80 italic truncate max-w-[120px]">({a.reason})</span>
              )}
              <span className="ml-auto text-muted-foreground/70 font-mono tabular-nums shrink-0">
                {day ? `${day} ` : ''}{clock}
              </span>
            </li>
          );
        })}
      </ul>
      {hidden > 0 && (
        <button
          onClick={() => setExpanded(true)}
          className="mt-1 text-[11px] text-primary hover:underline"
        >
          Ver {hidden} más
        </button>
      )}
    </div>
  );
}

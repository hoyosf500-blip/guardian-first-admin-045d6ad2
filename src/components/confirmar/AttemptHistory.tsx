import { useMemo, useState } from 'react';
import { History } from 'lucide-react';
import { useOperatorNames } from '@/hooks/useOperatorNames';
import { attemptLabel, attemptTone, attemptClock, attemptDaySuffix, type AttemptRow } from '@/lib/attemptFormat';
import { bogotaToday } from '@/lib/utils';

/** Nodo del timeline: relleno + halo del mismo tono. El halo (`glow-*`) es lo
 *  que hace legible la secuencia de un vistazo — antes eran cuatro puntitos
 *  planos de 6px del mismo peso visual, indistinguibles sin leer el texto. */
const TONE_DOT: Record<string, string> = {
  green: 'bg-success glow-success',
  red: 'bg-danger glow-danger',
  yellow: 'bg-warning glow-warning',
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
    <div className="mb-3 rounded-2xl border border-border bg-card/40 px-3.5 py-3 shadow-card3d hairline-top">
      <div className="hud-label flex items-center gap-2 mb-2.5 text-muted-foreground">
        <span className="w-7 h-7 rounded-xl bg-muted/60 border border-border flex items-center justify-center flex-shrink-0" aria-hidden="true">
          <History size={13} />
        </span>
        Intentos previos ({attempts.length})
      </div>
      {/* La lista de intentos ES una secuencia en el tiempo, así que se dibuja
          como tal: un riel vertical con un nodo por intento, coloreado por su
          resultado. Los datos (quién, qué, cuándo) son exactamente los mismos;
          lo que cambia es que ahora se ve la CADENA — "la llamaron tres veces
          y las tres no contestó" se lee sin leer. */}
      <ul className="relative space-y-2 pl-5">
        <span
          className="absolute left-[5px] top-1.5 bottom-1.5 w-px bg-gradient-to-b from-border via-border to-transparent"
          aria-hidden="true"
        />
        {shown.map((a, i) => {
          const clock = attemptClock(a);
          const day = attemptDaySuffix(a, today);
          return (
            <li key={a.id || i} className="relative flex items-center gap-2 text-xs">
              <span
                className={`absolute -left-5 top-1/2 -translate-y-1/2 h-2.5 w-2.5 rounded-full ring-2 ring-card shrink-0 ${TONE_DOT[attemptTone(a.result)]}`}
                aria-hidden="true"
              />
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
          className="mt-2 ml-5 text-[11px] font-semibold text-primary hover:underline"
        >
          Ver {hidden} más
        </button>
      )}
    </div>
  );
}

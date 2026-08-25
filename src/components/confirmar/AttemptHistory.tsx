import { useMemo, useState } from 'react';
import { History } from 'lucide-react';
import { useOperatorNames } from '@/hooks/useOperatorNames';
import { attemptLabel, attemptTone, attemptClock, attemptDaySuffix, intentosDeHoy, esIntentoDeLlamada, type AttemptRow } from '@/lib/attemptFormat';
import { MAX_DAILY_ATTEMPTS } from '@/lib/confirmarQueue';
import { haceCuanto } from '@/lib/gestionPorPedido';
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
export default function AttemptHistory({ attempts, loadError }: { attempts: AttemptRow[]; loadError?: boolean }) {
  const { nameOf } = useOperatorNames();
  const [expanded, setExpanded] = useState(false);
  const today = useMemo(() => bogotaToday(), []);

  // Ausencia de intentos y fallo de lectura se ven IGUAL desde afuera, pero
  // significan lo contrario: callar el error deja a la asesora creyendo que
  // nadie llamó y repitiendo la llamada de su compañera.
  if (loadError && !attempts.length) {
    return (
      <div className="mb-3 rounded-2xl border border-warning/30 bg-warning/10 px-3.5 py-2.5 text-[11px] text-warning" role="status">
        No se pudo leer el historial de intentos — puede que ya la hayan llamado.
      </div>
    );
  }

  // ⛔ "Intentos previos" son LLAMADAS, no toques. La ficha contaba
  // `attempts.length` crudo, que incluye ediciones y cambios de transportadora
  // (viven en la misma tabla order_results): "Intentos previos (5)" podía ser 3
  // llamadas + 2 ediciones, y la lista pintaba filas feas "edicion_orden". El
  // dueño se guía por esta etiqueta para saber si YA llamaron al cliente, así
  // que un número inflado lo hace creer que se llamó más de lo que se llamó.
  // Se filtra a llamadas para el conteo Y la lista, con la MISMA regla que el
  // "Hoy N de 3" (esIntentoDeLlamada).
  const llamadas = attempts.filter((a) => esIntentoDeLlamada(a.result));

  if (!llamadas.length) return null;

  const MAX_COLLAPSED = 4;
  const shown = expanded ? llamadas : llamadas.slice(0, MAX_COLLAPSED);
  const hidden = llamadas.length - shown.length;

  // ¿Cuántas llamadas le quedan HOY a este cliente? El tope diario es 3 y sale
  // de la misma constante que usa el cooldown, así que el contador nunca puede
  // desalinearse de la regla real.
  const hoyN = intentosDeHoy(llamadas, today);
  const agotado = hoyN >= MAX_DAILY_ATTEMPTS;
  const pielHoy = agotado
    ? 'bg-danger/15 text-danger border-danger/35'
    : hoyN > 0
      ? 'bg-warning/15 text-warning border-warning/35'
      : 'bg-muted/50 text-muted-foreground border-border';

  return (
    <div className="mb-3 rounded-2xl border border-border bg-card/40 px-3.5 py-3 shadow-card3d hairline-top">
      <div className="hud-label flex items-center gap-2 mb-2.5 text-muted-foreground flex-wrap">
        <span className="w-7 h-7 rounded-xl bg-muted/60 border border-border flex items-center justify-center flex-shrink-0" aria-hidden="true">
          <History size={13} />
        </span>
        Intentos previos ({llamadas.length})
        <span
          className={`ml-auto text-[11px] font-bold px-2 py-0.5 rounded-lg border tabular-nums ${pielHoy}`}
          title={agotado
            ? `Ya se llamó ${MAX_DAILY_ATTEMPTS} veces hoy: el pedido vuelve a la cola mañana`
            : `Quedan ${MAX_DAILY_ATTEMPTS - hoyN} llamada${MAX_DAILY_ATTEMPTS - hoyN === 1 ? '' : 's'} para hoy`}
        >
          Hoy {hoyN} de {MAX_DAILY_ATTEMPTS}
        </span>
      </div>
      {agotado && (
        <p className="-mt-1 mb-2.5 text-[11px] text-danger font-semibold" role="status">
          Ya son {MAX_DAILY_ATTEMPTS} llamadas hoy — vuelve a la cola mañana.
        </p>
      )}
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
          // "hace 20 min" solo para los de HOY: en uno de anteayer sería ruido
          // (ya lo dice el sufijo "2 jul") y el reloj sigue siendo lo útil ahí.
          const cuando = !day && a.created_at ? haceCuanto(a.created_at) : '';
          return (
            <li key={a.id || i} className="relative flex items-center gap-2 text-xs">
              <span
                className={`absolute -left-5 top-1/2 -translate-y-1/2 h-2.5 w-2.5 rounded-full ring-2 ring-card shrink-0 ${TONE_DOT[attemptTone(a.result)]}`}
                aria-hidden="true"
              />
              <span className="font-medium text-foreground truncate max-w-[110px]">{nameOf(a.operator_id)}</span>
              <span className="text-muted-foreground" aria-hidden="true">·</span>
              <span className="text-muted-foreground shrink-0">{attemptLabel(a.result)}</span>
              {/* El motivo se muestra en CUALQUIER resultado, no solo al cancelar:
                  el "pidió llamar mañana" de un no-contestó es justo lo que la
                  siguiente asesora necesita leer, y estaba oculto. */}
              {a.reason && (
                <span className="text-muted-foreground/80 italic truncate min-w-0" title={a.reason}>
                  ({a.reason})
                </span>
              )}
              <span className="ml-auto text-muted-foreground/70 tabular-nums shrink-0">
                {cuando || `${day ? `${day} ` : ''}${clock}`}
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

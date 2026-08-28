import { useState } from 'react';
import { Coffee, X } from 'lucide-react';
import { MOTIVOS_PAUSA, minutosDePausa, etiquetaMotivo, type Pausa } from '@/lib/pausaTrabajo';
import { cn } from '@/lib/utils';

/**
 * "Estoy en otra cosa" — el botón con el que el asesor explica un hueco EN VEZ
 * de que el sistema lo interprete como pereza.
 *
 * Presentación pura: no consulta nada, recibe todo. La plomería está en
 * `usePausaTrabajo` y el porqué en `src/lib/pausaTrabajo.ts`.
 *
 * Vive flotando abajo a la izquierda porque el asesor puede estar en CUALQUIER
 * pantalla cuando se va a la agencia — meterlo en una sola vista sería igual a
 * no tenerlo. Discreto mientras no hay pausa; visible mientras corre, porque
 * una pausa que se olvidó prendida es exactamente lo que no queremos.
 */
export default function BotonPausaTrabajo({ pausa, vigente, trabajando, ahora, onIniciar, onTerminar }: {
  pausa: Pausa | null;
  vigente: boolean;
  trabajando: boolean;
  ahora: number;
  onIniciar: (motivo: string) => void | Promise<unknown>;
  onTerminar: () => void | Promise<unknown>;
}) {
  const [abierto, setAbierto] = useState(false);

  if (vigente && pausa) {
    const min = minutosDePausa(pausa, ahora);
    return (
      <div className="fixed bottom-4 left-4 z-40 flex items-center gap-2 rounded-2xl border border-warning/40 bg-warning/15 px-3.5 py-2.5 shadow-card3d backdrop-blur-0">
        <Coffee size={15} className="text-warning shrink-0" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-xs font-bold text-warning leading-tight truncate max-w-[13rem]">
            {etiquetaMotivo(pausa.motivo)}
          </p>
          {/* El tiempo a la vista: es lo que convierte la pausa en algo que se
              cierra y no en un interruptor que se queda prendido. */}
          <p className="text-[11px] text-warning/80 font-mono tabular-nums leading-tight">
            {min === 0 ? 'recién' : `${min} min`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void onTerminar()}
          disabled={trabajando}
          className="ml-1 rounded-lg border border-warning/40 px-2.5 py-1.5 text-[11px] font-bold text-warning hover:bg-warning/20 transition-colors disabled:opacity-50"
        >
          Ya volví
        </button>
      </div>
    );
  }

  return (
    <div className="fixed bottom-4 left-4 z-40">
      {abierto && (
        <div className="mb-2 w-64 rounded-2xl border border-border bg-card p-2 shadow-card3d">
          <div className="flex items-center justify-between px-1.5 pb-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              ¿En qué estás?
            </span>
            <button
              type="button"
              onClick={() => setAbierto(false)}
              className="text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Cerrar"
            >
              <X size={13} aria-hidden="true" />
            </button>
          </div>
          <div className="flex flex-col gap-1">
            {MOTIVOS_PAUSA.map((m) => (
              <button
                key={m.value}
                type="button"
                disabled={trabajando}
                onClick={async () => { await onIniciar(m.value); setAbierto(false); }}
                className="rounded-xl px-2.5 py-2 text-left text-xs font-medium text-foreground hover:bg-accent/12 hover:text-accent transition-colors disabled:opacity-50"
              >
                {m.label}
              </button>
            ))}
          </div>
          <p className="px-1.5 pt-1.5 text-[10px] leading-snug text-muted-foreground">
            Queda registrado con la hora. No es una falta: es para que se sepa en
            qué estuviste.
          </p>
        </div>
      )}
      <button
        type="button"
        onClick={() => setAbierto((v) => !v)}
        aria-expanded={abierto}
        title="Avisá que estás trabajando fuera del CRM (agencia, transportadora, una llamada larga)"
        className={cn(
          'inline-flex items-center gap-2 rounded-2xl border px-3.5 py-2.5 text-xs font-semibold transition-colors',
          abierto
            ? 'border-accent/40 bg-accent/15 text-accent'
            : 'border-border bg-card/80 text-muted-foreground hover:text-foreground hover:border-border-strong',
        )}
      >
        <Coffee size={14} aria-hidden="true" />
        Estoy en otra cosa
      </button>
    </div>
  );
}

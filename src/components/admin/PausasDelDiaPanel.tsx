import { useState } from 'react';
import { PauseCircle, Loader2, ChevronDown, ChevronUp } from 'lucide-react';
import { usePausasDelDia } from '@/hooks/usePausasDelDia';
import { bogotaToday } from '@/lib/utils';

/**
 * Las pausas declaradas hoy, por persona.
 *
 * La pausa es la explicación que la asesora da de un hueco ("estoy en la
 * agencia"). Existía el botón y la tabla; faltaba que el dueño pudiera verlas
 * juntas. No juzga: muestra cuántas, cuánto duraron y por qué, y deja que
 * quien conoce el turno decida si 4 pausas de 25 min son normales.
 */
const HORA = new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit' });

export default function PausasDelDiaPanel({ storeId, nombreDe }: { storeId: string | null; nombreDe: (id: string) => string }) {
  const { porPersona, estado } = usePausasDelDia(storeId, bogotaToday());
  const [abierto, setAbierto] = useState(false);

  // Sin pausas y con la lectura OK no hace falta ocupar lugar: una línea.
  const total = porPersona.reduce((n, p) => n + p.cantidad, 0);

  return (
    <section className="rounded-2xl border border-border bg-card/40 shadow-card3d overflow-hidden">
      <button
        type="button"
        onClick={() => setAbierto((v) => !v)}
        className="w-full flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-left"
        aria-expanded={abierto}
      >
        <span className="hud-label inline-flex items-center gap-1.5">
          <PauseCircle size={12} aria-hidden="true" /> Pausas declaradas hoy
        </span>
        {estado === 'cargando' && <Loader2 size={12} className="animate-spin text-muted-foreground" aria-hidden="true" />}
        {estado === 'error' && <span className="text-[11px] text-warning">no se pudieron leer</span>}
        {estado === 'ok' && (
          <span className="text-[11px] text-muted-foreground">
            {total === 0 ? 'ninguna' : `${total} · ${porPersona.length} persona${porPersona.length === 1 ? '' : 's'}`}
          </span>
        )}
        <span className="ml-auto text-muted-foreground">{abierto ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span>
      </button>

      {abierto && estado === 'ok' && porPersona.length > 0 && (
        <div className="border-t border-border/60 px-4 py-3 space-y-3">
          {porPersona.map((p) => (
            <div key={p.operatorId}>
              <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
                <span className="font-semibold">{nombreDe(p.operatorId)}</span>
                <span className="text-muted-foreground">
                  {p.cantidad} pausa{p.cantidad === 1 ? '' : 's'}
                  {p.minutos > 0 ? ` · ${p.minutos} min` : ''}
                  {p.abierta ? ' · una sigue abierta' : ''}
                </span>
              </div>
              <ul className="mt-1 space-y-0.5 text-[11px] text-foreground/85">
                {p.pausas.map((x) => (
                  <li key={x.id} className="flex flex-wrap gap-x-2">
                    <span className="font-mono tabular-nums text-muted-foreground">
                      {HORA.format(new Date(x.inicioIso))}
                      {x.finIso ? `–${HORA.format(new Date(x.finIso))}` : '–…'}
                    </span>
                    <span>{x.motivo}{x.nota ? ` — «${x.nota}»` : ''}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

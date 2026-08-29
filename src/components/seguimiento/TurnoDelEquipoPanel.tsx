import { AlertTriangle, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TurnoDelEquipo } from '@/lib/turnoDelEquipo';

/**
 * "El turno de hoy" — la vista de dueño (pieza D del protocolo del turno).
 *
 * Contesta tres cosas y nada más: cuánto de la cola no es de nadie, cuánto le
 * falta a cada asesora, y si el número se puede creer.
 *
 * Por qué existe: `SegCounterBar` esconde el contador de la cola para el dueño
 * (`isAdmin || isOwnerOfActive`), así que hoy **ve menos que su equipo** — fue
 * su queja textual. Alguien asumió que el dueño no trabaja la cola y por eso no
 * necesita el contador; pero él no quiere trabajarla, quiere ver si la están
 * trabajando. Son dos cosas distintas.
 *
 * Presentacional puro: recibe el resumen ya calculado por `turnoDelEquipo` y un
 * resolvedor de nombres. Sin hooks de datos, sin Supabase.
 */

interface Props {
  resumen: TurnoDelEquipo;
  nombreDe: (operatorId: string) => string;
  /** Repartir la cola del día. El botón vive ACÁ y no en una fila propia
   *  (21-ago-2026): repartir es la respuesta directa a leer «N sin dueño», y
   *  tenerlo a treinta centímetros obligaba a cruzar la pantalla entre el dato
   *  y su acción. Además le ahorra una fila entera a la asesora, que no lo ve. */
  onRepartir?: () => void;
  repartiendo?: boolean;
  /**
   * Quién está mirando el panel. Desde el 28-ago-2026 lo ven TODAS, no solo los
   * jefes — y la asesora entraba a buscar su propio nombre entre cuatro filas
   * para saber cuánto le faltaba. Su fila va primera y marcada.
   *
   * `null`/ausente = no se sabe: no se resalta ninguna. Nunca se adivina.
   */
  yoId?: string | null;
}

/** `null` = no se pudo medir. NUNCA se dibuja como 0 — ver la regla en turnoDelEquipo.ts. */
const cifra = (n: number | null) => (n === null ? '—' : String(n));

export default function TurnoDelEquipoPanel({ resumen, nombreDe, onRepartir, repartiendo, yoId }: Props) {
  const { filas, sinDueno, totalAccionable, tocadosTotal, medible } = resumen;

  // Mi fila primero. El orden entre las demás NO se toca (viene calculado desde
  // `turnoDelEquipo`): solo se sube la propia, que es la única que la asesora
  // busca. `sort` de ES2019 es estable, así que el resto queda como estaba.
  const filasOrdenadas = yoId
    ? [...filas].sort((a, b) => Number(b.operatorId === yoId) - Number(a.operatorId === yoId))
    : filas;

  // Sin cola accionable no hay turno que mirar. Dibujar una tabla vacía sería
  // ruido justo en la pantalla que vino a quitar ruido.
  if (totalAccionable === 0) return null;

  const hayCarga = filas.some((f) => f.asignados > 0);

  return (
    <section className="rounded-2xl border border-border bg-card/40 shadow-card3d overflow-hidden">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 border-b border-border/60">
        <span
          className="hud-label inline-flex items-center gap-1.5"
          title="Cuenta la cola accionable de hoy. Un pedido atendido por otra asesora cuenta como gestionado: lo que se mide es si el trabajo se hizo. Los pedidos en tránsito no entran — se vigilan, no se gestionan."
        >
          <Users size={12} aria-hidden="true" /> El turno de hoy
        </span>
        {/* El «X de N gestionados» global se quitó de acá (26-ago-2026): ya lo
            imprime la línea-resumen del hero (visible para TODOS), y este panel
            es manager-only — el dueño lo veía dos veces. Las filas por asesora
            (tocados/asignados) SÍ quedan, que es lo que este panel aporta.
            `tocadosTotal` queda sin uso en el destructuring: es inocuo
            (noUnusedLocals:false) y se deja para no tocar lógica. */}
        {sinDueno > 0 && (
          <span
            className="text-[11px] font-semibold text-warning inline-flex items-center gap-1"
            title="Pedidos accionables que no le tocaron a nadie hoy. Nadie los va a reclamar porque no son de nadie."
          >
            <AlertTriangle size={11} aria-hidden="true" />
            <span className="font-mono tabular-nums">{sinDueno}</span> sin dueño
          </span>
        )}
        {onRepartir && (
          <button
            type="button"
            disabled={repartiendo}
            onClick={onRepartir}
            className="ml-auto shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-accent/40 bg-accent/12 text-accent text-[11px] font-semibold hover:bg-accent/20 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            title="Reparte la cola accionable de hoy entre las asesoras, equilibrando la carga. Volver a correrlo NO le quita el trabajo a quien ya lo tiene."
          >
            <Users size={12} aria-hidden="true" />
            {repartiendo ? 'Repartiendo…' : 'Repartir la cola de hoy'}
          </button>
        )}
      </div>

      {!medible && (
        // HONESTIDAD: si la lectura de gestiones del día falló, los conteos de
        // trabajo salen en "—". Un 0 acá se lee como "no trabajaron" y el dueño
        // le reclama a alguien por un dato que nunca se pudo leer.
        <p className="px-4 py-2 text-[11px] text-muted-foreground border-b border-border/60">
          No se pudo leer lo gestionado hoy. Los pedidos asignados sí son reales; lo trabajado
          se muestra como «—» en vez de cero.
        </p>
      )}

      {!hayCarga ? (
        <p className="px-4 py-3 text-[11px] text-muted-foreground">
          {/* Desde que el panel lo ven TODAS, este texto no puede mandar a
              apretar un botón que la asesora no tiene. */}
          {onRepartir
            ? 'Todavía nadie tiene pedidos asignados hoy. Apretá «Repartir la cola de hoy» para repartirlos entre las asesoras.'
            : 'Todavía nadie tiene pedidos asignados hoy. Mientras tanto la cola es de todas: agarrá de arriba, que es lo más urgente.'}
        </p>
      ) : (
        <ul className="divide-y divide-border/60">
          {filasOrdenadas.map((f) => {
            const falta = f.sinTocar;
            const alDia = falta === 0;
            const esMia = !!yoId && f.operatorId === yoId;
            // De lo que le falta, cuánto SÍ intentó sin que le contestaran. Un
            // "no contestó" deja el pedido pendiente para todo el equipo (por eso
            // no cuenta como gestionado), pero decirle "sin tocar" a quien llamó
            // tres veces es un reclamo injusto — y este panel se mira justamente
            // para decidir a quién reclamarle.
            const intentos = f.intentadosSinRespuesta ?? 0;
            return (
              <li
                key={f.operatorId}
                className={cn(
                  'flex items-center gap-3 px-4 py-2.5',
                  // Riel a la izquierda + fondo tenue: se encuentra de un vistazo
                  // sin gritar. El "Vos" al lado del nombre es lo que de verdad lo
                  // resuelve en blanco y negro o para quien no distinga el tono.
                  esMia && 'relative bg-accent/8',
                )}
              >
                {esMia && (
                  <span className="absolute left-0 top-0 bottom-0 w-[3px] bg-accent" aria-hidden="true" />
                )}
                <span className={cn('min-w-0 flex-1 truncate text-xs font-semibold', esMia && 'text-accent')}>
                  {nombreDe(f.operatorId)}
                  {esMia && <span className="ml-1.5 font-normal text-[10px] uppercase tracking-wide opacity-80">vos</span>}
                </span>

                <span className="shrink-0 text-[11px] text-muted-foreground font-mono tabular-nums">
                  {cifra(f.tocados)}/{f.asignados}
                </span>

                {intentos > 0 && (
                  <span
                    className="shrink-0 text-[10px] text-muted-foreground"
                    title="Llamó y no le contestaron. El pedido sigue pendiente para todo el equipo, pero el intento está hecho."
                  >
                    <span className="font-mono tabular-nums">{intentos}</span> sin respuesta
                  </span>
                )}

                <span
                  className={cn(
                    'shrink-0 min-w-[5.5rem] text-right text-[11px] font-semibold',
                    falta === null ? 'text-muted-foreground'
                      : alDia ? 'text-success'
                      : 'text-warning',
                  )}
                >
                  {falta === null
                    ? '—'
                    : alDia
                      ? 'al día'
                      : <><span className="font-mono tabular-nums">{falta}</span> sin tocar</>}
                </span>
              </li>
            );
          })}
        </ul>
      )}

    </section>
  );
}

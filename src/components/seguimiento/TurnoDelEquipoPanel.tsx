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
}

/** `null` = no se pudo medir. NUNCA se dibuja como 0 — ver la regla en turnoDelEquipo.ts. */
const cifra = (n: number | null) => (n === null ? '—' : String(n));

export default function TurnoDelEquipoPanel({ resumen, nombreDe }: Props) {
  const { filas, sinDueno, totalAccionable, tocadosTotal, medible } = resumen;

  // Sin cola accionable no hay turno que mirar. Dibujar una tabla vacía sería
  // ruido justo en la pantalla que vino a quitar ruido.
  if (totalAccionable === 0) return null;

  const hayCarga = filas.some((f) => f.asignados > 0);

  return (
    <section className="rounded-2xl border border-border bg-card/40 shadow-card3d overflow-hidden">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 border-b border-border/60">
        <span className="hud-label inline-flex items-center gap-1.5">
          <Users size={12} aria-hidden="true" /> El turno de hoy
        </span>
        <span className="text-[11px] text-muted-foreground">
          <span className="font-mono tabular-nums font-semibold text-foreground">{cifra(tocadosTotal)}</span>
          {' de '}
          <span className="font-mono tabular-nums">{totalAccionable}</span>
          {' gestionados'}
        </span>
        {sinDueno > 0 && (
          <span
            className="text-[11px] font-semibold text-warning inline-flex items-center gap-1"
            title="Pedidos accionables que no le tocaron a nadie hoy. Nadie los va a reclamar porque no son de nadie: apretá «Repartir la cola de hoy»."
          >
            <AlertTriangle size={11} aria-hidden="true" />
            <span className="font-mono tabular-nums">{sinDueno}</span> sin dueño
          </span>
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
          Todavía nadie tiene pedidos asignados hoy. Apretá «Repartir la cola de hoy» para
          repartirlos entre las asesoras.
        </p>
      ) : (
        <ul className="divide-y divide-border/60">
          {filas.map((f) => {
            const falta = f.sinTocar;
            const alDia = falta === 0;
            return (
              <li key={f.operatorId} className="flex items-center gap-3 px-4 py-2.5">
                <span className="min-w-0 flex-1 truncate text-xs font-semibold">
                  {nombreDe(f.operatorId)}
                </span>

                <span className="shrink-0 text-[11px] text-muted-foreground font-mono tabular-nums">
                  {cifra(f.tocados)}/{f.asignados}
                </span>

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

      <p className="px-4 py-2 text-[10px] leading-snug text-muted-foreground/70 border-t border-border/60">
        Cuenta la cola accionable de hoy. Un pedido atendido por otra asesora cuenta como
        gestionado: lo que se mide es si el trabajo se hizo. Los pedidos en tránsito no entran —
        se vigilan, no se gestionan.
      </p>
    </section>
  );
}

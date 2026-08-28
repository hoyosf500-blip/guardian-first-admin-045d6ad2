import { Phone } from 'lucide-react';
import { useRecordGestion } from '@/hooks/useRecordGestion';
import { getWhatsAppPhone } from '@/lib/orderUtils';
import { haceCuantoMs, type ActividadChatOrden } from '@/lib/actividadChat';
import { cn } from '@/lib/utils';

/**
 * "Le escribimos y no contestó — ahora toca llamar."
 *
 * ── De dónde sale (28-ago-2026) ─────────────────────────────────────────────
 * Pedido del dueño: *"si mandan la plantilla y no contesta, entonces necesito
 * que llamen"*. Hasta hoy el WhatsApp salía y ahí terminaba el trabajo: nadie
 * volvía a mirar ese pedido hasta que la transportadora lo devolvía. El mensaje
 * es el primer intento, no el trabajo entero.
 *
 * ── Por qué NO registra "Llamé" ─────────────────────────────────────────────
 * Registra `LLAMADA: llamó`, que es un INTENTO — no una gestión cerrada.
 *
 * Poner "Llamé" acá sería repetir un bug que ya costó clientes (documentado en
 * `segMetodosEstado.ts`): "Llamé" es contacto EFECTIVO, esconde la tarjeta para
 * todo el equipo el resto del día, y este botón se toca ANTES de saber si
 * alguien atendió. El que no contestó a la primera se volvería invisible y nadie
 * lo volvería a llamar — justo el cliente que estamos tratando de rescatar.
 *
 * Después de colgar, la asesora marca el desenlace con la botonera que ya está
 * en la tarjeta ("Llamé" o "No contestó"). Ese segundo toque es el que lleva la
 * información, y es el que baja el contador.
 */
export default function BotonLlamar({ phone, countryCode, actividad, estado, className, onLlamado }: {
  phone?: string | null;
  countryCode?: string | null;
  /** Para decir hace cuánto salió el mensaje que no contestaron. */
  actividad?: ActividadChatOrden | null;
  estado?: string | null;
  className?: string;
  onLlamado?: () => void;
}) {
  const recordContacto = useRecordGestion();
  if (!phone) return null;

  const desde = actividad?.salienteAt ?? null;
  // Solo se dice "sin contestar hace X" si sabemos de cuándo es el mensaje. Sin
  // esa fecha el botón se dibuja igual pero sin la frase: mejor un botón sin
  // explicación que una explicación inventada.
  const hace = desde != null ? haceCuantoMs(desde) : null;

  return (
    <a
      href={'tel:+' + getWhatsAppPhone(phone, countryCode)}
      onClick={(e) => {
        e.stopPropagation();
        void recordContacto(phone, 'LLAMADA', 'llamó');
        onLlamado?.();
      }}
      title={`Le escribimos${hace ? ` ${hace}` : ''} y no contestó. Después de llamar, marcá si contestó o no.`}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-lg border border-warning/45 bg-warning/14 px-2.5 py-1.5',
        'text-[11px] font-bold text-warning no-underline hover:bg-warning/22 transition-colors',
        className,
      )}
    >
      <Phone size={12} aria-hidden="true" />
      <span className="truncate">
        Llamar{hace ? <span className="font-normal text-warning/80"> · sin contestar {hace}</span> : null}
      </span>
      <span className="sr-only">{estado ? ` (pedido ${estado})` : ''}</span>
    </a>
  );
}

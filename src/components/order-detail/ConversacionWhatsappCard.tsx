import { useMemo } from 'react';
import { motion } from 'framer-motion';
import { MessagesSquare, RefreshCw } from 'lucide-react';
import { useStore } from '@/contexts/StoreContext';
import { useRiesgoChat } from '@/hooks/useRiesgoChat';
import { useConversacion } from '@/hooks/useConversacion';
import ConversacionChat from '@/components/seguimiento/ConversacionChat';

/**
 * La conversación de WhatsApp REAL del cliente, al lado de sus datos.
 *
 * ⚠️ No se confunde con la "Bitácora de comunicaciones" de más abajo: aquella
 * registra lo que hizo GUARDIAN (llamadas marcadas, notas, gestiones); ésta
 * muestra lo que pasó en WhatsApp de verdad, según ImporChat, con el nombre de
 * quien escribió cada mensaje.
 *
 * ── Cuándo se dibuja, y por qué no siempre ─────────────────────────────────
 * Leer el hilo abre una conexión al socket de ImporChat. Hacerlo en CADA ficha
 * que se abre sería llamar a un tercero por curiosear, y en las tiendas que no
 * usan ImporChat (los otros dueños, que usan otras IA) sería una llamada que
 * siempre falla.
 *
 * Por eso primero se pregunta —con una consulta barata a la base, la misma que
 * usa el tablero (`useRiesgoChat`)— si ESTE pedido tiene conversación leída. Si
 * no la tiene, la tarjeta **no existe**: nada de un panel vacío que parezca
 * roto. Si la tiene, el hilo se carga solo, porque en esta pantalla la
 * conversación no es un extra, es la zona de trabajo.
 */
export default function ConversacionWhatsappCard({ externalId, orderId }: {
  externalId?: string | null;
  orderId?: string | null;
}) {
  const { activeStoreId } = useStore();
  const ids = useMemo(() => (orderId ? [orderId] : []), [orderId]);
  // Devuelve `actividad` solo para los pedidos con la conversación YA leída:
  // sin lectura no se afirma nada (ver el hook).
  const { actividad } = useRiesgoChat(activeStoreId, ids);
  const hayConversacion = !!orderId && actividad.has(orderId);

  const hilo = useConversacion(externalId, hayConversacion);

  if (!externalId || !hayConversacion) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="hairline-top bg-card/40 border border-border rounded-2xl p-5 shadow-card3d transition-colors duration-200 hover:border-border-strong flex flex-col h-full"
    >
      <h3 className="text-sm font-semibold text-foreground flex items-center gap-2 mb-4">
        <span className="w-9 h-9 rounded-xl bg-success/14 border border-success/30 text-success glow-success flex items-center justify-center flex-shrink-0" aria-hidden="true">
          <MessagesSquare size={17} />
        </span>
        Conversación de WhatsApp
        <button
          type="button"
          onClick={hilo.recargar}
          disabled={hilo.estado === 'cargando'}
          className="ml-auto text-muted-foreground hover:text-foreground disabled:opacity-40 transition-colors"
          aria-label="Actualizar la conversación"
          title="Actualizar"
        >
          <RefreshCw size={14} className={hilo.estado === 'cargando' ? 'animate-spin' : ''} aria-hidden="true" />
        </button>
      </h3>

      <ConversacionChat
        mensajes={hilo.mensajes}
        estado={hilo.estado}
        error={hilo.error}
        onRecargar={hilo.recargar}
        mostrarEncabezado={false}
        altoClase="min-h-[260px] max-h-[440px]"
        className="border-0 bg-transparent flex-1"
      />
    </motion.div>
  );
}

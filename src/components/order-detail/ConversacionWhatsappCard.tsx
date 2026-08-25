import { useState } from 'react';
import { motion } from 'framer-motion';
import { MessagesSquare, RefreshCw } from 'lucide-react';
import { useConversacion } from '@/hooks/useConversacion';
import ConversacionChat from '@/components/seguimiento/ConversacionChat';

/**
 * La conversación de WhatsApp REAL del cliente, dentro de la ficha del pedido.
 *
 * ⚠️ No se confunde con la "Bitácora de comunicaciones", que está al lado:
 * aquella registra lo que hizo GUARDIAN (llamadas marcadas, notas, gestiones);
 * ésta muestra lo que pasó en WhatsApp de verdad, según ImporChat, con el
 * nombre de quien escribió cada mensaje.
 *
 * ── Por qué NO carga sola ──────────────────────────────────────────────────
 * Leer el hilo abre una conexión al socket de ImporChat. Hacerlo en cada
 * apertura de ficha sería una llamada a un tercero por curiosear, y en las
 * tiendas que no usan ImporChat (los otros dueños, que usan otras IA) sería
 * una llamada que siempre falla. Se pide cuando alguien la pide.
 */
export default function ConversacionWhatsappCard({ externalId }: { externalId?: string | null }) {
  const [abierto, setAbierto] = useState(false);
  const hilo = useConversacion(externalId, abierto);

  if (!externalId) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="hairline-top bg-card/40 border border-border rounded-2xl p-5 shadow-card3d transition-colors duration-200 hover:border-border-strong flex flex-col"
    >
      <h3 className="text-sm font-semibold text-foreground flex items-center gap-2 mb-4">
        <span className="w-9 h-9 rounded-xl bg-accent/14 border border-accent/30 text-accent glow-accent flex items-center justify-center flex-shrink-0" aria-hidden="true">
          <MessagesSquare size={17} />
        </span>
        Conversación de WhatsApp
        {abierto && hilo.estado !== 'sin_config' && (
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
        )}
      </h3>

      {!abierto ? (
        <div className="flex flex-col items-start gap-2.5">
          <p className="text-xs text-muted-foreground leading-relaxed">
            Lo que se habló con el cliente por WhatsApp, con el nombre de quien escribió cada
            mensaje. Se lee en vivo de ImporChat.
          </p>
          <button
            type="button"
            onClick={() => setAbierto(true)}
            className="btn-accent-3d inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-bold"
          >
            <MessagesSquare size={13} aria-hidden="true" />
            Ver la conversación
          </button>
        </div>
      ) : hilo.estado === 'sin_config' ? (
        // Una tienda sin ImporChat no ve un panel roto: ve por qué no hay nada.
        <p className="text-xs text-muted-foreground">
          Esta tienda no tiene WhatsApp conectado a Guardian.
        </p>
      ) : (
        <ConversacionChat
          mensajes={hilo.mensajes}
          estado={hilo.estado}
          error={hilo.error}
          onRecargar={hilo.recargar}
          mostrarEncabezado={false}
          className="border-0 bg-transparent"
        />
      )}
    </motion.div>
  );
}

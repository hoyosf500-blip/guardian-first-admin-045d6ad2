import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { MessagesSquare, RefreshCw, Send, Bot } from 'lucide-react';
import { useStore } from '@/contexts/StoreContext';
import { useRiesgoChat } from '@/hooks/useRiesgoChat';
import { useConversacion } from '@/hooks/useConversacion';
import ConversacionChat from '@/components/seguimiento/ConversacionChat';
import EscribirWhatsappDialog from '@/components/seguimiento/EscribirWhatsappDialog';
import { ultimoAutorNegocio } from '@/lib/conversacion';
import { estadoConversacion, haceCuantoMs } from '@/lib/actividadChat';
import { RIESGO_INFO } from '@/lib/riesgoChat';
import type { DatosPedido } from '@/lib/plantillasMeta';
import { cn } from '@/lib/utils';

/**
 * El WhatsApp REAL del cliente, dentro de Guardian: qué pasó y cómo responder.
 *
 * ⚠️ Es UN SOLO componente, usado por la ficha del pedido y por el modo llamada
 * de Confirmar. Antes de esto la ficha tenía su propia versión; duplicarlo es
 * exactamente el error de `ProductoTile` (dos copias, se arregla una, el bug
 * reaparece en la otra pantalla).
 *
 * No se confunde con la "Bitácora de comunicaciones": aquella registra lo que
 * hizo GUARDIAN (llamadas marcadas, notas); ésta muestra lo que pasó en
 * WhatsApp de verdad, según ImporChat, con el nombre de quien escribió.
 *
 * ── Cuándo se dibuja, y por qué no siempre ─────────────────────────────────
 * Leer el hilo abre una conexión al socket de ImporChat. Hacerlo en CADA ficha
 * sería llamar a un tercero por curiosear, y en las tiendas que no usan
 * ImporChat sería una llamada que siempre falla. Por eso primero se pregunta
 * —con una consulta barata a la base (`useRiesgoChat`)— si ESTE pedido tiene
 * conversación leída. Si no, el componente **no existe**: nada de un panel
 * vacío que parezca roto.
 *
 * Esa misma consulta trae gratis las dos señales de arriba (el botón de
 * confirmar y la actividad), así que mostrarlas no cuesta una query extra.
 */
export default function ChatClienteCard({
  externalId, orderId, nombre, estado, datos,
  mostrarEscribir = false, mostrarSenales = false, altoClase, className,
}: {
  externalId?: string | null;
  orderId?: string | null;
  nombre?: string | null;
  estado?: string | null;
  datos?: DatosPedido;
  /** Botón "Escribirle" dentro de la tarjeta. La ficha del pedido ya tiene el
   *  suyo arriba, así que ahí va en `false` para no ofrecer lo mismo dos veces. */
  mostrarEscribir?: boolean;
  /** El resumen de arriba: qué hizo el cliente con el botón del bot y quién
   *  escribió lo último. Es lo que la asesora necesita ANTES de llamar. */
  mostrarSenales?: boolean;
  altoClase?: string;
  className?: string;
}) {
  const { activeStoreId } = useStore();
  const [escribiendo, setEscribiendo] = useState(false);
  const ids = useMemo(() => (orderId ? [orderId] : []), [orderId]);
  const { actividad, index: riesgoIndex } = useRiesgoChat(activeStoreId, ids);
  const act = orderId ? actividad.get(orderId) ?? null : null;
  const riesgo = orderId ? riesgoIndex.get(orderId) ?? null : null;
  const hayConversacion = !!orderId && actividad.has(orderId);

  const hilo = useConversacion(externalId, hayConversacion);

  // Quién mandó lo último que salió del negocio. Se lee del HILO, que trae el
  // nombre por mensaje — `chat_saliente_tipo` solo dice plantilla-o-texto, y
  // desde que Guardian también manda plantillas eso ya no distingue al bot.
  const autor = useMemo(
    () => (hilo.estado === 'ok' ? ultimoAutorNegocio(hilo.mensajes) : null),
    [hilo.estado, hilo.mensajes],
  );
  const conversacion = estadoConversacion(act);

  if (!externalId || !hayConversacion) return null;

  const info = riesgo ? RIESGO_INFO[riesgo] : null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        'hairline-top bg-card/40 border border-border rounded-2xl p-5 shadow-card3d transition-colors duration-200 hover:border-border-strong flex flex-col',
        className,
      )}
    >
      <h3 className="text-sm font-semibold text-foreground flex items-center gap-2 mb-3">
        <span className="w-9 h-9 rounded-xl bg-success/14 border border-success/30 text-success glow-success flex items-center justify-center flex-shrink-0" aria-hidden="true">
          <MessagesSquare size={17} />
        </span>
        WhatsApp del cliente
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

      {mostrarSenales && (
        <div className="space-y-2 mb-3">
          {/* Qué hizo el cliente con el botón del mensaje automático. La tasa
              va al lado a propósito: sin ella el chip es una opinión. */}
          {info && (
            <div className={cn('rounded-xl border px-3 py-2', info.clase)}>
              <p className="text-[11px] font-bold leading-tight">
                {info.etiqueta} <span className="font-normal opacity-80">· {info.tasa}</span>
              </p>
              <p className="text-[11px] leading-snug opacity-90 mt-0.5">{info.que}</p>
            </div>
          )}

          {/* Quién escribió lo último. El NOMBRE, no una etiqueta inventada:
              Guardian no puede saber si "Dropi Status" es un robot, pero quien
              mira la pantalla lo sabe de un vistazo. */}
          {autor && (
            <p className="text-[11px] text-muted-foreground flex items-start gap-1.5">
              <Bot size={12} className="shrink-0 mt-0.5 opacity-70" aria-hidden="true" />
              <span>
                Lo último que salió lo escribió <span className="font-semibold text-foreground">{autor.autor}</span>
                {autor.fechaMs != null && `, ${haceCuantoMs(autor.fechaMs)}`}
                {conversacion === 'espera_respuesta' && (
                  <span className="text-warning font-semibold"> · el cliente contestó y quedó esperando</span>
                )}
                {conversacion === 'sin_respuesta' && ' · el cliente nunca contestó'}
              </span>
            </p>
          )}
        </div>
      )}

      <ConversacionChat
        mensajes={hilo.mensajes}
        estado={hilo.estado}
        error={hilo.error}
        onRecargar={hilo.recargar}
        mostrarEncabezado={false}
        altoClase={altoClase ?? 'min-h-[260px] max-h-[440px]'}
        className="border-0 bg-transparent flex-1"
      />

      {mostrarEscribir && (
        <button
          type="button"
          onClick={() => setEscribiendo(true)}
          className="mt-3 w-full inline-flex items-center justify-center gap-2 rounded-xl bg-success/14 border border-success/30 text-success text-sm font-semibold py-2.5 hover:bg-success/20 hover:border-success/50 transition-colors focus-visible:ring-2 focus-visible:ring-success focus-visible:outline-none"
        >
          <Send size={14} aria-hidden="true" /> Escribirle
        </button>
      )}

      {escribiendo && (
        <EscribirWhatsappDialog
          open={escribiendo}
          onOpenChange={setEscribiendo}
          externalId={String(externalId)}
          nombre={nombre}
          estado={estado}
          actividad={act}
          datos={datos}
          onEnviado={hilo.recargar}
        />
      )}
    </motion.div>
  );
}

import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { MessagesSquare, RefreshCw, Send, Bot, Clock } from 'lucide-react';
import { useStore } from '@/contexts/StoreContext';
import { useRiesgoChat } from '@/hooks/useRiesgoChat';
import { useConversacion } from '@/hooks/useConversacion';
import ConversacionChat from '@/components/seguimiento/ConversacionChat';
import EscribirWhatsappDialog from '@/components/seguimiento/EscribirWhatsappDialog';
import type { ModuloEnvio } from '@/hooks/useEnviarWhatsapp';
import { ultimoAutorNegocio } from '@/lib/conversacion';
import { estadoConversacion, haceCuantoMs } from '@/lib/actividadChat';
import { ventanaWhatsapp } from '@/lib/ventanaWhatsapp';
import { RIESGO_INFO, type NivelRiesgo } from '@/lib/riesgoChat';
import type { ActividadChatOrden } from '@/lib/actividadChat';
import type { DatosPedido } from '@/lib/plantillasMeta';
import { cn } from '@/lib/utils';

/** Lo que hay que saber de un pedido ANTES de tocar el chat: si tiene
 *  conversación leída, qué hizo el cliente con el botón del bot, y cuándo
 *  habló cada lado. Sale de una sola consulta barata (`useRiesgoChat`). */
export interface SenalesChat {
  hayConversacion: boolean;
  actividad: ActividadChatOrden | null;
  riesgo: NivelRiesgo | null;
}

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
  externalId, orderId, nombre, estado, phone, datos, senales, modulo,
  mostrarEscribir = false, mostrarSenales = false, altoClase, className,
}: {
  externalId?: string | null;
  orderId?: string | null;
  nombre?: string | null;
  /** ⛔ SIN ESTO EL CONTADOR NO BAJA. `touchpoints` no está en la publicación
   *  de realtime, así que la ÚNICA vía para que la cobertura del día se entere
   *  de un WhatsApp enviado es el evento local `emitirGestion` — que solo se
   *  emite `if (gestion?.phone)`. Ver `EscribirWhatsappDialog`. */
  phone?: string | null;
  estado?: string | null;
  datos?: DatosPedido;
  /**
   * Las señales ya consultadas por quien llama, para no pedirlas dos veces.
   *
   * `undefined` = la tarjeta las busca sola (así la usa la ficha del pedido).
   * En Confirmar las pide CallView, porque además las necesita para decidir si
   * el botón de arriba abre el chat de Guardian o cae a `wa.me`.
   */
  senales?: SenalesChat;
  /** Prefijo del touchpoint: ver `EscribirWhatsappDialog`. */
  modulo?: ModuloEnvio;
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
  // Si las señales vienen de afuera, no se vuelve a consultar: ids vacío hace
  // que el hook corte antes de tocar la base.
  const ids = useMemo(() => (orderId && !senales ? [orderId] : []), [orderId, senales]);
  const propio = useRiesgoChat(activeStoreId, ids);
  const act = senales ? senales.actividad : (orderId ? propio.actividad.get(orderId) ?? null : null);
  const riesgo = senales ? senales.riesgo : (orderId ? propio.index.get(orderId) ?? null : null);
  const hayConversacion = senales ? senales.hayConversacion : (!!orderId && propio.actividad.has(orderId));

  const hilo = useConversacion(externalId, hayConversacion);

  // Quién mandó lo último que salió del negocio. Se lee del HILO, que trae el
  // nombre por mensaje — `chat_saliente_tipo` solo dice plantilla-o-texto, y
  // desde que Guardian también manda plantillas eso ya no distingue al bot.
  const autor = useMemo(
    () => (hilo.estado === 'ok' ? ultimoAutorNegocio(hilo.mensajes) : null),
    [hilo.estado, hilo.mensajes],
  );
  const conversacion = estadoConversacion(act);

  // La ventana la manda el hilo RECIÉN leído; mientras no esté, la sincronizada.
  // Nunca se asume "abierta" por no saber: `sin_dato` se dibuja como "viendo".
  const ventana = useMemo(() => {
    if (hilo.estado === 'ok' && hilo.ventana) {
      return { estado: hilo.ventana.estado, restanteMs: hilo.ventana.restanteMs };
    }
    return ventanaWhatsapp(act?.entranteAt ?? null, !!act);
  }, [hilo.estado, hilo.ventana, act]);

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

      {/* Cómo se le puede escribir, ANTES de abrir el cuadro.
          Sin esto el botón dice "Escribirle" para todos y la asesora se entera
          recién adentro, dos segundos después, de que a éste solo le entra una
          plantilla. Medido el 25-ago sobre los 157 pendientes de esta tienda:
          55 aceptan texto libre, 77 NUNCA escribieron y 25 escribieron hace
          más de 24 h — o sea que a DOS DE CADA TRES el aviso les aplica. */}
      {mostrarEscribir && (
        <>
          <p className="mt-3 text-[11px] flex items-center gap-1.5">
            <Clock size={12} className="shrink-0 opacity-70" aria-hidden="true" />
            {ventana.estado === 'abierta' ? (
              <span className="text-success">
                Se le puede escribir a mano por{' '}
                {ventana.restanteMs == null ? '' : `${Math.max(1, Math.round(ventana.restanteMs / 3600_000))} h más`}
              </span>
            ) : ventana.estado === 'sin_dato' ? (
              // ⛔ No se sabe todavía: no se afirma ni que sí ni que no.
              <span className="text-muted-foreground">Viendo cómo se le puede escribir…</span>
            ) : (
              <span className="text-muted-foreground">
                {ventana.estado === 'nunca_escribio'
                  ? 'Nunca escribió, así que solo le entra una plantilla'
                  : 'Pasaron más de 24 h: solo le entra una plantilla'}
              </span>
            )}
          </p>
          <button
            type="button"
            onClick={() => setEscribiendo(true)}
            className="mt-2 w-full inline-flex items-center justify-center gap-2 rounded-xl bg-success/14 border border-success/30 text-success text-sm font-semibold py-2.5 hover:bg-success/20 hover:border-success/50 transition-colors focus-visible:ring-2 focus-visible:ring-success focus-visible:outline-none"
          >
            <Send size={14} aria-hidden="true" />
            {ventana.estado === 'abierta' ? 'Escribirle' : 'Mandarle una plantilla'}
          </button>
        </>
      )}

      {escribiendo && (
        <EscribirWhatsappDialog
          open={escribiendo}
          onOpenChange={setEscribiendo}
          externalId={String(externalId)}
          nombre={nombre}
          estado={estado}
          phone={phone}
          actividad={act}
          datos={datos}
          modulo={modulo}
          onEnviado={hilo.recargar}
        />
      )}
    </motion.div>
  );
}

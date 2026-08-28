import { useCallback, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useStore } from '@/contexts/StoreContext';
import { useAuth } from '@/contexts/AuthContext';
import { emitirGestion } from '@/lib/eventosGestion';
import type { MensajeConversacion } from '@/lib/conversacion';
import { motivoEdge, cuerpoDelError } from '@/lib/errorEdge';

/**
 * Manda un WhatsApp al cliente SIN salir de Guardian (edge `importchat-send`).
 *
 * No decide nada por su cuenta: la ventana de 24 h, el chat_id y la credencial
 * los valida el servidor. Acá solo se traduce el resultado a algo que la
 * asesora pueda leer.
 *
 * Nunca lanza: devuelve `{ok, error}` y la pantalla degrada sin romperse. Y
 * `ok:true` significa **confirmado en el chat**, no "se emitió": la función
 * relee la conversación antes de contestar que sí.
 */
/**
 * Desde qué pantalla se escribió. Decide el PREFIJO del touchpoint, y eso no
 * es cosmético: `SEG:%` cuenta como gestión de Seguimiento. Escribirle a un
 * cliente desde Confirmar es un intento de contacto —la gestión ahí es
 * confirmar o cancelar—, así que va con `WHATSAPP:`.
 */
export type ModuloEnvio = 'SEG' | 'WHATSAPP';

export interface ResultadoEnvio {
  ok: boolean;
  error?: string;
  /** El hilo tal como quedó DESPUÉS del envío: la función ya releyó el chat
   *  para verificar, así que devolverlo no cuesta una vuelta extra. */
  mensajes?: MensajeConversacion[];
}

/**
 * Lovable NO redespliega edge functions solo con hacer push: el código llega a
 * GitHub y la función puede seguir sin existir en el servidor. El gateway
 * contesta `NOT_FOUND` y supabase-js lo traduce a "Edge Function returned a
 * non-2xx status code" — un texto que no le dice NADA a la asesora, que se
 * queda sin saber si el cliente recibió el mensaje o no.
 */
export const FALTA_DESPLEGAR =
  'El envío desde Guardian todavía no está activado en el servidor. Escribile desde ImporChat y avisá para que lo activen.';

/**
 * Datos para que la gestión que el SERVIDOR registra se vea en la pantalla al
 * instante y con el nombre correcto.
 *
 * ⛔ Sin esto vuelve el bug del contador: el touchpoint lo inserta la edge
 * function, así que `useRecordGestion` no corre y nadie avisa a `OrderContext`
 * — el pedido quedaba gestionado en la base y pendiente en la pantalla hasta
 * recargar, que es exactamente lo que le pasaba al asesor que marcaba y no
 * veía bajar el número.
 */
export interface GestionDelEnvio {
  /** La clave con la que Seguimiento cruza las gestiones. */
  phone?: string | null;
  /** Qué se hizo, en el idioma de la botonera ("Avisé: en oficina"). Viaja al
   *  servidor para que la bitácora no quede llena de "Escribí por WhatsApp",
   *  que no dice cuál de las seis gestiones fue. */
  accion?: string;
}

export function useEnviarWhatsapp() {
  const { activeStoreId } = useStore();
  const { user } = useAuth();
  const [enviando, setEnviando] = useState(false);

  const enviar = useCallback(async (externalId: string, mensaje: string, modulo?: ModuloEnvio, gestion?: GestionDelEnvio): Promise<ResultadoEnvio> => {
    if (!activeStoreId) return { ok: false, error: 'No hay tienda activa' };
    const texto = mensaje.trim();
    if (!texto) return { ok: false, error: 'Escribí un mensaje' };
    setEnviando(true);
    try {
      const { data, error } = await supabase.functions.invoke('importchat-send', {
        // `accion` es ADITIVO: un servidor viejo (Lovable no redespliega edge
        // functions con un push) lo ignora y escribe el texto genérico de
        // siempre. Sigue contando como gestión; solo se pierde el detalle.
        body: { store_id: activeStoreId, external_id: externalId, mensaje: texto, modulo, accion: gestion?.accion },
      });
      if (error) {
        // El cuerpo del error trae el motivo REAL (ventana vencida, sin chat
        // leído, credencial vencida). Sin esto la asesora solo vería "falló".
        // Y si NI SIQUIERA se llegó a la función, supabase-js devuelve un texto
        // en inglés sin cuerpo que se colaba tal cual a la pantalla — lo
        // traduce `motivoEdge`, que es donde está probado.
        const { detalle } = motivoEdge(error, await cuerpoDelError(error), FALTA_DESPLEGAR, 'No se pudo enviar');
        return { ok: false, error: detalle };
      }
      const r = data as { ok?: boolean; error?: string; mensajes?: MensajeConversacion[] } | null;
      if (!r?.ok) return { ok: false, error: r?.error || 'No se pudo confirmar el envío' };
      // Recién con el envío CONFIRMADO por el servidor. El prefijo tiene que
      // ser el mismo que arma la edge function (`SEG` salvo desde Confirmar),
      // porque solo `SEG:` cuenta como gestión de Seguimiento.
      if (gestion?.phone) {
        emitirGestion({
          phone: gestion.phone,
          modulo: modulo === 'WHATSAPP' ? 'WHATSAPP' : 'SEG',
          accion: gestion.accion || 'Escribí por WhatsApp',
          operatorId: user?.id ?? null,
          at: new Date().toISOString(),
        });
      }
      return { ok: true, mensajes: r.mensajes };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'No se pudo enviar' };
    } finally {
      setEnviando(false);
    }
  }, [activeStoreId, user]);

  return { enviar, enviando };
}

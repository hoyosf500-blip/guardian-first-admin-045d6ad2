import { useCallback, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useStore } from '@/contexts/StoreContext';
import type { MensajeConversacion } from '@/lib/conversacion';

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

export function useEnviarWhatsapp() {
  const { activeStoreId } = useStore();
  const [enviando, setEnviando] = useState(false);

  const enviar = useCallback(async (externalId: string, mensaje: string): Promise<ResultadoEnvio> => {
    if (!activeStoreId) return { ok: false, error: 'No hay tienda activa' };
    const texto = mensaje.trim();
    if (!texto) return { ok: false, error: 'Escribí un mensaje' };
    setEnviando(true);
    try {
      const { data, error } = await supabase.functions.invoke('importchat-send', {
        body: { store_id: activeStoreId, external_id: externalId, mensaje: texto },
      });
      if (error) {
        // El cuerpo del error trae el motivo REAL (ventana vencida, sin chat
        // leído, credencial vencida). Sin esto la asesora solo vería "falló".
        let detalle = '';
        try {
          const ctx = (error as { context?: { json?: () => Promise<{ error?: string; code?: string }> } }).context;
          const cuerpo = ctx?.json ? await ctx.json() : null;
          detalle = cuerpo?.error ?? '';
          if (!detalle && cuerpo?.code === 'NOT_FOUND') detalle = FALTA_DESPLEGAR;
        } catch { /* el cuerpo no era JSON */ }
        return { ok: false, error: detalle || error.message || 'No se pudo enviar' };
      }
      const r = data as { ok?: boolean; error?: string; mensajes?: MensajeConversacion[] } | null;
      if (!r?.ok) return { ok: false, error: r?.error || 'No se pudo confirmar el envío' };
      return { ok: true, mensajes: r.mensajes };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'No se pudo enviar' };
    } finally {
      setEnviando(false);
    }
  }, [activeStoreId]);

  return { enviar, enviando };
}

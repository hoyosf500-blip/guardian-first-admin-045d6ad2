import { useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useStore } from '@/contexts/StoreContext';
import { useRecordGestion } from '@/hooks/useRecordGestion';
import { summarizeReminder } from '@/lib/reminders';

/**
 * REAGENDAR un pedido: el cliente lo quiere, pero después.
 *
 * EL PROBLEMA QUE RESUELVE
 * Hasta hoy, "ahora no tengo plata, llamame el viernes" solo tenía una salida en
 * el modal: CANCELADO. Se estaba tirando a la basura una venta que seguía viva, y
 * de paso inflando la propia tasa de cancelación con pedidos que nunca se
 * perdieron.
 *
 * ⚠️ NO PASA POR `markResult`, Y ESO NO ES UN ATAJO
 * `OrderContext.markResult` arranca con `if (!user || order.result) return`. Si
 * reagendar escribiera un `result`, ese pedido quedaría marcado y **la asesora no
 * podría confirmarlo nunca más** — justo el pedido que reagendó para poder
 * venderlo. Por eso acá no se toca `order_results` ni `orders.estado`: el pedido
 * queda intacto en PENDIENTE CONFIRMACION y no se empuja nada a Dropi.
 *
 * CÓMO VUELVE A LA COLA (sin una sola tabla nueva)
 * La máquina ya existía: `notes.remind_at` → `useOrderNotesIndex` →
 * `nextReminderAt` → `hasDueReminder` → `BUCKET_REMINDER` (= 0, el tope) en
 * `compareConfirmar`. Escribir la nota con recordatorio ES el reagendamiento; el
 * día que vence, el pedido sube solo a lo más alto de la cola.
 *
 * DOS ESCRITURAS, NINGUNA MIGRACIÓN
 *   1. `notes`  → la nota con `remind_at` (lo que hace que vuelva).
 *   2. touchpoint `REAGENDA: ...` vía useRecordGestion → deja rastro de quién y
 *      cuándo, para que el reporte de cancelaciones pueda contar las "reagendas
 *      quemadas" (pedidos reagendados que igual terminaron cancelados).
 *
 * El prefijo `REAGENDA:` del touchpoint es el contrato que después lee la RPC del
 * reporte. Cambiarlo acá sin cambiarlo allá deja el contador en cero en silencio.
 */

/** Prefijo canónico de la nota. Lo lee la RPC `cancelaciones_analisis`. */
export const REAGENDA_NOTE_PREFIX = 'REAGENDA:';

export interface ReagendarParams {
  /** `orders.id` (el UUID interno, no el external_id). */
  orderId: string | null | undefined;
  phone: string | null | undefined;
  /** Cuándo volver a llamar. */
  remindAt: Date;
  /** Lo que dijo el cliente. Opcional pero es lo que hace útil el recordatorio. */
  motivo?: string;
}

/**
 * Una sola forma con campos opcionales, NO una unión discriminada: este repo
 * compila con `strict: false` y ahí TS no estrecha `{ok:true}|{ok:false}` — el
 * call-site no podría leer `.error` ni con un `if (!res.ok)` delante.
 */
export interface ReagendarResult {
  ok: boolean;
  /** Solo cuando ok=false. */
  error?: string;
  /** Solo cuando ok=true: el timestamp guardado. */
  remindAt?: string;
  /** Solo cuando ok=true: "mañana 9:00 am" para el toast. */
  resumen?: string;
}

export function useReagendarPedido() {
  const { user } = useAuth();
  const { activeStoreId } = useStore();
  const recordContacto = useRecordGestion();

  return useCallback(async (params: ReagendarParams): Promise<ReagendarResult> => {
    const { orderId, phone, remindAt, motivo } = params;
    if (!user || !activeStoreId) return { ok: false, error: 'sin usuario o tienda activa' };
    if (!orderId) return { ok: false, error: 'el pedido no tiene ID en la base' };
    if (!(remindAt instanceof Date) || Number.isNaN(remindAt.getTime())) {
      return { ok: false, error: 'fecha de recordatorio inválida' };
    }
    // Reagendar para el pasado no reagenda nada: el recordatorio nacería vencido
    // y el pedido volvería a la cola de inmediato, que es lo contrario de lo
    // que la asesora quiso hacer.
    if (remindAt.getTime() <= Date.now()) {
      return { ok: false, error: 'la fecha tiene que ser a futuro' };
    }

    const nota = (motivo || '').trim().slice(0, 180);
    const iso = remindAt.toISOString();

    // 1) La nota con recordatorio: ESTO es lo que lo trae de vuelta a la cola.
    //    Si falla, no hay reagendamiento — se corta acá y se le dice a la
    //    asesora, en vez de dejarla creyendo que quedó agendado.
    const { error } = await supabase.from('notes').insert({
      order_id: orderId,
      phone: phone || '',
      note_text: nota ? `${REAGENDA_NOTE_PREFIX} ${nota}` : REAGENDA_NOTE_PREFIX,
      operator_id: user.id,
      store_id: activeStoreId,
      remind_at: iso,
    });
    if (error) return { ok: false, error: error.message };

    // 2) El rastro de gestión. Es auditoría: si falla, el reagendamiento YA
    //    quedó hecho y romper la pantalla por esto sería peor que perder una
    //    línea de auditoría. useRecordGestion nunca lanza (devuelve null).
    const resumen = summarizeReminder(remindAt);
    if (phone) {
      void recordContacto(phone, 'REAGENDA', nota ? `para ${resumen} — ${nota}` : `para ${resumen}`);
    }

    return { ok: true, remindAt: iso, resumen };
  }, [user, activeStoreId, recordContacto]);
}

import { useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useStore } from '@/contexts/StoreContext';
import { bogotaToday } from '@/lib/utils';

// SEG/RESCUE/NOVEDAD son GESTIONES (cuentan como trabajo resuelto/tocado).
// LLAMADA/WHATSAPP son INTENTOS DE CONTACTO — se registran para que el trabajo
// telefónico deje de ser invisible, pero con prefijo propio para NO contar como
// gestión ni ocultar tarjetas (no matchean 'SEG:%' ni el módulo confirmar).
// REAGENDA es la venta APLAZADA: el cliente quiere el pedido pero después. Va con
// prefijo propio a propósito — no es una cancelación (no escribe order_results, no
// toca orders.estado) y tampoco es una gestión cerrada: el pedido sigue vivo y
// vuelve solo a la cola el día del recordatorio. Lo escribe useReagendarPedido.
export type GestionModule = 'SEG' | 'RESCUE' | 'NOVEDAD' | 'LLAMADA' | 'WHATSAPP' | 'REAGENDA';

/**
 * Inserta un touchpoint de gestión `MODULE: acción` (store-scoped, con el
 * operador actual y la fecha Bogotá). Es la ÚNICA forma de escribir una gestión:
 * la lista (CrmTable), el tablero kanban (SegBoard) y el detalle comparten este
 * hook para que TODO contador la reconozca igual — SegCounterBar
 * (`action LIKE 'SEG:%'`), `operator_productivity_stats` y el set
 * `mySegTouchedToday` de OrderContext (que oculta la tarjeta gestionada vía el
 * realtime sobre touchpoints).
 *
 * El bug que motivó extraerlo (2026-07-30): el kanban NO tenía dónde marcar, así
 * que una asesora que trabajaba desde el tablero no registraba nada y su
 * contador no se movía. Duplicar el formato del INSERT es exactamente lo que lo
 * causaría de nuevo — por eso vive en un solo lugar.
 *
 * Devuelve la fila insertada, o null si faltó teléfono/tienda/usuario o falló el
 * INSERT (nunca lanza: el llamador degrada sin romper la pantalla).
 */
export function useRecordGestion() {
  const { user } = useAuth();
  const { activeStoreId } = useStore();

  return useCallback(
    async (phone: string, module: GestionModule, action: string) => {
      if (!user || !activeStoreId || !phone) return null;
      const now = new Date();
      const tp = {
        phone,
        action: `${module}: ${action}`,
        operator_id: user.id,
        store_id: activeStoreId,
        action_date: bogotaToday(),
        action_time: now.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }),
      };
      const { data, error } = await supabase.from('touchpoints').insert(tp).select();
      if (error) return null;
      return data?.[0] ?? null;
    },
    [user, activeStoreId],
  );
}

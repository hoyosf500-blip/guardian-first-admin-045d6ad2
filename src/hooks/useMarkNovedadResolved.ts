import { useCallback, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useStore } from '@/contexts/StoreContext';
import { OrderData } from '@/lib/orderUtils';
import { bogotaToday } from '@/lib/utils';
import { buildNovedadAction, NovedadResultTipo } from '@/lib/novedadGestion';
import { toast } from 'sonner';

/**
 * Marca local de gestión de una novedad. NO empuja a Dropi (la colaboradora
 * resuelve en el panel de Dropi a mano; acá solo deja el registro para
 * accountability y seguimiento). Reusa `touchpoints` — no hay tabla nueva.
 *
 * Semántica por tipo:
 *  - resuelta / devolucion → la novedad SALE de la cola (`orders.novedad_sol=true`).
 *  - sin_respuesta         → solo registra el INTENTO; la novedad sigue
 *                            pendiente en la cola para reintentar.
 *
 * Se escribe el touchpoint PRIMERO (es el registro que importa); el update de
 * `orders` va después. `store_id` lo completa el trigger de touchpoints, igual
 * que el resto del CRM. No toca OrderContext: la card se descarta localmente en
 * NovedadView y se reconcilia con `loadNovedades(true)`.
 */
export function useMarkNovedadResolved() {
  const { user } = useAuth();
  const { activeStoreId } = useStore();
  const [marking, setMarking] = useState<string | null>(null);

  const markNovedad = useCallback(
    async (order: OrderData, tipo: NovedadResultTipo, nota?: string): Promise<boolean> => {
      if (!user || !order) return false;
      const key = order.dbId || order.externalId || order.phone;
      setMarking(key);
      const today = bogotaToday();
      const now = new Date().toLocaleTimeString('es-CO', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'America/Bogota',
      });
      try {
        // 1. Marca (touchpoint) — el registro de accountability. Va primero.
        const { error: tpError } = await supabase.from('touchpoints').insert({
          phone: order.phone,
          action: buildNovedadAction(tipo, nota),
          operator_id: user.id,
          action_date: today,
          action_time: now,
          store_id: activeStoreId,
        });
        if (tpError) {
          toast.error('No se pudo guardar la marca: ' + tpError.message);
          return false;
        }

        // 2. Resuelta/Devolución salen de la cola. Sin respuesta queda pendiente.
        if (tipo !== 'sin_respuesta' && order.dbId) {
          const { error: upError } = await supabase
            .from('orders')
            .update({ novedad_sol: true })
            .eq('id', order.dbId);
          if (upError) {
            // La marca ya quedó registrada (lo importante); avisamos que no salió
            // de la cola pero NO fallamos la gestión.
            toast.error('Marca guardada, pero no salió de la cola: ' + upError.message);
            return true;
          }
        }
        return true;
      } finally {
        setMarking(null);
      }
    },
    [user, activeStoreId],
  );

  return { markNovedad, marking };
}

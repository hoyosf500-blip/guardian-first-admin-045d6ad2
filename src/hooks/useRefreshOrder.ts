import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

/**
 * Refresca UN pedido desde la API Dropi en tiempo real (vs esperar al cron
 * cada 5 min que puede estar throttleado en EC). Llama a la edge function
 * `dropi-refresh-order` que hace `GET /integrations/orders/{external_id}` y
 * upsertea el row. La actualización llega al cliente vía el realtime ya
 * existente sobre la tabla `orders`.
 *
 * Uso:
 *   const { refresh, isRefreshing } = useRefreshOrder();
 *   <button onClick={() => refresh(activeStoreId, externalId)}>...</button>
 *
 * Errores son notificados con toast — el caller no necesita manejar UI extra.
 */
export function useRefreshOrder() {
  const [isRefreshing, setIsRefreshing] = useState(false);

  const refresh = useCallback(async (
    storeId: string | null | undefined,
    externalId: string | number | null | undefined,
  ): Promise<{ ok: boolean; estado?: string; guia?: string; transportadora?: string }> => {
    if (!storeId) {
      toast.error('Sin tienda activa');
      return { ok: false };
    }
    if (!externalId) {
      toast.error('Pedido sin external_id');
      return { ok: false };
    }

    setIsRefreshing(true);
    try {
      const { data, error } = await supabase.functions.invoke('dropi-refresh-order', {
        body: { store_id: storeId, external_id: String(externalId) },
      });

      if (error) {
        // supabase-js envuelve el error de la edge function. El body real
        // viene en error.context.response.body o en data si invoke devolvió.
        const msg = error.message || 'Error invocando refresh';
        toast.error(`No se pudo refrescar: ${msg}`);
        return { ok: false };
      }

      const result = data as {
        ok?: boolean;
        error?: string;
        estado?: string;
        guia?: string;
        transportadora?: string;
        rateLimited?: boolean;
      };

      if (!result?.ok) {
        if (result?.rateLimited) {
          toast.warning('Dropi está limitando peticiones — esperá ~1 min y reintentá', { duration: 6000 });
        } else if (result?.error) {
          toast.error(result.error);
        } else {
          toast.error('No se pudo refrescar el pedido');
        }
        return { ok: false };
      }

      // Mensaje útil al operador: qué cambió.
      const parts: string[] = [];
      if (result.estado) parts.push(result.estado);
      if (result.transportadora) parts.push(result.transportadora);
      if (result.guia) parts.push(`guía ${result.guia}`);
      toast.success(`Actualizado · ${parts.join(' · ') || 'sin cambios'}`);

      return {
        ok: true,
        estado: result.estado,
        guia: result.guia,
        transportadora: result.transportadora,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Error: ${msg}`);
      return { ok: false };
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  return { refresh, isRefreshing };
}

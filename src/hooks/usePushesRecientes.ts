import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Lo que Guardian subió a Dropi en las últimas 24 h, indexado por teléfono.
 *
 * ⛔ Por qué existe (caso Johana Guerra, 4-sep-2026, verificado fila por fila):
 * el ROBOT creó `#6854946` a las 8:18 — está en `shopify_pushed_orders` con
 * `status='created'`. Tres minutos después el operador, que no lo encontró
 * buscando en Dropi, cargó `#6854983` A MANO. Dos guías, dos fletes, mismo
 * cliente.
 *
 * El dato exacto estaba acá, sin lag, y la pantalla no lo mostraba: `orders` (el
 * espejo de Dropi) se actualiza recién cada 15 minutos, así que lo que el robot
 * acaba de crear NO aparece todavía en la lista de Dropi que mira el operador.
 * Ningún candado del servidor puede frenar una carga hecha en el panel de Dropi:
 * el único lugar donde se corta ese eslabón es la pantalla, ANTES del clic.
 *
 * Mismos parámetros que el candado del servidor (`_shared/gemeloInvisible.ts`:
 * ventana de 24 h, teléfono por últimos 9 dígitos) para que pantalla y servidor
 * no puedan discrepar.
 */

/** Espejo de `VENTANA_GEMELO_MS` de `_shared/gemeloInvisible.ts`. */
export const VENTANA_PUSH_MS = 24 * 60 * 60 * 1000;

export interface PushReciente {
  shopify_order_id: string;
  status: string;
  dropi_order_id: string | null;
  pushed_at: string;
  phone: string | null;
}

/** Últimos 9 dígitos: la misma llave que usa el candado del servidor. */
export function tel9(p: unknown): string {
  return String(p ?? '').replace(/\D/g, '').slice(-9);
}

const VACIO: Map<string, PushReciente[]> = new Map();

export function usePushesRecientes(storeId: string | null) {
  const query = useQuery<Map<string, PushReciente[]>>({
    queryKey: ['shopify_pushes_recientes', storeId],
    enabled: !!storeId,
    staleTime: 60 * 1000,
    refetchInterval: 2 * 60 * 1000,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      if (!storeId) return VACIO;
      const desde = new Date(Date.now() - VENTANA_PUSH_MS).toISOString();
      // Se trae `payload` entero y el teléfono se saca acá: el alias de flecha
      // JSON (`phone:payload->>phone`) hace explotar el typecheck con "type
      // instantiation is excessively deep" porque los tipos generados no la
      // conocen. No es una exposición nueva: esta misma pantalla ya muestra
      // nombre, teléfono y ciudad de cada fila pendiente.
      const { data, error } = await supabase
        .from('shopify_pushed_orders')
        .select('shopify_order_id, status, dropi_order_id, pushed_at, payload')
        .eq('store_id', storeId)
        .gte('pushed_at', desde)
        .in('status', ['created', 'pending'])
        .order('pushed_at', { ascending: false })
        .limit(500);
      // Se propaga: un aviso anti-duplicado que falla en silencio es peor que no
      // tenerlo — la asesora creería que Guardian ya miró y no subió nada.
      if (error) throw error;
      const map = new Map<string, PushReciente[]>();
      for (const fila of (data ?? [])) {
        const pay = fila.payload as { phone?: unknown } | null;
        const r: PushReciente = {
          shopify_order_id: String(fila.shopify_order_id),
          status: String(fila.status),
          dropi_order_id: fila.dropi_order_id != null ? String(fila.dropi_order_id) : null,
          pushed_at: String(fila.pushed_at),
          phone: pay && pay.phone != null ? String(pay.phone) : null,
        };
        const k = tel9(r.phone);
        if (!k) continue;
        const arr = map.get(k);
        if (arr) arr.push(r); else map.set(k, [r]);
      }
      return map;
    },
  });

  return {
    porTelefono: query.data ?? VACIO,
    /** false ⇒ no se puede afirmar que Guardian NO lo subió. */
    pudoLeer: !query.isError && !query.isLoading,
    isLoading: query.isLoading,
    refetch: query.refetch,
  };
}

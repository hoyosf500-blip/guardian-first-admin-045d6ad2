import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useActiveStoreId } from '@/contexts/StoreContext';
import { bogotaDayBounds } from '@/lib/bogotaDayBounds';

// El punto ciego que el badge de salud NO puede ver (auditoría 20-ago-2026):
// si Dropi cambia el texto de un código, mapCategoria manda el movimiento a
// 'otro' — y 'otro' está EXCLUIDO de la Ganancia Neta, del wallet_ganancia_neta
// y del cargo de devoluciones de financial_summary. El sync sigue en 'success',
// el badge queda verde, synced_count normal... y la ganancia se desvía en
// silencio. Es el mismo modo de falla del 21-jul (número mentiroso en verde),
// pero invisible para el badge porque nada "falla": lo roto es la clasificación.
//
// Este hook cuenta los movimientos 'otro' del rango para que la pantalla de
// Finanzas pueda gritar "hay N movimientos por $X que NO están entrando a la
// ganancia". El fix de fondo cuando aparezcan: agregar el patrón a mapCategoria
// (_shared/walletCategoria.ts) + migración UPDATE para re-categorizar (patrón
// 20260502000005_recategorize_wallet_movements.sql).

export interface SinClasificarResult {
  /** Movimientos con categoria='otro' en el rango (count exacto del server). */
  count: number;
  /** Suma |monto| de los primeros 1000 — si count > 1000 es parcial (piso). */
  monto: number;
  /** true si `monto` no cubre todos los movimientos. */
  montoParcial: boolean;
}

export function useWalletSinClasificar(from: string, to: string) {
  const storeId = useActiveStoreId();
  return useQuery<SinClasificarResult | null>({
    queryKey: ['wallet-sin-clasificar', storeId, from, to],
    queryFn: async () => {
      const { fromTs, toTs } = bogotaDayBounds(from, to);
      const { data, error, count } = await supabase
        .from('dropi_wallet_movements')
        .select('monto', { count: 'exact' })
        .eq('store_id', storeId as string)
        .eq('categoria', 'otro')
        .gte('fecha', fromTs)
        .lte('fecha', toTs)
        .range(0, 999);
      // El SELECT directo es admin-only por RLS: a un socio le vuelve vacío.
      // null = "no se pudo medir" — el chip simplemente no se dibuja; NUNCA
      // convertir esto en un "0 sin clasificar" afirmativo.
      if (error) return null;
      const rows = (data || []) as Array<{ monto: number | string | null }>;
      const total = count ?? rows.length;
      const monto = rows.reduce((acc, r) => acc + Math.abs(Number(r.monto) || 0), 0);
      return { count: total, monto, montoParcial: total > rows.length };
    },
    staleTime: 5 * 60_000,
    enabled: Boolean(from && to && storeId),
  });
}

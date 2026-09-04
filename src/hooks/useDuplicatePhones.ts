import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { buildDupMap, type ExistingOrder } from '@/lib/duplicatePhones';

// `find_duplicate_phones` aún no está en los tipos generados de RPC.
const sb = supabase as unknown as SupabaseClient;
const EMPTY: Map<string, ExistingOrder[]> = new Map();

/**
 * Para una lista de teléfonos normalizados, consulta qué pedidos de Dropi NO
 * cancelados ya existen con ese teléfono en la tienda activa (RPC store-scoped).
 * Devuelve un mapa teléfono→pedidos existentes. Degrada a vacío si la RPC no
 * está desplegada (no rompe el panel; simplemente no bloquea nada).
 */
export function useDuplicatePhones(storeId: string | null, phones: string[]) {
  const key = useMemo(() => [...phones].sort(), [phones]);

  const query = useQuery<Map<string, ExistingOrder[]>>({
    queryKey: ['duplicate_phones', storeId, key.join(',')],
    enabled: !!storeId && key.length > 0,
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      if (!storeId || key.length === 0) return EMPTY;
      const { data, error } = await sb.rpc('find_duplicate_phones', { p_store_id: storeId, p_phones: key });
      if (error) {
        const code = (error as { code?: string }).code;
        if (code === 'PGRST202' || /does not exist|find_duplicate_phones/i.test(error.message || '')) {
          return EMPTY;  // migración no aplicada todavía → no bloquear
        }
        throw error;
      }
      return buildDupMap((data ?? []) as ExistingOrder[]);
    },
  });

  return {
    dupMap: query.data ?? EMPTY,
    isLoading: query.isLoading,
    /** ⛔ La RPC FALLÓ (red/RLS/500). Un `dupMap` vacío por fallo se ve IGUAL que
     *  "ningún teléfono repetido": el panel pintaba «listo para subir» y «Subir
     *  todos» no excluía nada (4-sep-2026). Quien consuma esto tiene que
     *  distinguir "no hay duplicados" de "no se pudo revisar". Migración no
     *  aplicada NO es error (arriba devuelve EMPTY a propósito). */
    isError: query.isError,
    refetch: query.refetch,
  };
}

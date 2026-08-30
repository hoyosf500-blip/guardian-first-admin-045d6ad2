import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useActiveStoreId } from '@/contexts/StoreContext';
import {
  medirCobertura,
  patronesIlikeSector,
  type CoberturaMedida,
  type FilaEnvio,
  type SectorSinCobertura,
} from '@/lib/dropiEcuador/logisticaOficial';

// «¿Y nosotros qué hicimos ahí?» — los envíos TERMINADOS de la tienda ACTIVA al
// sector que Dropi lista sin cobertura. Es por tienda a propósito: la lista de
// Dropi es vieja y genérica, y con los pedidos de una tienda se demostró que
// entrega igual en la mayoría de esos sectores. Un dato estático de otra
// operación sería exactamente la suposición que el dueño prohibió.
//
// Costo: UNA consulta por (tienda, sector) — solo cuando la dirección abierta
// matchea un sector (raro), acotada por ciudad + patrón ILIKE, cacheada 30 min.
// Nunca inventa un cero: sin filas es `sin_dato`, y un error se propaga para que
// el chip diga «no se pudo medir».

export function useCoberturaMedida(z: SectorSinCobertura | null) {
  const storeId = useActiveStoreId();
  const patrones = z ? patronesIlikeSector(z.sector) : [];
  return useQuery<CoberturaMedida>({
    queryKey: ['cobertura-medida', storeId, z?.ciudad ?? '', z?.sector ?? ''],
    enabled: !!storeId && !!z && patrones.length > 0,
    staleTime: 30 * 60 * 1000,
    queryFn: async () => {
      let q = supabase
        .from('orders')
        .select('estado, transportadora, direccion')
        .eq('store_id', storeId as string)
        .ilike('ciudad', `%${(z as SectorSinCobertura).ciudad}%`)
        // `*` es el comodín de PostgREST dentro de .or(); `%` va en .ilike().
        .or('estado.eq.ENTREGADO,estado.ilike.DEVOLUCION*');
      for (const p of patrones) q = q.ilike('direccion', p);
      const { data, error } = await q.order('fecha', { ascending: false }).limit(1000);
      if (error) throw error;
      return medirCobertura(
        (data ?? []) as FilaEnvio[],
        (z as SectorSinCobertura).ciudad,
        (z as SectorSinCobertura).sector,
      );
    },
  });
}

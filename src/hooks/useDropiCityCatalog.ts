import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { groupDropiCatalog, type GeoCatalog } from '@/lib/geoCatalog';

/**
 * Catálogo de provincias/ciudades de Dropi (`dropi_city_catalog`) para armar los
 * desplegables del editor de orden en Ecuador — así el operador elige de la
 * lista real de Dropi en vez de escribir y equivocarse.
 *
 * La tabla es de solo-lectura para cualquier autenticado (RLS `USING (true)`,
 * migración 20260701210000). Casi no cambia → `staleTime` de 1h.
 *
 * Si la query falla o el catálogo viene vacío, el formulario cae solo a su
 * comportamiento viejo (texto libre): nunca deja al operador sin poder editar.
 */
const EMPTY: GeoCatalog = { provinces: [], citiesByProvince: {} };

export function useDropiCityCatalog(countryCode: string | null | undefined) {
  const cc = (countryCode || 'CO').toUpperCase();
  const q = useQuery<GeoCatalog>({
    queryKey: ['dropi-city-catalog', cc],
    staleTime: 60 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('dropi_city_catalog')
        .select('dept_norm, name')
        .eq('country_code', cc);
      if (error) throw error;
      return groupDropiCatalog(data || []);
    },
  });
  // El consumidor no debería tener que chequear undefined: ante loading/error
  // devolvemos el catálogo vacío y él decide el fallback.
  return { catalog: q.data ?? EMPTY, isLoading: q.isLoading, isError: q.isError };
}

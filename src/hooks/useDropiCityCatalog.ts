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
      // Se pagina con orden estable: PostgREST corta en 1000 filas sin avisar y
      // el catálogo de Dropi las pasa. Sin esto faltaban ciudades AL AZAR (las
      // que quedaban fuera del corte) y el operador no podía elegir el destino
      // del pedido — sin ningún mensaje que explicara por qué.
      const PAGE = 1000;
      const rows: { dept_norm: string; name: string }[] = [];
      for (let offset = 0; ; offset += PAGE) {
        const { data, error } = await supabase
          .from('dropi_city_catalog')
          .select('dept_norm, name')
          .eq('country_code', cc)
          .order('dept_norm', { ascending: true })
          .order('name', { ascending: true })
          .range(offset, offset + PAGE - 1);
        if (error) throw error;
        rows.push(...((data || []) as typeof rows));
        if (!data || data.length < PAGE) break;
      }
      return groupDropiCatalog(rows);
    },
  });
  // El consumidor no debería tener que chequear undefined: ante loading/error
  // devolvemos el catálogo vacío y él decide el fallback.
  return { catalog: q.data ?? EMPTY, isLoading: q.isLoading, isError: q.isError };
}

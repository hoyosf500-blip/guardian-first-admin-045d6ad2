import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type AddressValidationStatus = 'valid' | 'suspicious' | 'invalid';

export interface AddressValidationResult {
  status: AddressValidationStatus;
  score: number;
  issues: string[];
  geocoded?: { lat: number; lng: number; display: string };
  cached: boolean;
}

interface Args {
  direccion: string;
  ciudad?: string;
  departamento?: string;
  /** Si false, no dispara la query (útil cuando no hay dirección o el usuario no la ha pedido). */
  enabled?: boolean;
}

/**
 * Valida que una dirección esté bien escrita y exista en el mundo real.
 * Combina heurística regex (formato Colombia) + geocoding Nominatim (OSM).
 *
 * El backend cachea 24h por (direccion+ciudad+depto) normalizado, así que
 * llamadas repetidas con la misma dirección no queman API quota. En el
 * cliente cacheamos 1h adicional vía staleTime.
 */
export function useAddressValidation(
  args: Args,
): UseQueryResult<AddressValidationResult> {
  const { direccion, ciudad = '', departamento = '', enabled = true } = args;
  const dirTrim = direccion?.trim() || '';

  return useQuery<AddressValidationResult>({
    queryKey: ['address-validation', dirTrim, ciudad.trim(), departamento.trim()],
    enabled: enabled && dirTrim.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke<AddressValidationResult>(
        'dropi-validate-address',
        { body: { direccion: dirTrim, ciudad, departamento } },
      );
      if (error) throw new Error(error.message);
      if (!data) throw new Error('Sin respuesta del validador');
      return data;
    },
    staleTime: 60 * 60 * 1000,        // 1h en cliente
    gcTime: 24 * 60 * 60 * 1000,      // 24h en memoria
    retry: 1,                          // Nominatim a veces falla — un retry
  });
}

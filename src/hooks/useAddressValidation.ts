import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { heuristicValidate, decideStatusLocalOnly } from '@/lib/addressHeuristic';

export type AddressValidationStatus = 'valid' | 'suspicious' | 'invalid';

export interface AddressValidationResult {
  status: AddressValidationStatus;
  score: number;
  issues: string[];
  geocoded?: { lat: number; lng: number; display: string };
  cached: boolean;
  /** True si fue validada solo con heurística local (edge function no disponible). */
  localOnly?: boolean;
}

interface Args {
  direccion: string;
  ciudad?: string;
  departamento?: string;
  enabled?: boolean;
}

/**
 * Valida que una dirección esté bien escrita y exista en el mundo real.
 *
 * Estrategia con fallback:
 *   1. Intenta llamar la edge function `dropi-validate-address`
 *      (heurística + geocoding Nominatim + cache 24h).
 *   2. Si la edge function falla (no desplegada / CORS / 500), cae a
 *      heurística regex local en el cliente. Sin geocoding, así que el
 *      mejor estado posible es 'suspicious' (formato OK, existencia
 *      no verificada).
 *
 * Esto garantiza que el badge SIEMPRE muestra algo útil, incluso si el
 * backend no está listo.
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
      // Intento 1: edge function (geocoding + cache).
      try {
        const { data, error } = await supabase.functions.invoke<AddressValidationResult>(
          'dropi-validate-address',
          { body: { direccion: dirTrim, ciudad, departamento } },
        );
        if (!error && data && data.status) {
          return { ...data, localOnly: false };
        }
      } catch {
        // Falla silenciosa → fallback local
      }

      // Intento 2 (fallback): heurística pura en cliente.
      const { score, issues } = heuristicValidate(dirTrim);
      return {
        status: decideStatusLocalOnly(score),
        score,
        issues,
        cached: false,
        localOnly: true,
      };
    },
    staleTime: 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    retry: false, // sin retry — el fallback ya cubre el error
  });
}

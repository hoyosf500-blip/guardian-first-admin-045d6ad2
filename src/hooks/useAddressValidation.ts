import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { heuristicValidate, decideStatusLocalOnly } from '@/lib/addressHeuristic';
import { GOOGLE_PLACES_ENABLED } from '@/lib/featureFlags';

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
  countryCode?: string;
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
  const { direccion, ciudad = '', departamento = '', countryCode, enabled = true } = args;
  const dirTrim = direccion?.trim() || '';

  return useQuery<AddressValidationResult>({
    queryKey: ['address-validation', dirTrim, ciudad.trim(), departamento.trim(), countryCode || 'CO'],
    enabled: enabled && dirTrim.length > 0,
    queryFn: async () => {
      // GOOGLE APAGADO — este hook NO lo respetaba (auditoría 4-ago-2026).
      //
      // El dueño apagó Google el 22-may y el CLAUDE.md lo afirma en cuatro
      // lugares distintos: "el semáforo corre 100% en la heurística local", "la
      // función sigue existiendo pero está dormida". No estaba dormida.
      // `CallView`/`CrmCallView` sí cortocircuitaban con el flag, pero el
      // `AddressValidationBadge` que va DENTRO de esas mismas pantallas usa este
      // hook, y este hook llamaba a `dropi-validate-address` sin mirar nada.
      //
      // Esa función pega contra Google Maps y contra Anthropic (Haiku) y va
      // descontando de la cuota con `consume_google_quota`. O sea: cada
      // dirección que la asesora abría gastaba plata que el dueño creía cortada
      // hace más de dos meses.
      //
      // Con el flag apagado se va derecho a la heurística local, que es
      // exactamente lo que el doc dice que pasa.
      if (!GOOGLE_PLACES_ENABLED) {
        const { score, issues } = heuristicValidate(dirTrim, countryCode);
        return { status: decideStatusLocalOnly(score), score, issues, cached: false, localOnly: true };
      }
      // Intento 1: edge function (geocoding + cache). `country` para que valide
      // con reglas del país correcto (EC vs CO) — la edge function lo usará
      // cuando se actualice; mientras, lo ignora sin romper.
      try {
        const { data, error } = await supabase.functions.invoke<AddressValidationResult>(
          'dropi-validate-address',
          { body: { direccion: dirTrim, ciudad, departamento, country: countryCode } },
        );
        if (!error && data && data.status) {
          return { ...data, localOnly: false };
        }
      } catch {
        // Falla silenciosa → fallback local
      }

      // Intento 2 (fallback): heurística pura en cliente, country-aware.
      const { score, issues } = heuristicValidate(dirTrim, countryCode);
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

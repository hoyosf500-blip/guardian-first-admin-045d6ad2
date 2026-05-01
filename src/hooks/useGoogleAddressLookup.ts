// Hook que busca una dirección en Google Places y devuelve la primera
// predicción que coincida con la ciudad/departamento del pedido.
//
// CRÍTICO: Google a veces sesga las predicciones hacia ciudades populares
// (ej. devuelve "Soacha, Cundinamarca" cuando el pedido es Pitalito, Huila).
// Eso es alucinación que puede causar despachos a la ciudad equivocada. Por
// eso filtramos: si ninguna predicción contiene la ciudad O el departamento
// del pedido, devolvemos null y caemos al fallback heurístico (que SÍ usa
// los datos del pedido sin inventar).
//
// La edge function google-places-proxy ya hace gating de cuota server-side
// vía consume_google_quota — no necesitamos doble check aquí.

import { useEffect, useRef, useState } from 'react';
import { useGooglePlaces } from './useGooglePlaces';

interface LookupResult {
  /** Dirección como Google la devuelve (ej. "Calle 15 #4-30, Pitalito, Huila, Colombia") */
  description: string;
  place_id: string;
}

interface Args {
  /** Dirección actual del pedido (lo que escribió el cliente) */
  direccion: string;
  /** Ciudad del pedido — usada para sesgar Y para filtrar resultados */
  ciudad?: string | null;
  /** Departamento del pedido — usado para validar que el resultado coincida */
  departamento?: string | null;
  /** Solo dispara si decision es 'yellow' o 'red' (no green/pickup/null) */
  enabled: boolean;
  /** Key estable para cachear por pedido (ej. orderId). Si cambia, se re-busca. */
  cacheKey: string;
}

const sessionCache = new Map<string, LookupResult | null>();

/** Normaliza string para comparación case+accent-insensitive. */
function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Verifica que la prediction de Google contenga la ciudad O el departamento
 * del pedido. Si NO contiene ninguno, es probable alucinación de Google y
 * debemos descartarla.
 */
export function predictionMatchesLocation(
  description: string,
  ciudad?: string | null,
  departamento?: string | null,
): boolean {
  if (!ciudad && !departamento) return true; // sin info, no podemos validar — aceptar
  const desc = normalize(description);
  if (ciudad) {
    const c = normalize(ciudad);
    if (c.length >= 3 && desc.includes(c)) return true;
  }
  if (departamento) {
    const d = normalize(departamento);
    if (d.length >= 3 && desc.includes(d)) return true;
  }
  return false;
}

export function useGoogleAddressLookup({ direccion, ciudad, departamento, enabled, cacheKey }: Args): {
  result: LookupResult | null;
  loading: boolean;
} {
  const google = useGooglePlaces();
  const [result, setResult] = useState<LookupResult | null>(() => sessionCache.get(cacheKey) ?? null);
  const [loading, setLoading] = useState(false);
  const inflightRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (!direccion || direccion.trim().length < 5) return;
    if (sessionCache.has(cacheKey)) {
      setResult(sessionCache.get(cacheKey) ?? null);
      return;
    }
    if (inflightRef.current === cacheKey) return; // evitar re-disparo durante in-flight
    inflightRef.current = cacheKey;

    let cancelled = false;
    setLoading(true);
    void google
      .autocomplete(direccion, ciudad ?? undefined)
      .then((predictions) => {
        if (cancelled) return;
        // Buscar la PRIMERA predicción que pase el guard de ciudad/depto.
        // Si ninguna pasa, devolver null y dejar que el fallback heurístico
        // (que sí usa ciudad+depto del pedido sin inventar) tome el control.
        const safe = predictions.find((p) =>
          predictionMatchesLocation(p.description, ciudad, departamento),
        );
        const lookup: LookupResult | null = safe
          ? { description: safe.description, place_id: safe.place_id }
          : null;
        sessionCache.set(cacheKey, lookup);
        setResult(lookup);
      })
      .catch(() => {
        if (cancelled) return;
        sessionCache.set(cacheKey, null);
        setResult(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
        if (inflightRef.current === cacheKey) inflightRef.current = null;
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, direccion, ciudad, departamento, cacheKey, google]);

  return { result, loading };
}

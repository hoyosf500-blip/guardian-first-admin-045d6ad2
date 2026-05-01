// Hook que busca una dirección en Google Places y devuelve la primera
// predicción como sugerencia REAL (no heurística).
//
// Diseñado para ser barato: cache por orderId+dirección (solo memoria),
// llamada disparada por el componente cuando el pedido está yellow/red.
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
  /** Ciudad para sesgar la búsqueda */
  ciudad?: string | null;
  /** Solo dispara si decision es 'yellow' o 'red' (no green/pickup/null) */
  enabled: boolean;
  /** Key estable para cachear por pedido (ej. orderId). Si cambia, se re-busca. */
  cacheKey: string;
}

const sessionCache = new Map<string, LookupResult | null>();

export function useGoogleAddressLookup({ direccion, ciudad, enabled, cacheKey }: Args): {
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
        const first = predictions[0];
        const lookup: LookupResult | null = first
          ? { description: first.description, place_id: first.place_id }
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
  }, [enabled, direccion, ciudad, cacheKey, google]);

  return { result, loading };
}

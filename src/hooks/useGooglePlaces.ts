// src/hooks/useGooglePlaces.ts
//
// Cliente de Google Places que llama a la edge function `google-places-proxy`
// en vez de cargar el script de Google Maps en el browser.
//
// Ventajas:
//   - GOOGLE_MAPS_API_KEY nunca se expone al cliente (solo runtime en edge).
//   - No requiere build secret VITE_GOOGLE_MAPS_API_KEY.
//   - Quota gating server-side via consume_google_quota.

import { useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { GOOGLE_PLACES_ENABLED } from '@/lib/featureFlags';

interface AutocompletePrediction {
  description: string;
  place_id: string;
  structured_formatting?: { main_text: string; secondary_text: string };
}

interface PlaceDetailsResult {
  place_id: string;
  formatted_address: string;
  geometry?: { location?: { lat: () => number; lng: () => number } };
  address_components?: Array<{ long_name: string; short_name: string; types: string[] }>;
}

interface GoogleApi {
  autocomplete: (query: string, ciudadBias?: string) => Promise<AutocompletePrediction[]>;
  getDetails: (place_id: string) => Promise<PlaceDetailsResult | null>;
  available: boolean;
}

// Cache en memoria para evitar requests repetidas durante una sesión.
const memoryCache = new Map<string, AutocompletePrediction[]>();

function memoryKey(query: string, ciudad?: string): string {
  return `${query.trim().toLowerCase()}|${(ciudad || '').toLowerCase()}`;
}

function newSessionToken(): string {
  // UUID v4 simple — sólo para agrupar autocomplete+details en la misma sesión de billing.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function useGooglePlaces(): GoogleApi {
  const sessionTokenRef = useRef<string | null>(null);

  // Google DESACTIVADO (ver featureFlags): API inerte — autocomplete vacío,
  // details null, available=false. AddressAutocomplete ya gatea sobre
  // `available`, así que el campo de dirección queda como texto libre.
  if (!GOOGLE_PLACES_ENABLED) {
    return { available: false, autocomplete: async () => [], getDetails: async () => null };
  }

  return {
    // Siempre disponible: el gating real es server-side (cap diario + auth).
    available: true,

    autocomplete: async (query: string, ciudadBias?: string) => {
      const q = query.trim();
      if (q.length < 3) return [];
      const key = memoryKey(q, ciudadBias);
      const cached = memoryCache.get(key);
      if (cached) return cached;

      if (!sessionTokenRef.current) {
        sessionTokenRef.current = newSessionToken();
      }

      try {
        const { data, error } = await supabase.functions.invoke<{ predictions: AutocompletePrediction[] }>(
          'google-places-proxy',
          {
            body: {
              op: 'autocomplete',
              input: q,
              ciudad: ciudadBias,
              sessionToken: sessionTokenRef.current,
            },
          },
        );
        if (error || !data) return [];
        const result = Array.isArray(data.predictions) ? data.predictions : [];
        memoryCache.set(key, result);
        return result;
      } catch {
        return [];
      }
    },

    getDetails: async (place_id: string) => {
      try {
        const { data, error } = await supabase.functions.invoke<{ result: {
          place_id: string;
          formatted_address: string;
          geometry?: { location?: { lat: number; lng: number } };
          address_components?: Array<{ long_name: string; short_name: string; types: string[] }>;
        } | null }>(
          'google-places-proxy',
          {
            body: {
              op: 'details',
              place_id,
              sessionToken: sessionTokenRef.current,
            },
          },
        );
        // Cerramos la sesión después del details (cobro consolidado).
        sessionTokenRef.current = null;
        if (error || !data?.result) return null;
        const r = data.result;
        // Adaptamos location {lat, lng} → {lat: ()=>n, lng: ()=>n} para mantener
        // compatibilidad con parseGooglePlace (que espera el shape clásico de google.maps).
        const loc = r.geometry?.location;
        return {
          place_id: r.place_id,
          formatted_address: r.formatted_address,
          geometry: loc
            ? { location: { lat: () => loc.lat, lng: () => loc.lng } }
            : undefined,
          address_components: r.address_components,
        };
      } catch {
        sessionTokenRef.current = null;
        return null;
      }
    },
  };
}

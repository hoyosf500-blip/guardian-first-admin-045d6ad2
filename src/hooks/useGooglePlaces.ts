// src/hooks/useGooglePlaces.ts
import { useEffect, useRef, useState } from 'react';

const GOOGLE_MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined;

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

let scriptLoadPromise: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (scriptLoadPromise) return scriptLoadPromise;
  if (!GOOGLE_MAPS_KEY) {
    scriptLoadPromise = Promise.reject(new Error('VITE_GOOGLE_MAPS_API_KEY missing'));
    return scriptLoadPromise;
  }
  if (typeof window !== 'undefined' && (window as unknown as { google?: unknown }).google) {
    scriptLoadPromise = Promise.resolve();
    return scriptLoadPromise;
  }
  scriptLoadPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_KEY}&libraries=places&v=weekly`;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Google Maps script'));
    document.head.appendChild(script);
  });
  return scriptLoadPromise;
}

const memoryCache = new Map<string, AutocompletePrediction[]>();

function memoryKey(query: string, ciudad?: string): string {
  return `${query.trim().toLowerCase()}|${(ciudad || '').toLowerCase()}`;
}

export function useGooglePlaces(): GoogleApi {
  const [available, setAvailable] = useState(false);
  const sessionTokenRef = useRef<unknown>(null);

  useEffect(() => {
    loadScript().then(() => setAvailable(true)).catch(() => setAvailable(false));
  }, []);

  return {
    available,

    autocomplete: async (query: string, ciudadBias?: string) => {
      if (!available || !query.trim()) return [];
      const key = memoryKey(query, ciudadBias);
      const cached = memoryCache.get(key);
      if (cached) return cached;

      const google = (window as unknown as { google: { maps: { places: { AutocompleteService: new () => unknown; AutocompleteSessionToken: new () => unknown } } } }).google;
      if (!google) return [];

      if (!sessionTokenRef.current) {
        sessionTokenRef.current = new google.maps.places.AutocompleteSessionToken();
      }

      const service = new google.maps.places.AutocompleteService() as unknown as {
        getPlacePredictions: (
          req: Record<string, unknown>,
          cb: (preds: AutocompletePrediction[] | null, status: string) => void,
        ) => void;
      };

      return new Promise<AutocompletePrediction[]>((resolve) => {
        service.getPlacePredictions(
          {
            input: query,
            componentRestrictions: { country: 'co' },
            sessionToken: sessionTokenRef.current,
          },
          (predictions, status) => {
            const result = (status === 'OK' && Array.isArray(predictions)) ? predictions! : [];
            memoryCache.set(key, result);
            resolve(result);
          },
        );
      });
    },

    getDetails: async (place_id: string) => {
      if (!available) return null;
      const google = (window as unknown as { google: { maps: { places: { PlacesService: new (attr: HTMLDivElement) => unknown } } } }).google;
      if (!google) return null;

      const div = document.createElement('div');
      const service = new google.maps.places.PlacesService(div) as unknown as {
        getDetails: (
          req: Record<string, unknown>,
          cb: (place: PlaceDetailsResult | null, status: string) => void,
        ) => void;
      };

      return new Promise<PlaceDetailsResult | null>((resolve) => {
        service.getDetails(
          {
            placeId: place_id,
            fields: ['place_id', 'formatted_address', 'geometry', 'address_components'],
            sessionToken: sessionTokenRef.current,
          },
          (place, status) => {
            sessionTokenRef.current = null;
            resolve(status === 'OK' ? place : null);
          },
        );
      });
    },
  };
}

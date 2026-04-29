// src/lib/parseGooglePlace.ts
interface AddressComponent { long_name: string; short_name: string; types: string[]; }
interface GeometryLocation { lat: number | (() => number); lng: number | (() => number); }
interface PlaceLike {
  place_id?: string;
  formatted_address?: string;
  geometry?: { location?: GeometryLocation };
  address_components?: AddressComponent[];
}

export interface ParsedPlace {
  place_id: string | null;
  direccion: string;
  barrio: string | null;
  lat: number | null;
  lng: number | null;
  address_kind: 'urban' | 'rural' | 'unknown';
  components: AddressComponent[];
}

function readLatLng(geom?: { location?: GeometryLocation }): { lat: number | null; lng: number | null } {
  if (!geom?.location) return { lat: null, lng: null };
  const lat = typeof geom.location.lat === 'function' ? geom.location.lat() : geom.location.lat;
  const lng = typeof geom.location.lng === 'function' ? geom.location.lng() : geom.location.lng;
  return {
    lat: typeof lat === 'number' ? lat : null,
    lng: typeof lng === 'number' ? lng : null,
  };
}

function findComponent(components: AddressComponent[], type: string): string | null {
  const m = components.find((c) => c.types.includes(type));
  return m ? m.long_name : null;
}

export function parseGooglePlace(place: PlaceLike): ParsedPlace {
  const components = place.address_components ?? [];
  const hasRoute = components.some((c) => c.types.includes('route'));
  const hasLocality = components.some((c) => c.types.includes('locality'));
  const { lat, lng } = readLatLng(place.geometry);

  return {
    place_id: place.place_id ?? null,
    direccion: place.formatted_address ?? '',
    barrio: findComponent(components, 'sublocality') ?? findComponent(components, 'sublocality_level_1'),
    lat,
    lng,
    address_kind: hasRoute && hasLocality ? 'urban' : 'unknown',
    components,
  };
}

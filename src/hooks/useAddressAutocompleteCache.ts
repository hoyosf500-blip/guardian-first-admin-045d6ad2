// src/hooks/useAddressAutocompleteCache.ts
import { supabase } from '@/integrations/supabase/client';
import { addressNormalize } from '@/lib/addressNormalize';
import { locationMatches } from '@/lib/locationGuard';

interface Suggestion {
  description: string;
  place_id: string;
  structured_formatting?: { main_text: string; secondary_text: string };
}

const TTL_DAYS = 30;

export interface RecurrentCustomerHit {
  direccion: string;
  google_place_id: string;
  lat: number | null;
  lng: number | null;
  upload_date: string;
}

export async function lookupAutocompleteCache(
  query: string,
  ciudad: string | undefined,
): Promise<Suggestion[] | null> {
  const norm = addressNormalize(query);
  if (!norm || norm.length < 3) return null;

  const { data } = await supabase
    .from('address_autocomplete_cache')
    .select('suggestions, expires_at')
    .eq('query_normalized', norm)
    .eq('ciudad_filter', ciudad ?? '')
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();

  return data ? (data.suggestions as unknown as Suggestion[]) : null;
}

export async function storeAutocompleteCache(
  query: string,
  ciudad: string | undefined,
  suggestions: Suggestion[],
): Promise<void> {
  const norm = addressNormalize(query);
  if (!norm || norm.length < 3 || suggestions.length === 0) return;

  const expires_at = new Date(Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  await supabase
    .from('address_autocomplete_cache')
    .upsert(
      { query_normalized: norm, ciudad_filter: ciudad ?? '', suggestions: suggestions as never, hit_count: 0, expires_at },
      { onConflict: 'query_normalized,ciudad_filter' },
    );
}

/**
 * Última dirección geocodificada de un cliente recurrente, para ofrecer "misma
 * dirección del pedido anterior".
 *
 * Dos candados, porque un click en ese banner cambia la dirección de despacho:
 *  - `storeId` obligatorio: sin él, RLS devuelve los pedidos de TODAS las
 *    tiendas del usuario y un pedido de EC podía recibir la dirección de CO.
 *  - la ubicación del pedido viejo debe coincidir con la del actual
 *    (`locationMatches`): un recomprador que se mudó de Neiva a Pitalito
 *    recibiría el paquete a 200 km — devolución casi segura.
 */
export async function lookupRecurrentCustomer(
  phone: string,
  storeId: string | null | undefined,
  ciudad?: string | null,
  departamento?: string | null,
): Promise<RecurrentCustomerHit | null> {
  if (!phone || phone.length < 10) return null;
  if (!storeId) return null;

  const { data } = await supabase
    .from('orders')
    .select('direccion, google_place_id, lat, lng, upload_date, ciudad, departamento')
    .eq('store_id', storeId)
    .eq('phone', phone)
    .not('google_place_id', 'is', null)
    .order('upload_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data || !data.google_place_id) return null;

  // Se compara contra la ciudad/depto DEL PEDIDO VIEJO; si ese pedido no los
  // trae, se cae al texto de la dirección (que casi siempre los nombra).
  const hitLocation = [data.ciudad, data.departamento].filter(Boolean).join(', ')
    || data.direccion || '';
  if (!locationMatches(hitLocation, ciudad, departamento)) return null;

  return data as RecurrentCustomerHit;
}

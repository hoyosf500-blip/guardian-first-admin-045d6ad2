// src/hooks/useAddressAutocompleteCache.ts
import { supabase } from '@/integrations/supabase/client';
import { addressNormalize } from '@/lib/addressNormalize';

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

export async function lookupRecurrentCustomer(phone: string): Promise<RecurrentCustomerHit | null> {
  if (!phone || phone.length < 10) return null;

  const { data } = await supabase
    .from('orders')
    .select('direccion, google_place_id, lat, lng, upload_date')
    .eq('phone', phone)
    .not('google_place_id', 'is', null)
    .order('upload_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data || !data.google_place_id) return null;
  return data as RecurrentCustomerHit;
}

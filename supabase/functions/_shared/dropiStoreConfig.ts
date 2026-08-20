// Helpers store-aware para edge functions Dropi.
//
// Centraliza la lógica de:
//   1. Resolver la config Dropi de una tienda (store_dropi_config) por
//      store_id explícito o derivado de un pedido.
//   2. Validar que el caller (user_id) sea miembro de esa tienda.
//
// Reemplaza la lectura de app_settings.dropi_token/dropi_session_token,
// que era single-tenant.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { dropiHostFor } from "./dropiHosts.ts";

export interface StoreDropiConfig {
  storeId: string;
  countryCode: string;
  apiKey: string;
  storeUrl: string;
  sessionToken: string;
  /** Host base de la API Dropi del país, sin trailing slash. */
  base: string;
}

/** Lee y valida store_dropi_config para una tienda dada.
 *  Tira error con mensaje claro si falta credencial. */
export async function loadStoreConfig(
  sbAdmin: SupabaseClient,
  storeId: string,
): Promise<StoreDropiConfig> {
  const { data, error } = await sbAdmin
    .from("store_dropi_config")
    .select("store_id, country_code, dropi_api_key, dropi_store_url, dropi_session_token")
    .eq("store_id", storeId)
    .maybeSingle();

  if (error) throw new Error(`No se pudo leer store_dropi_config: ${error.message}`);
  if (!data) {
    throw new Error(
      `La tienda no tiene configuración Dropi. Configurala en Ajustes → Tienda → Integración Dropi.`,
    );
  }
  const apiKey = String(data.dropi_api_key || "");
  const sessionToken = String(data.dropi_session_token || "");
  const countryCode = String(data.country_code || "CO");

  return {
    storeId: String(data.store_id),
    countryCode,
    apiKey,
    sessionToken,
    storeUrl: String(data.dropi_store_url || ""),
    base: dropiHostFor(countryCode),
  };
}

/** Resuelve store_id a partir de un externalId (lookup en orders).
 *  Devuelve null si no se encuentra.
 *
 *  ⚠️ ESTE CONTRATO DEPENDE DE QUE `orders.external_id` SEA UNIQUE GLOBAL
 *  (constraint `orders_external_id_key`, verificado en la base el 20-ago-2026).
 *  Es lo único que hace que "el external_id identifica UNA tienda" sea cierto.
 *
 *  El dia que ese unique pase a `(store_id, external_id)` —que es lo correcto,
 *  porque hoy un pedido de una tienda puede SOBRESCRIBIR el de otra via el
 *  `ON CONFLICT (external_id)` del upsert— esta funcion queda AMBIGUA y hay que
 *  matarla: cada caller tiene que recibir el store_id explicito. Los rangos ya
 *  se solapan: GT, las dos tiendas de EC y parte de CO usan ids de 7 digitos.
 *  Ver la nota de external_id en CLAUDE.md antes de tocar el constraint. */
export async function storeIdFromExternalId(
  sbAdmin: SupabaseClient,
  externalId: string,
): Promise<string | null> {
  const { data } = await sbAdmin
    .from("orders")
    .select("store_id")
    .eq("external_id", externalId)
    .maybeSingle();
  return data?.store_id ?? null;
}

/** Verifica que un user_id sea miembro (owner u operator) de una tienda.
 *  Usar sbAdmin (service role) — no depende de RLS. */
export async function isStoreMember(
  sbAdmin: SupabaseClient,
  userId: string,
  storeId: string,
): Promise<boolean> {
  const { data } = await sbAdmin
    .from("store_members")
    .select("role")
    .eq("user_id", userId)
    .eq("store_id", storeId)
    .maybeSingle();
  return Boolean(data);
}

/** Verifica owner. Útil para flujos que sólo deben correr para el dueño. */
export async function isStoreOwner(
  sbAdmin: SupabaseClient,
  userId: string,
  storeId: string,
): Promise<boolean> {
  const { data } = await sbAdmin
    .from("store_members")
    .select("role")
    .eq("user_id", userId)
    .eq("store_id", storeId)
    .eq("role", "owner")
    .maybeSingle();
  return Boolean(data);
}

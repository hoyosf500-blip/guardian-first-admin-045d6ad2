// shopify-auto-push — el "robot" que sube SOLO los pedidos limpios de Shopify a
// Dropi, sin que nadie apriete el botón del panel anti-fuga.
//
// Corre por cron cada 15 min (migration 20260718140000). Por cada tienda con
// Shopify configurado Y auto_push_enabled:
//   1. Trae los pedidos recientes de Shopify (sin cancelados/prueba, con teléfono).
//   2. Los cruza por teléfono contra `orders` (lo que YA está en Dropi).
//   3. Selecciona los pendientes LIMPIOS (ver _shared/autoPushSelect.ts):
//      con teléfono, pasada la gracia de 30 min (deja que Dropify los suba solo
//      primero + cierra la carrera con el sync), no más viejos de 3 días, no ya
//      en Dropi, no ya intentados.
//   4. Sube cada uno llamando a shopify-push-dropi (mode:"confirm"), que aplica
//      los candados: anti-duplicado por teléfono, anti-sobreprecio, idempotencia.
//      Lo que el push bloquea (duplicado, precio raro, sin vínculo, sin
//      cobertura) queda para el panel manual — el robot NUNCA fuerza nada.
//
// Auth: x-cron-secret (app_settings.cron_shared_secret), igual que dropi-cron.
// Un admin también puede dispararlo a mano (Authorization Bearer). Acepta
// { store_id?, dry_run? }: sin store_id recorre todas las habilitadas; dry_run
// devuelve QUÉ subiría sin subir nada (para verificar antes de soltarlo).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { loadShopifyConfig, getShopifyAccessToken } from "../_shared/shopifyStoreConfig.ts";
import {
  selectAutoPushCandidates,
  type ShopifyPendingLike,
  type PushedRecord,
} from "../_shared/autoPushSelect.ts";

const SHOPIFY_API_VERSION = "2024-10";
const MIN_AGE_MS = 30 * 60 * 1000;     // gracia: dejar que Dropify lo suba solo primero
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // techo: no perseguir pedidos viejos
const ERROR_COOLDOWN_MS = 2 * 60 * 60 * 1000; // reintento de 'error' no antes de 2 h
const PER_STORE_CAP = 20;              // tope por corrida por tienda
const PUSH_DELAY_MS = 1200;            // pausa entre pushes (gentil con Dropi)
const SHOPIFY_LOOKBACK_DAYS = 3;       // ventana de pedidos Shopify a revisar
const DROPI_LOOKBACK_DAYS = 60;        // ventana de `orders` para detectar una orden ACTIVA del mismo teléfono (cubre entregas lentas; más viejas = ghost)

/** Una orden Dropi está ACTIVA (en curso) si NO está ENTREGADA ni muerta
 *  (cancelada/rechazada/anulada/reemplazada). Regla del dueño 2026-07-18: solo
 *  una orden ACTIVA bloquea una nueva subida (= duplicado); si su única orden ya
 *  está ENTREGADA, el cliente está RECOMPRANDO → sí se sube. */
function isActiveDropiEstado(estado: string | null): boolean {
  const e = String(estado || "").toUpperCase();
  if (!e) return true;                       // sin estado → conservador (bloquea)
  if (/ENTREGAD/.test(e)) return false;      // entregada → recompra ok, se sube
  if (/CANCEL/.test(e)) return false;        // cancelada → muerta (ya se ignoraba)
  return true;                               // cualquier otro estatus → en curso = duplicado
}

/** Últimos 9 dígitos — mismo criterio que shopify-reconcile / find_duplicate_phones. */
function last9(p: unknown): string {
  return String(p ?? "").replace(/\D/g, "").slice(-9);
}

function json(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...cors, "Content-Type": "application/json" },
  });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

interface ShopifyOrderLite {
  id: number;
  name: string;
  phone?: string | null;
  created_at: string;
  cancelled_at?: string | null;
  test?: boolean;
  customer?: { phone?: string } | null;
  shipping_address?: { phone?: string } | null;
  billing_address?: { phone?: string } | null;
}

function shopifyOrderPhone(o: ShopifyOrderLite): string {
  return last9(o.phone || o.customer?.phone || o.shipping_address?.phone || o.billing_address?.phone || "");
}

/** Trae pedidos de Shopify desde `sinceISO` (paginado por header Link, cap). */
async function fetchShopifyOrders(domain: string, token: string, sinceISO: string): Promise<ShopifyOrderLite[]> {
  const fields = "id,name,phone,customer,shipping_address,billing_address,created_at,cancelled_at,test";
  let url: string | null =
    `https://${domain}/admin/api/${SHOPIFY_API_VERSION}/orders.json?status=any&created_at_min=${encodeURIComponent(sinceISO)}&limit=250&fields=${fields}`;
  const all: ShopifyOrderLite[] = [];
  let pages = 0;
  while (url && pages < 5) {
    const res: Response = await fetch(url, {
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    });
    if (!res.ok) throw new Error(`Shopify [${res.status}]: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    all.push(...((data.orders || []) as ShopifyOrderLite[]));
    pages++;
    const link = res.headers.get("Link") || res.headers.get("link") || "";
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1] : null;
  }
  return all;
}

interface StoreRow { store_id: string }

/** Sube los pendientes limpios de UNA tienda. No lanza: captura su error para no
 *  frenar a las demás. Devuelve el resumen de la corrida de esa tienda. */
async function processStore(
  // deno-lint-ignore no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  supabaseUrl: string,
  serviceKey: string,
  cronSecret: string,
  storeId: string,
  dryRun: boolean,
): Promise<Record<string, unknown>> {
  const cfg = await loadShopifyConfig(sb, storeId);
  if (!cfg) return { store_id: storeId, skipped: "shopify no configurado" };
  const token = await getShopifyAccessToken(cfg);

  // 1. Pedidos de Shopify recientes (sin cancelados / prueba).
  const sinceShopify = new Date(Date.now() - SHOPIFY_LOOKBACK_DAYS * 86400000).toISOString();
  const shopify = (await fetchShopifyOrders(cfg.shopDomain, token, sinceShopify))
    .filter((o) => !o.cancelled_at && !o.test);

  // 2. Teléfonos con una orden ACTIVA en Dropi (`orders`), para NO duplicar. Un
  // teléfono cuya única orden está ENTREGADA/cancelada NO entra acá → recompra →
  // se sube (regla del dueño 2026-07-18).
  const sinceDropi = new Date(Date.now() - DROPI_LOOKBACK_DAYS * 86400000).toISOString();
  const dropiActivePhones = new Set<string>();
  const PAGE = 1000;
  for (let from = 0; from < 20000; from += PAGE) {
    const { data, error } = await sb
      .from("orders").select("phone, estado")
      .eq("store_id", storeId).gte("created_at", sinceDropi)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`orders read: ${error.message}`);
    const rows = (data || []) as { phone: string | null; estado: string | null }[];
    for (const r of rows) {
      const k = last9(r.phone);
      if (k.length >= 7 && isActiveDropiEstado(r.estado)) dropiActivePhones.add(k);
    }
    if (rows.length < PAGE) break;
  }

  // 3. Intentos previos (idempotencia + enfriamiento de 'error').
  const pushedByOrderId = new Map<string, PushedRecord>();
  {
    const { data } = await sb
      .from("shopify_pushed_orders").select("shopify_order_id, status, pushed_at")
      .eq("store_id", storeId);
    for (const r of ((data || []) as { shopify_order_id: string; status: string; pushed_at: string }[])) {
      pushedByOrderId.set(String(r.shopify_order_id), {
        status: String(r.status || ""),
        pushedAtMs: new Date(r.pushed_at).getTime() || 0,
      });
    }
  }

  // 4. Seleccionar candidatos limpios (lógica pura testeada).
  const candidatesInput: ShopifyPendingLike[] = shopify.map((o) => ({
    shopify_order_id: String(o.id),
    phoneLast9: shopifyOrderPhone(o),
    createdAtMs: new Date(o.created_at).getTime() || 0,
  }));
  const nameById = new Map(shopify.map((o) => [String(o.id), o.name]));
  const picked = selectAutoPushCandidates(candidatesInput, dropiActivePhones, pushedByOrderId, {
    nowMs: Date.now(), minAgeMs: MIN_AGE_MS, maxAgeMs: MAX_AGE_MS,
    errorCooldownMs: ERROR_COOLDOWN_MS, cap: PER_STORE_CAP,
  });

  if (dryRun) {
    return {
      store_id: storeId, dry_run: true,
      shopify_recientes: shopify.length, candidatos: picked.length,
      subiria: picked.map((p) => ({ shopify_order_id: p.shopify_order_id, name: nameById.get(p.shopify_order_id) })),
    };
  }

  // 5. Subir cada candidato vía shopify-push-dropi (con sus candados).
  let pushed = 0, dup = 0, blocked = 0, errors = 0;
  const detail: Record<string, unknown>[] = [];
  for (const c of picked) {
    try {
      const res = await fetch(`${supabaseUrl}/functions/v1/shopify-push-dropi`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // La service-role key satisface el gateway (verify_jwt); el x-cron-secret
          // le dice a shopify-push-dropi que use el camino de cron (sin JWT de usuario).
          "Authorization": `Bearer ${serviceKey}`,
          "x-cron-secret": cronSecret,
        },
        body: JSON.stringify({ store_id: storeId, shopify_order_id: c.shopify_order_id, mode: "confirm" }),
      });
      const body = await res.json().catch(() => ({})) as Record<string, unknown>;
      if (res.ok && body.ok === true) {
        pushed++;
        detail.push({ id: c.shopify_order_id, ok: true, dropi: body.dropi_order_id });
      } else if (body.blocked === "duplicate_phone") {
        dup++;
        detail.push({ id: c.shopify_order_id, blocked: "duplicado" });
      } else {
        blocked++;
        detail.push({ id: c.shopify_order_id, blocked: body.blocked ?? "error", msg: String(body.error ?? "").slice(0, 140) });
      }
    } catch (e) {
      errors++;
      detail.push({ id: c.shopify_order_id, error: e instanceof Error ? e.message : String(e) });
    }
    await sleep(PUSH_DELAY_MS);
  }

  // Log a sync_logs (best-effort): 'warn' si hubo errores de infra, sino 'success'.
  try {
    await sb.from("sync_logs").insert({
      source: "shopify-auto-push",
      status: errors > 0 ? "warn" : "success",
      synced_count: pushed,
      duplicates_count: dup,
      total_count: picked.length,
      error_message: errors > 0 ? `${errors} error(es) de red/infra en el push` : null,
      store_id: storeId,
    });
  } catch { /* logging best-effort */ }

  return { store_id: storeId, candidatos: picked.length, subidos: pushed, duplicados: dup, bloqueados: blocked, errores: errors, detail };
}

Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceKey);

    // ---- Auth: cron secret (pg_cron) o admin (Bearer JWT) ----
    const { data: secretRow } = await sb
      .from("app_settings").select("value").eq("key", "cron_shared_secret").maybeSingle();
    const cronSecret = String(secretRow?.value || "");
    const cronHeader = req.headers.get("x-cron-secret");
    let authed = false;
    if (cronHeader) {
      if (cronSecret && cronHeader === cronSecret) authed = true;
      else return json({ error: "Cron secret inválido" }, 401, cors);
    } else {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) return json({ error: "No autorizado" }, 401, cors);
      if (authHeader === `Bearer ${serviceKey}`) {
        authed = true;
      } else {
        const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
        const anonClient = createClient(supabaseUrl, anonKey);
        const { data: { user }, error: authErr } = await anonClient.auth.getUser(authHeader.replace("Bearer ", ""));
        if (authErr || !user) return json({ error: "Token inválido" }, 401, cors);
        const { data: roleData } = await sb
          .from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin").maybeSingle();
        if (!roleData) return json({ error: "Solo administradores" }, 403, cors);
        authed = true;
      }
    }
    if (!authed) return json({ error: "No autorizado" }, 401, cors);
    if (!cronSecret) return json({ error: "Falta cron_shared_secret en app_settings" }, 500, cors);

    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { /* sin body */ }
    const onlyStore = typeof body.store_id === "string" ? body.store_id.trim() : "";
    const dryRun = body.dry_run === true;

    // ---- Tiendas habilitadas (auto_push_enabled + activas) ----
    let q = sb
      .from("store_shopify_config")
      .select("store_id, stores!inner(status)")
      .eq("active", true).eq("auto_push_enabled", true)
      .eq("stores.status", "active");
    if (onlyStore) q = q.eq("store_id", onlyStore);
    const { data: stores, error: stErr } = await q;
    if (stErr) return json({ error: `store_shopify_config: ${stErr.message}` }, 500, cors);

    const rows = (stores || []) as StoreRow[];
    if (rows.length === 0) {
      return json({ ok: true, stores: 0, message: "Sin tiendas con auto-envío habilitado" }, 200, cors);
    }

    const results: Record<string, unknown>[] = [];
    for (const s of rows) {
      try {
        results.push(await processStore(sb, supabaseUrl, serviceKey, cronSecret, String(s.store_id), dryRun));
      } catch (e) {
        results.push({ store_id: s.store_id, error: e instanceof Error ? e.message : String(e) });
      }
    }

    return json({ ok: true, dry_run: dryRun, stores: rows.length, results }, 200, cors);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("shopify-auto-push error:", msg);
    return json({ ok: false, error: msg }, 500, cors);
  }
});

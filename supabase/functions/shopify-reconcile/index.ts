// shopify-reconcile — detecta pedidos de Shopify que NO llegaron a Dropi.
//
// La automatización Shopify→Dropi a veces falla y deja pedidos colgados en
// Shopify que nunca se despachan. Esta función trae los pedidos recientes de
// Shopify de una tienda y los cruza por TELÉFONO contra los pedidos que ya
// están en Dropi (tabla `orders`). Devuelve los NO emparejados = pendientes
// de pasar a Dropi a mano.
//
// Body: { store_id: string, days?: number }   // days default = 3
// Auth: Authorization: Bearer <user_jwt>  (debe ser miembro de la tienda)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { isStoreMember } from "../_shared/dropiStoreConfig.ts";
import { loadShopifyConfig } from "../_shared/shopifyStoreConfig.ts";

const SHOPIFY_API_VERSION = "2024-10";

/** Últimos 9 dígitos — mismo criterio que src/lib/phone.ts. */
function normalizePhone(p: unknown): string {
  return String(p ?? "").replace(/\D/g, "").slice(-9);
}

interface ShopifyAddress { phone?: string; name?: string; city?: string }
interface ShopifyOrder {
  id: number;
  name: string;            // "#1234"
  phone?: string | null;
  created_at: string;
  cancelled_at?: string | null;
  total_price?: string;
  customer?: { first_name?: string; last_name?: string; phone?: string } | null;
  shipping_address?: ShopifyAddress | null;
  billing_address?: ShopifyAddress | null;
}

function orderPhone(o: ShopifyOrder): string {
  return normalizePhone(
    o.phone || o.customer?.phone || o.shipping_address?.phone || o.billing_address?.phone || "",
  );
}

function orderCustomer(o: ShopifyOrder): string {
  const c = `${o.customer?.first_name || ""} ${o.customer?.last_name || ""}`.trim();
  return c || o.shipping_address?.name || "Sin nombre";
}

/** Fetch de pedidos de Shopify (paginado por header Link, cap defensivo). */
async function fetchShopifyOrders(domain: string, token: string, sinceISO: string): Promise<ShopifyOrder[]> {
  const fields = "id,name,phone,customer,shipping_address,billing_address,created_at,cancelled_at,financial_status,total_price";
  let url: string | null =
    `https://${domain}/admin/api/${SHOPIFY_API_VERSION}/orders.json?status=any&created_at_min=${encodeURIComponent(sinceISO)}&limit=250&fields=${fields}`;
  const all: ShopifyOrder[] = [];
  let pages = 0;

  while (url && pages < 5) {
    const res: Response = await fetch(url, {
      method: "GET",
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Shopify API [${res.status}]: ${txt.slice(0, 300)}`);
    }
    const data = await res.json();
    const orders = (data.orders || []) as ShopifyOrder[];
    all.push(...orders);
    pages++;

    // Paginación cursor-based: header Link con rel="next".
    const link = res.headers.get("Link") || res.headers.get("link") || "";
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1] : null;
  }
  return all;
}

Deno.serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceKey);

    // Auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ ok: false, error: "No autorizado" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const anonClient = createClient(supabaseUrl, anonKey);
    const { data: { user }, error: authError } = await anonClient.auth.getUser(authHeader.replace("Bearer ", ""));
    if (authError || !user) {
      return new Response(JSON.stringify({ ok: false, error: "Token inválido" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { /* sin body */ }
    const storeId = typeof body.store_id === "string" ? body.store_id.trim() : "";
    const days = Math.min(30, Math.max(1, Number(body.days) || 3));
    if (!storeId) {
      return new Response(JSON.stringify({ ok: false, error: "Falta store_id" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Gate: miembro de la tienda (operadora o dueño — ambos trabajan la lista).
    if (!(await isStoreMember(sb, user.id, storeId))) {
      return new Response(JSON.stringify({ ok: false, error: "No sos miembro de esta tienda" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Config Shopify de la tienda
    const cfg = await loadShopifyConfig(sb, storeId);
    if (!cfg) {
      return new Response(JSON.stringify({ ok: true, configured: false, pendingCount: 0, pending: [] }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 1. Pedidos de Shopify (últimos `days` días, sin cancelados)
    const sinceShopify = new Date(Date.now() - days * 86400000).toISOString();
    const shopifyOrders = (await fetchShopifyOrders(cfg.shopDomain, cfg.adminToken, sinceShopify))
      .filter((o) => !o.cancelled_at);

    // 2. Teléfonos de Dropi (Guardian `orders`) de la tienda, ventana generosa
    //    (days + 4) para cubrir pedidos entrados a Dropi después de la venta.
    //    Paginado: el SELECT de Supabase tope ~1000 filas por página.
    const sinceDropi = new Date(Date.now() - (days + 4) * 86400000).toISOString();
    const dropiCount = new Map<string, number>();
    const PAGE = 1000;
    for (let from = 0; from < 20000; from += PAGE) {
      const { data, error } = await sb
        .from("orders")
        .select("phone")
        .eq("store_id", storeId)
        .gte("created_at", sinceDropi)
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`orders read: ${error.message}`);
      const rows = (data || []) as { phone: string | null }[];
      for (const r of rows) {
        const k = normalizePhone(r.phone);
        if (k) dropiCount.set(k, (dropiCount.get(k) || 0) + 1);
      }
      if (rows.length < PAGE) break;
    }

    // 3. Cruce count-aware. Por teléfono: pendientes = shopifyN - dropiN.
    //    Agrupamos los pedidos Shopify por teléfono (más recientes primero) y
    //    marcamos como pendientes los que exceden lo que ya hay en Dropi.
    const byPhone = new Map<string, ShopifyOrder[]>();
    const noPhone: ShopifyOrder[] = [];
    for (const o of shopifyOrders) {
      const k = orderPhone(o);
      if (!k) { noPhone.push(o); continue; }
      if (!byPhone.has(k)) byPhone.set(k, []);
      byPhone.get(k)!.push(o);
    }

    const pending: Record<string, unknown>[] = [];
    const toCard = (o: ShopifyOrder, sinTel = false) => ({
      id: String(o.id),
      name: o.name,
      customer: orderCustomer(o),
      phone: o.phone || o.customer?.phone || o.shipping_address?.phone || "",
      total: o.total_price ? Number(o.total_price) : 0,
      created_at: o.created_at,
      city: o.shipping_address?.city || "",
      sin_telefono: sinTel,
      admin_url: `https://${cfg.shopDomain}/admin/orders/${o.id}`,
    });

    for (const [k, list] of byPhone.entries()) {
      const already = dropiCount.get(k) || 0;
      // los más recientes primero
      list.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      const deficit = Math.max(0, list.length - already);
      for (let i = 0; i < deficit; i++) pending.push(toCard(list[i]));
    }
    // Sin teléfono → no se puede emparejar; van como pendientes para revisar.
    for (const o of noPhone) pending.push(toCard(o, true));

    pending.sort((a, b) => new Date(b.created_at as string).getTime() - new Date(a.created_at as string).getTime());

    return new Response(
      JSON.stringify({
        ok: true,
        configured: true,
        pendingCount: pending.length,
        shopifyTotal: shopifyOrders.length,
        days,
        pending,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("shopify-reconcile error:", msg);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

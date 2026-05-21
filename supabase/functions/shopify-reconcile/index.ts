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

    // 1. Pedidos de Shopify (últimos `days` días). Separamos cancelados (no se
    //    despachan, no cuentan) pero los reportamos por transparencia.
    const sinceShopify = new Date(Date.now() - days * 86400000).toISOString();
    const allShopify = await fetchShopifyOrders(cfg.shopDomain, cfg.adminToken, sinceShopify);
    const shopifyOrders = allShopify.filter((o) => !o.cancelled_at);
    const cancelledCount = allShopify.length - shopifyOrders.length;

    // 2. Pedidos de Dropi (Guardian `orders`) de la tienda: teléfono + fecha.
    //    Ventana generosa (days + 6) para cubrir pedidos entrados a Dropi
    //    después de la venta. Paginado (SELECT tope ~1000 filas).
    const sinceDropi = new Date(Date.now() - (days + 6) * 86400000).toISOString();
    const dropiList: { tel: string; t: number }[] = [];
    const PAGE = 1000;
    for (let from = 0; from < 20000; from += PAGE) {
      const { data, error } = await sb
        .from("orders")
        .select("phone, created_at")
        .eq("store_id", storeId)
        .gte("created_at", sinceDropi)
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`orders read: ${error.message}`);
      const rows = (data || []) as { phone: string | null; created_at: string }[];
      for (const r of rows) {
        const k = normalizePhone(r.phone);
        if (k) dropiList.push({ tel: k, t: new Date(r.created_at).getTime() });
      }
      if (rows.length < PAGE) break;
    }

    // 3. Cruce por TELÉFONO + cercanía de fecha (greedy, count-aware).
    //    Para cada pedido Shopify (del más viejo al más nuevo) buscamos un
    //    pedido Dropi NO usado con el mismo teléfono y fecha cercana
    //    [shopify-1d, shopify+6d]. Si lo hay → emparejado; si no → pendiente.
    //    Así un pedido nuevo NO se "matchea" contra una orden vieja del mismo
    //    cliente (eso escondería una fuga).
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

    const usedDropi = new Set<number>();
    function matchDropi(tel: string, shopT: number): boolean {
      const lo = shopT - 1 * 86400000;
      const hi = shopT + 6 * 86400000;
      for (let i = 0; i < dropiList.length; i++) {
        if (usedDropi.has(i)) continue;
        const d = dropiList[i];
        if (d.tel === tel && d.t >= lo && d.t <= hi) { usedDropi.add(i); return true; }
      }
      return false;
    }

    // Emparejar del más viejo al más nuevo (asignación estable).
    const sortedAsc = [...shopifyOrders].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    const pending: Record<string, unknown>[] = [];
    for (const o of sortedAsc) {
      const tel = orderPhone(o);
      const shopT = new Date(o.created_at).getTime();
      const matched = tel ? matchDropi(tel, shopT) : false;
      if (!matched) pending.push(toCard(o, !tel));
    }
    pending.sort((a, b) => new Date(b.created_at as string).getTime() - new Date(a.created_at as string).getTime());

    // 4. Desglose: hoy + por día (TZ America/Bogota = UTC-5, sirve CO y EC).
    const TZ = "America/Bogota";
    const fmtDay = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(iso));
    const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
    const shopifyByDate: Record<string, number> = {};
    const pendingByDate: Record<string, number> = {};
    for (const o of shopifyOrders) { const d = fmtDay(o.created_at); shopifyByDate[d] = (shopifyByDate[d] || 0) + 1; }
    for (const p of pending) { const d = fmtDay(p.created_at as string); pendingByDate[d] = (pendingByDate[d] || 0) + 1; }
    const byDay = Object.keys(shopifyByDate).sort().reverse().map((date) => ({
      date,
      shopify: shopifyByDate[date],
      pending: pendingByDate[date] || 0,
      matched: shopifyByDate[date] - (pendingByDate[date] || 0),
    }));
    const todayShopify = shopifyByDate[todayStr] || 0;
    const todayPending = pendingByDate[todayStr] || 0;

    return new Response(
      JSON.stringify({
        ok: true,
        configured: true,
        days,
        shopifyTotal: shopifyOrders.length,
        cancelledCount,
        matchedCount: shopifyOrders.length - pending.length,
        pendingCount: pending.length,
        today: todayStr,
        todayShopify,
        todayMatched: todayShopify - todayPending,
        todayPending,
        byDay,
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

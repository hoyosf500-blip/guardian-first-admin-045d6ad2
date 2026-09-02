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
import { loadShopifyConfig, getShopifyAccessToken } from "../_shared/shopifyStoreConfig.ts";
import { respuestaPing } from "../_shared/versionEdge.ts";
import { elegirPedidoDropi, estaCancelado } from "../_shared/reconcileMatch.ts";

// Subir esta marca EN EL MISMO COMMIT que el cambio, o el ping miente.
const VERSION = "shopify-reconcile 2026-09-02.2 empareja-el-vivo";

const SHOPIFY_API_VERSION = "2024-10";

/** Últimos 9 dígitos — mismo criterio que src/lib/phone.ts. */
function normalizePhone(p: unknown): string {
  return String(p ?? "").replace(/\D/g, "").slice(-9);
}

interface ShopifyAddress { phone?: string; name?: string; city?: string }
interface ShopifyLineItem { title?: string; name?: string; quantity?: number; product_id?: number | null }
interface ShopifyOrder {
  id: number;
  name: string;            // "#1234"
  phone?: string | null;
  created_at: string;
  cancelled_at?: string | null;
  test?: boolean;          // órdenes de prueba: Shopify NO las cuenta en "Pedidos"
  total_price?: string;
  customer?: { first_name?: string; last_name?: string; phone?: string } | null;
  shipping_address?: ShopifyAddress | null;
  billing_address?: ShopifyAddress | null;
  line_items?: ShopifyLineItem[]; // productos de la orden (para el reporte de fuga por producto)
}

/** Producto principal de la orden (el de mayor cantidad) + su product_id, para
 *  agrupar la fuga por producto. Devuelve título legible aunque falte el resto. */
function mainProduct(o: ShopifyOrder): { producto: string; product_id: number | null } {
  const items = Array.isArray(o.line_items) ? o.line_items : [];
  if (items.length === 0) return { producto: "", product_id: null };
  const top = [...items].sort((a, b) => (b.quantity ?? 0) - (a.quantity ?? 0))[0];
  const producto = (top.title || top.name || "").trim() || "(sin título)";
  const extra = items.length > 1 ? ` +${items.length - 1}` : "";
  return { producto: producto + extra, product_id: typeof top.product_id === "number" ? top.product_id : null };
}

/** Zona horaria IANA de la tienda Shopify (para que "hoy" coincida con el
 *  dashboard). Fallback a America/Bogota (UTC-5, sirve CO y EC) si falla. */
async function fetchShopTimezone(domain: string, token: string): Promise<string> {
  try {
    const res = await fetch(`https://${domain}/admin/api/${SHOPIFY_API_VERSION}/shop.json?fields=iana_timezone`, {
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    });
    if (res.ok) {
      const d = await res.json();
      const tz = d?.shop?.iana_timezone;
      if (tz && typeof tz === "string") return tz;
    }
  } catch { /* fallback abajo */ }
  return "America/Bogota";
}

/** Estados que significan "ese pedido ya no existe en Dropi": emparejar contra
 *  ellos esconde la fuga (el cliente pagó y nadie va a despachar). ARCHIVADO
 *  GHOST se escribe CON ESPACIO (dropi-nightly-reconcile); la variante con guion
 *  bajo aparece en filas históricas. CANCELADO NO va acá: una cancelación real
 *  del cliente no es una fuga y marcarla como pendiente generaría falsos. */
const ESTADOS_MUERTOS = new Set(["ARCHIVADO GHOST", "REEMPLAZADA"]);
function esEstadoMuerto(estado: string): boolean {
  const e = estado.toUpperCase().replace(/_/g, " ").trim();
  return ESTADOS_MUERTOS.has(e);
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
  const fields = "id,name,phone,customer,shipping_address,billing_address,created_at,cancelled_at,test,financial_status,total_price,line_items";
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
  { const p = respuestaPing(req, VERSION, corsHeaders); if (p) return p; }

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
    //    El token se obtiene en runtime: si la tienda usa client_id/secret del
    //    Dev Dashboard, hacemos el client credentials grant (token 24h cacheado);
    //    si tiene un admin_token estático viejo, se usa directo.
    const accessToken = await getShopifyAccessToken(cfg);
    const sinceShopify = new Date(Date.now() - days * 86400000).toISOString();
    const allShopify = await fetchShopifyOrders(cfg.shopDomain, accessToken, sinceShopify);
    // No cuentan: canceladas (no se despachan) ni de prueba (Shopify tampoco las
    // cuenta en "Pedidos"). Reportamos las canceladas aparte por transparencia.
    const shopifyOrders = allShopify.filter((o) => !o.cancelled_at && !o.test);
    const cancelledCount = allShopify.filter((o) => o.cancelled_at).length;

    // 2. Pedidos de Dropi (Guardian `orders`) de la tienda: teléfono + fecha.
    //    Ventana generosa (days + 6) para cubrir pedidos entrados a Dropi
    //    después de la venta. Paginado (SELECT tope ~1000 filas).
    const sinceDropi = new Date(Date.now() - (days + 6) * 86400000).toISOString();
    // Además del teléfono+fecha (para el cruce), guardamos valor/external_id/estado
    // para poder comparar el valor en los pares emparejados (auditoría de "valor distinto").
    const dropiList: { tel: string; t: number; valor: number; external_id: string; estado: string; nombre: string; ciudad: string }[] = [];
    const PAGE = 1000;
    for (let from = 0; from < 20000; from += PAGE) {
      const { data, error } = await sb
        .from("orders")
        .select("phone, created_at, valor, external_id, estado, nombre, ciudad")
        .eq("store_id", storeId)
        .gte("created_at", sinceDropi)
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`orders read: ${error.message}`);
      const rows = (data || []) as { phone: string | null; created_at: string; valor: number | null; external_id: string | null; estado: string | null; nombre: string | null; ciudad: string | null }[];
      for (const r of rows) {
        const k = normalizePhone(r.phone);
        // Un pedido borrado/reemplazado en Dropi no puede "cubrir" la venta de
        // Shopify: se deja fuera del cruce para que vuelva a salir como pendiente.
        if (esEstadoMuerto(String(r.estado ?? ""))) continue;
        if (k) dropiList.push({
          tel: k, t: new Date(r.created_at).getTime(),
          valor: Number(r.valor) || 0, external_id: String(r.external_id ?? ""), estado: String(r.estado ?? ""),
          nombre: String(r.nombre ?? ""), ciudad: String(r.ciudad ?? ""),
        });
      }
      if (rows.length < PAGE) break;
    }

    // 3. Cruce por TELÉFONO + cercanía de fecha (greedy, count-aware).
    //    Para cada pedido Shopify (del más viejo al más nuevo) buscamos un
    //    pedido Dropi NO usado con el mismo teléfono y fecha cercana
    //    [shopify-1d, shopify+6d]. Si lo hay → emparejado; si no → pendiente.
    //    Así un pedido nuevo NO se "matchea" contra una orden vieja del mismo
    //    cliente (eso escondería una fuga).
    const toCard = (o: ShopifyOrder, sinTel = false) => {
      const mp = mainProduct(o);
      return {
        id: String(o.id),
        name: o.name,
        customer: orderCustomer(o),
        phone: o.phone || o.customer?.phone || o.shipping_address?.phone || "",
        total: o.total_price ? Number(o.total_price) : 0,
        created_at: o.created_at,
        city: o.shipping_address?.city || "",
        sin_telefono: sinTel,
        admin_url: `https://${cfg.shopDomain}/admin/orders/${o.id}`,
        producto: mp.producto,       // producto principal — reporte de fuga por producto
        product_id: mp.product_id,   // id Shopify del producto (agrupación estable)
      };
    };

    const usedDropi = new Set<number>();
    /** Ver `_shared/reconcileMatch.ts`: elige el pedido VIVO más cercano, no el
     *  primero de la lista. Probado en `src/lib/reconcileMatch.test.ts`. */
    function matchDropi(tel: string, shopT: number): number {
      const i = elegirPedidoDropi(dropiList, tel, shopT, usedDropi);
      if (i >= 0) usedDropi.add(i);
      return i;
    }

    // Emparejar del más viejo al más nuevo (asignación estable). En los pares
    // emparejados comparamos el valor: si en Dropi se cobra MÁS que el total de
    // Shopify (descuento perdido u otra causa), lo reportamos en valueMismatches
    // para avisarle al operador (read-only, lo corrige a mano en Dropi).
    const sortedAsc = [...shopifyOrders].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    const pending: Record<string, unknown>[] = [];
    const matched: Record<string, unknown>[] = [];
    // Teléfono → la venta de Shopify que YA quedó cubierta. Sirve para detectar
    // el caso opuesto a la fuga: DOS pedidos en Dropi para UNA sola venta.
    const telsMatched = new Map<string, string>();
    const valueMismatches: Record<string, unknown>[] = [];
    for (const o of sortedAsc) {
      const tel = orderPhone(o);
      const shopT = new Date(o.created_at).getTime();
      const idx = tel ? matchDropi(tel, shopT) : -1;
      if (idx === -1) { pending.push(toCard(o, !tel)); continue; }
      // Par emparejado → comparar valor (misma tolerancia/dirección que el guardrail
      // del push: shopify-push-dropi/discount.ts isCodOvercharge; inline para no
      // acoplar dos edge functions deployadas por separado).
      const d = dropiList[idx];
      // El pedido emparejado también se devuelve: sin esto el panel solo podía
      // mostrar lo que FALTA, y para comprobar el cuadre había que contar a mano
      // contra el panel de Shopify. Ahora se ve pedido por pedido con su número
      // de Dropi al lado.
      matched.push({ ...toCard(o), external_id: d.external_id, estado: d.estado, dropi_valor: d.valor });
      if (tel) telsMatched.set(tel, o.name);
      const shopTotal = o.total_price ? Number(o.total_price) : 0;
      const tol = Math.max(2, shopTotal * 0.01);
      if (shopTotal > 0 && d.valor - shopTotal > tol) {
        valueMismatches.push({
          shopify_name: o.name,
          admin_url: `https://${cfg.shopDomain}/admin/orders/${o.id}`,
          customer: orderCustomer(o),
          phone: o.phone || o.customer?.phone || o.shipping_address?.phone || "",
          shopify_total: shopTotal,
          dropi_valor: d.valor,
          overcharge: Math.round(d.valor - shopTotal),
          external_id: d.external_id,
          estado: d.estado,
          created_at: o.created_at,
        });
      }
    }
    pending.sort((a, b) => new Date(b.created_at as string).getTime() - new Date(a.created_at as string).getTime());
    valueMismatches.sort((a, b) => Number(b.overcharge) - Number(a.overcharge));

    // DOS pedidos en Dropi para UNA venta de Shopify. Es el error espejo de la
    // fuga y cuesta igual o más: se despacha dos veces el mismo producto al
    // mismo cliente. También explica por qué contar filas nunca cuadra —
    // Guardian puede tener MÁS pedidos que Shopify.
    // Un pedido Dropi sobra si: quedó sin emparejar, no está cancelado, y su
    // teléfono pertenece a una venta de Shopify que YA quedó cubierta por otro.
    const duplicates: Record<string, unknown>[] = [];
    for (let i = 0; i < dropiList.length; i++) {
      if (usedDropi.has(i)) continue;
      const d = dropiList[i];
      if (estaCancelado(d.estado)) continue;
      const ventaCubierta = telsMatched.get(d.tel);
      if (!ventaCubierta) continue;
      duplicates.push({
        external_id: d.external_id,
        estado: d.estado,
        valor: d.valor,
        nombre: d.nombre,
        ciudad: d.ciudad,
        phone: d.tel,
        shopify_name: ventaCubierta,
        created_at: new Date(d.t).toISOString(),
      });
    }
    duplicates.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

    // 4. Desglose: hoy + por día, usando la ZONA HORARIA REAL de la tienda para
    //    que el corte "hoy" coincida con el dashboard de Shopify (clave en EC si
    //    la tienda no está en UTC-5). Fallback America/Bogota.
    const TZ = await fetchShopTimezone(cfg.shopDomain, accessToken);
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

    // El cuadre pedido-por-pedido se manda solo de HOY y AYER. Con 7 días, una
    // tienda como Ecuador devolvería ~425 fichas en cada poll (cada 3 min, por
    // pestaña abierta) para una pantalla que se mira por día. Los conteos de
    // arriba siguen cubriendo el período completo.
    const CUADRE_DIAS = 2;
    const diasCuadre = new Set<string>();
    for (let i = 0; i < CUADRE_DIAS; i++) {
      diasCuadre.add(new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(Date.now() - i * 86400000)));
    }
    const matchedRecientes = matched
      .filter((m) => diasCuadre.has(fmtDay(m.created_at as string)))
      .sort((a, b) => new Date(b.created_at as string).getTime() - new Date(a.created_at as string).getTime());

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
        // Cuadre del día: los que YA están en Dropi (hoy y ayer), con su número
        // de pedido de Dropi al lado. `matchedDays` dice hasta dónde llega para
        // que la pantalla no afirme un cuadre completo sobre datos recortados.
        matched: matchedRecientes,
        matchedDays: CUADRE_DIAS,
        duplicateCount: duplicates.length,
        duplicates,
        valueMismatchCount: valueMismatches.length,
        valueMismatches,
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

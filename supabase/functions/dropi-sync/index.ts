import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { loadStoreConfig, isStoreOwner } from "../_shared/dropiStoreConfig.ts";

const MAX_CHUNK_DAYS = 89;
const PAGE_SIZE = 100;
const RATE_LIMIT_MS = 500;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Split a date range into chunks of maxDays */
function chunkDateRange(from: string, to: string, maxDays: number) {
  const chunks: { from: string; to: string }[] = [];
  let start = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");

  while (start <= end) {
    const chunkEnd = new Date(start);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + maxDays - 1);
    const actualEnd = chunkEnd > end ? end : chunkEnd;
    chunks.push({
      from: start.toISOString().split("T")[0],
      to: actualEnd.toISOString().split("T")[0],
    });
    start = new Date(actualEnd);
    start.setUTCDate(start.getUTCDate() + 1);
  }
  return chunks;
}

/** Fetch all pages for a date chunk */
async function fetchAllPages(
  base: string,
  apiKey: string,
  origin: string,
  chunkFrom: string,
  chunkTo: string,
): Promise<Record<string, unknown>[]> {
  const allOrders: Record<string, unknown>[] = [];
  let start = 0;

  while (true) {
    const params: Record<string, string> = {
      result_number: String(PAGE_SIZE),
      start: String(start),
      date_from: chunkFrom,
      date_to: chunkTo,
      filter_date_by: "FECHA DE CREADO",
      orderBy: "id",
      orderDirection: "desc",
    };

    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");

    let res: Response | null = null;
    let lastErr = "";
    for (let attempt = 0; attempt < 5; attempt++) {
      res = await fetch(`${base}/integrations/orders/myorders?${qs}`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "dropi-integration-key": apiKey,
          "Origin": origin,
        },
      });
      if (res.status !== 429) break;
      lastErr = await res.text();
      // Exponential backoff: 2s, 4s, 8s, 16s, 32s
      await sleep(2000 * Math.pow(2, attempt));
    }

    if (!res || !res.ok) {
      const txt = res?.status === 429 ? lastErr : (res ? await res.text() : "no-response");
      throw new Error(`Dropi API [${res?.status ?? "no-response"}]: ${txt}`);
    }

    const data = await res.json();
    if (!data.isSuccess) {
      throw new Error(String(data.message || data.error || "Dropi error"));
    }

    const orders = data.objects || [];
    if (!Array.isArray(orders) || orders.length === 0) break;

    allOrders.push(...orders);

    if (orders.length < PAGE_SIZE) break;
    start += PAGE_SIZE;
    await sleep(RATE_LIMIT_MS);
  }

  return allOrders;
}

/** Calculate calendar days from a date string to today */
function calcDias(dateStr: string): number {
  if (!dateStr) return 0;
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return 0;
    return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
  } catch {
    return 0;
  }
}

/** Map a Dropi order to our DB schema */
function mapOrder(o: Record<string, unknown>, userId: string, today: string, storeId: string) {
  const products = (o.orderdetails as Array<Record<string, unknown>>) || [];
  const productName = products
    .map((p) => (p.product as Record<string, unknown>)?.name || "")
    .filter(Boolean)
    .join(", ");
  const cantidad = products.reduce(
    (sum, p) => sum + (parseFloat(String(p.quantity || "1")) || 1),
    0,
  );
  // Product cost = sum of supplier_price or sale_price from products
  const costoProd = products.reduce((sum, p) => {
    const supplierPrice = parseFloat(String(p.supplier_price || "0")) || 0;
    const salePrice = parseFloat(String((p.product as Record<string, unknown>)?.sale_price || "0")) || 0;
    return sum + (supplierPrice || salePrice);
  }, 0);

  const createdAt = String(o.created_at || "");
  const updatedAt = String(o.updated_at || "");
  const fecha = createdAt ? createdAt.split("T")[0] : today;

  // Determine fecha_conf from updated_at if status changed from PENDIENTE CONFIRMACION
  const status = String(o.status || "PENDIENTE").toUpperCase();
  const isPendConf = status === "PENDIENTE CONFIRMACION";
  const fechaConf = !isPendConf && updatedAt ? updatedAt.split("T")[0] : null;

  // Extract novedad from novedad_servientrega or servientrega_movements
  const novedadServ = o.novedad_servientrega ? String(o.novedad_servientrega) : "";
  const movements = (o.servientrega_movements as Array<Record<string, unknown>>) || [];
  const lastMovement = movements.length > 0 ? String(movements[movements.length - 1]?.description || movements[movements.length - 1]?.status || "") : "";
  const novedad = novedadServ || lastMovement;

  // H6: Antes el campo `novedad` recibía `notes` cuando no había
  // novedad real de transportadora — eso metía comentarios internos
  // ("cliente VIP, llamar después") en el campo que la operadora
  // interpreta como incidencia y abría flujos equivocados de Rescate.
  // Ahora `novedad` solo lleva la novedad real; los notes se descartan
  // del mapeo (no hay campo dedicado en orders).

  // Tags
  const tags = Array.isArray(o.tags) 
    ? (o.tags as Array<Record<string, unknown>>).map((t) => String(t.name || t)).filter(Boolean).join(", ")
    : String(o.tags || "");

  // Shop/tienda name
  const shop = o.shop as Record<string, unknown> | null;
  const tienda = shop ? String(shop.name || "") : "";

  // Guia: prefer shipping_guide, fallback to checking guia_urls3
  const guia = String(o.shipping_guide || "");

  // Distribution company (transportadora)
  const distCompany = o.distribution_company as Record<string, unknown> | null;
  const transportadora = distCompany ? String(distCompany.name || o.shipping_company || "") : String(o.shipping_company || "");

  // Novedad solucionada
  const novedadSol = Boolean(o.issue_solved_by_operator || o.managed_devolution_app);

  return {
    external_id: String(o.id || ""),
    uploaded_by: userId,
    store_id: storeId,
    upload_date: today,
    nombre: `${o.name || ""} ${o.surname || ""}`.trim() || "Sin nombre",
    phone: String(o.phone || "").replace(/[^0-9]/g, ""),
    ciudad: String(o.city || ""),
    departamento: String(o.state || ""),
    producto: productName || "Sin producto",
    estado: status,
    fecha,
    fecha_conf: fechaConf,
    dias: calcDias(createdAt),
    dias_conf: fechaConf ? calcDias(fechaConf) : 0,
    valor: parseFloat(String(o.total_order || "0")) || 0,
    flete: parseFloat(String(o.shipping_amount || "0")) || 0,
    costo_prod: costoProd,
    costo_dev: parseFloat(String(o.discounted_amount || "0")) || 0,
    cantidad: Math.round(cantidad),
    direccion: String(o.dir || ""),
    novedad,
    guia,
    transportadora,
    tags,
    tienda,
    novedad_sol: novedadSol,
  };
}

Deno.serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "No autorizado" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, supabaseServiceKey);

    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
    const anonClient = createClient(supabaseUrl, anonKey);
    const { data: { user }, error: authError } = await anonClient.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Token inválido" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }




    // Parse body — store_id is required (multi-tenant)
    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { /* no body */ }

    const storeId = typeof body.store_id === "string" && body.store_id.trim()
      ? body.store_id.trim()
      : (typeof body.storeId === "string" ? (body.storeId as string).trim() : "");

    if (!storeId) {
      return new Response(
        JSON.stringify({ error: "Falta store_id en el body" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Gate: caller debe ser owner de la tienda (sync es operación pesada)
    const isOwner = await isStoreOwner(sb, user.id, storeId);
    if (!isOwner) {
      return new Response(
        JSON.stringify({ error: "Solo el dueño de la tienda puede ejecutar el sync" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Load store credentials + país host
    const cfg = await loadStoreConfig(sb, storeId);
    if (!cfg.apiKey) {
      return new Response(
        JSON.stringify({ error: "La tienda no tiene Clave API de Dropi configurada" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const defaultFrom = new Date();
    defaultFrom.setUTCDate(defaultFrom.getUTCDate() - 90);
    const from = (body.from as string) || defaultFrom.toISOString().split("T")[0];
    const untill = (body.untill as string) || new Date().toISOString().split("T")[0];

    // Chunk the date range
    const chunks = chunkDateRange(from, untill, MAX_CHUNK_DAYS);
    const today = new Date().toISOString().split("T")[0];

    let totalSynced = 0;
    const totalDuplicates = 0;
    let totalFromDropi = 0;

    for (const chunk of chunks) {
      const dropiOrders = await fetchAllPages(cfg.base, cfg.apiKey, cfg.storeUrl, chunk.from, chunk.to);
      totalFromDropi += dropiOrders.length;

      if (dropiOrders.length === 0) continue;

      const dbOrders = dropiOrders.map((o) => mapOrder(o, user.id, today, storeId));

      // RPC upsert_orders_from_dropi: ON CONFLICT DO UPDATE WHERE
      // IS DISTINCT FROM. Filas idénticas no se reescriben → no se
      // dispara realtime espurio que hacía parpadear la UI de
      // operadoras. Mismo patrón que dropi-cron.
      for (let i = 0; i < dbOrders.length; i += 50) {
        const batch = dbOrders.slice(i, i + 50);
        const { data: changedCount, error: upsertError } = await sb.rpc(
          "upsert_orders_from_dropi",
          { p_orders: batch },
        );

        if (upsertError) {
          console.error("upsert_orders_from_dropi error:", upsertError);
        } else {
          totalSynced += (changedCount as number) || 0;
        }
      }

      await sleep(RATE_LIMIT_MS);
    }

    // Fix 8: usar fecha de Bogotá. Antes UTC dejaba fuera las confirmaciones
    // hechas después de las 19:00 COL.
    const todayDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(new Date());
    const { data: confirmedToday } = await sb
      .from("order_results")
      .select("order_id")
      .eq("result", "conf")
      .eq("result_date", todayDate)
      .eq("store_id", storeId);

    if (confirmedToday && confirmedToday.length > 0) {
      const confirmedIds = confirmedToday.map((r) => r.order_id);
      for (let i = 0; i < confirmedIds.length; i += 50) {
        const batch = confirmedIds.slice(i, i + 50);
        await sb
          .from("orders")
          .update({ estado: "PENDIENTE" })
          .in("id", batch)
          .eq("store_id", storeId)
          .eq("estado", "PENDIENTE CONFIRMACION");
      }
    }

    // Detectar y cancelar pedidos huérfanos: cuando Dropi edita un pedido,
    // crea uno nuevo y deja el viejo en PENDIENTE CONFIRMACION. Esta RPC
    // busca pedidos viejos con un duplicado más nuevo en estado terminal
    // (mismo phone+producto) y los marca como CANCELADO.
    let orphansCancelled = 0;
    try {
      const { data, error: cancelOrphanError } = await sb.rpc('cancel_orphan_pending_orders');
      if (cancelOrphanError) {
        console.warn('cancel_orphan_pending_orders error:', cancelOrphanError.message);
      } else {
        orphansCancelled = (data as number) || 0;
        if (orphansCancelled > 0) {
          console.log(`Cancelados ${orphansCancelled} pedidos viejos huérfanos`);
        }
      }
    } catch (err) {
      console.warn('cancel_orphan_pending_orders exception:', err);
    }

    // Log
    await sb.from("sync_logs").insert({
      source: "dropi",
      status: "success",
      synced_count: totalSynced,
      duplicates_count: totalDuplicates,
      total_count: totalFromDropi,
      triggered_by: user.id,
      store_id: storeId,
    });

    return new Response(
      JSON.stringify({
        synced: totalSynced,
        duplicates: totalDuplicates,
        total: totalFromDropi,
        chunks: chunks.length,
        message: `${totalSynced} pedidos sincronizados (${chunks.length} chunk${chunks.length > 1 ? "s" : ""})`,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("dropi-sync error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Error interno" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

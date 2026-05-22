import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { dropiHostFor } from "../_shared/dropiHosts.ts";

/**
 * dropi-cron: Automated sync triggered by pg_cron every 5 minutes.
 * Syncs orders from the last 14 days to capture status changes.
 * Auth: pg_cron sends x-cron-secret; admins send Authorization Bearer JWT.
 *
 * v4 — MULTI-TIENDA. Antes leía UNA credencial global de app_settings y
 *      pegaba siempre a api.dropi.co. Ahora recorre todas las tiendas
 *      activas de store_dropi_config y sincroniza cada una con SU país
 *      (host correcto), SUS credenciales y SU dueño, etiquetando cada
 *      pedido con su store_id. Una tienda que falla no frena a las demás.
 *
 * v3 — usa RPC upsert_orders_from_dropi (con guardia IS DISTINCT FROM)
 *      para no spamear realtime.
 */

const MAX_CHUNK_DAYS = 89;
const PAGE_SIZE = 100;
// 1500ms entre páginas = ~40 req/min, por debajo del throttle de Dropi (~60/min).
// Antes 500ms (~120 req/min) hacía que el cron mismo se pasara del límite en
// cuentas grandes (Ecuador: ~50 páginas/corrida) → 429 "Too Many Attempts", que
// además tumbaba el botón manual "Probar conexión". Más lento pero estable.
const RATE_LIMIT_MS = 1500;
// Dos ventanas: una por CAMBIO DE ESTATUS (refresca guías que se movieron/
// entregaron, sin importar la fecha de creación) y una corta por CREADO
// (red de seguridad para órdenes nuevas que aún no cambiaron de estatus).
const STATUS_CHANGE_DAYS_BACK = 21;
const CREATED_DAYS_BACK = 3;
// Pausa entre tiendas para no encadenar ráfagas de una tienda con la siguiente.
const INTER_STORE_MS = 3000;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

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

async function fetchAllPages(
  base: string,
  apiKey: string,
  origin: string,
  chunkFrom: string,
  chunkTo: string,
  filterDateBy: string,
): Promise<Record<string, unknown>[]> {
  const allOrders: Record<string, unknown>[] = [];
  let start = 0;

  while (true) {
    const params: Record<string, string> = {
      result_number: String(PAGE_SIZE),
      start: String(start),
      date_from: chunkFrom,
      date_to: chunkTo,
      filter_date_by: filterDateBy,
      orderBy: "id",
      orderDirection: "desc",
    };

    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");

    let res: Response | null = null;
    let lastTxt = "";
    let rateLimited = false;
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
      if (res.status !== 429) { rateLimited = false; break; }
      rateLimited = true;
      lastTxt = await res.text();
      await sleep(2000 * Math.pow(2, attempt));
    }

    if (!res || !res.ok) {
      const txt = rateLimited ? lastTxt : (res ? await res.text() : "no-response");
      console.error(`Dropi API error ${res?.status ?? "?"}: ${txt}`);
      break;
    }

    const data = await res.json();
    if (!data.isSuccess) {
      console.error(`Dropi API not successful: ${data.message || data.error}`);
      break;
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
  const costoProd = products.reduce((sum, p) => {
    const supplierPrice = parseFloat(String(p.supplier_price || "0")) || 0;
    const salePrice = parseFloat(String((p.product as Record<string, unknown>)?.sale_price || "0")) || 0;
    return sum + (supplierPrice || salePrice);
  }, 0);

  const createdAt = String(o.created_at || "");
  const updatedAt = String(o.updated_at || "");
  const fecha = createdAt ? createdAt.split("T")[0] : today;
  const status = String(o.status || "PENDIENTE").toUpperCase();
  const isPendConf = status === "PENDIENTE CONFIRMACION";
  const fechaConf = !isPendConf && updatedAt ? updatedAt.split("T")[0] : null;

  const novedadServ = o.novedad_servientrega ? String(o.novedad_servientrega) : "";
  const movements = (o.servientrega_movements as Array<Record<string, unknown>>) || [];
  const lastMovement = movements.length > 0 ? String(movements[movements.length - 1]?.description || movements[movements.length - 1]?.status || "") : "";
  const novedad = novedadServ || lastMovement;

  const tags = Array.isArray(o.tags)
    ? (o.tags as Array<Record<string, unknown>>).map((t) => String(t.name || t)).filter(Boolean).join(", ")
    : String(o.tags || "");

  const shop = o.shop as Record<string, unknown> | null;
  const tienda = shop ? String(shop.name || "") : "";
  const guia = String(o.shipping_guide || "");
  const distCompany = o.distribution_company as Record<string, unknown> | null;
  const transportadora = distCompany ? String(distCompany.name || o.shipping_company || "") : String(o.shipping_company || "");
  const novedadSol = Boolean(o.issue_solved_by_operator || o.managed_devolution_app);

  return {
    external_id: String(o.id || ""),
    store_id: storeId,
    uploaded_by: userId,
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

interface StoreSync {
  store_id: string;
  country_code: string;
  api_key: string;
  store_url: string;
  owner_id: string;
}

/** Una "pasada" de sync: un rango de fechas con un criterio de filtrado.
 *  Corremos 2 por tienda: cambio de estatus (refresca guías que se movieron,
 *  sin importar antigüedad) + creado reciente (red de seguridad para nuevas). */
interface SyncPass { from: string; to: string; filterDateBy: string }

// Sincroniza UNA tienda con varias pasadas. Devuelve {synced, total}. No lanza:
// captura su propio error para que una tienda caída no frene a las demás. El
// upsert es idempotente (guardia IS DISTINCT FROM), así que pasadas que se
// solapan no duplican ni spamean realtime.
async function syncStore(
  // deno-lint-ignore no-explicit-any
  sb: any,
  store: StoreSync,
  passes: SyncPass[],
  todayStr: string,
): Promise<{ synced: number; total: number; error?: string }> {
  const base = dropiHostFor(store.country_code);
  let synced = 0;
  let total = 0;

  try {
    for (const pass of passes) {
      const chunks = chunkDateRange(pass.from, pass.to, MAX_CHUNK_DAYS);
      for (const chunk of chunks) {
        const dropiOrders = await fetchAllPages(base, store.api_key, store.store_url, chunk.from, chunk.to, pass.filterDateBy);
        total += dropiOrders.length;
        if (dropiOrders.length === 0) continue;

        const dbOrders = dropiOrders.map((o) => mapOrder(o, store.owner_id, todayStr, store.store_id));
        for (let i = 0; i < dbOrders.length; i += 50) {
          const batch = dbOrders.slice(i, i + 50);
          const { data: changedCount, error: upsertError } = await sb.rpc(
            "upsert_orders_from_dropi",
            { p_orders: batch },
          );
          if (upsertError) {
            console.error(`[store ${store.store_id}] upsert error:`, upsertError);
          } else {
            synced += (changedCount as number) || 0;
          }
        }
        await sleep(RATE_LIMIT_MS);
      }
    }
    return { synced, total };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[store ${store.store_id}] sync failed:`, msg);
    return { synced, total, error: msg };
  }
}

Deno.serve(async (req: Request) => {
  const CORS_HEADERS = getCorsHeaders(req);
  console.log("dropi-cron v4 — multi-tienda");
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, supabaseServiceKey);

    // ---- Auth path 1: shared secret for pg_cron ----
    const cronSecretHeader = req.headers.get("x-cron-secret");
    if (cronSecretHeader) {
      const { data: secretRow } = await sb
        .from("app_settings").select("value").eq("key", "cron_shared_secret").maybeSingle();
      if (!secretRow?.value || secretRow.value !== cronSecretHeader) {
        return new Response(JSON.stringify({ error: "Cron secret invalido" }), {
          status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
      console.log("dropi-cron: authenticated via cron shared secret");
    } else {
      // ---- Auth path 2: require admin role for authenticated callers ----
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) {
        return new Response(JSON.stringify({ error: "No autorizado" }), {
          status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
      if (authHeader !== `Bearer ${supabaseServiceKey}`) {
        const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
        const anonClient = createClient(supabaseUrl, anonKey);
        const { data: { user }, error: authError } = await anonClient.auth.getUser(
          authHeader.replace("Bearer ", ""),
        );
        if (authError || !user) {
          return new Response(JSON.stringify({ error: "Token inválido" }), {
            status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        }
        const { data: roleData } = await sb
          .from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin").maybeSingle();
        if (!roleData) {
          return new Response(
            JSON.stringify({ error: "Solo administradores pueden ejecutar el sync" }),
            { status: 403, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
          );
        }
        console.log(`dropi-cron: triggered by admin ${user.id}`);
      }
    }

    // ---- Cargar todas las tiendas ACTIVAS con credenciales ----
    const { data: configs, error: cfgErr } = await sb
      .from("store_dropi_config")
      .select("store_id, country_code, dropi_api_key, dropi_store_url, stores!inner(status)")
      .eq("stores.status", "active");

    if (cfgErr) {
      console.error("dropi-cron: error leyendo store_dropi_config:", cfgErr);
      return new Response(JSON.stringify({ error: cfgErr.message }), { status: 500 });
    }

    const activeConfigs = (configs || []).filter((c: Record<string, unknown>) => c.dropi_api_key);
    if (activeConfigs.length === 0) {
      console.warn("dropi-cron: no hay tiendas activas con dropi_api_key");
      return new Response(JSON.stringify({ stores: 0, message: "Sin tiendas configuradas" }), {
        status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // Resolver el dueño de cada tienda (uploaded_by). Preferimos el owner;
    // fallback a stores.created_by.
    const storeIds = activeConfigs.map((c: Record<string, unknown>) => c.store_id);
    const { data: owners } = await sb
      .from("store_members").select("store_id, user_id").eq("role", "owner").in("store_id", storeIds);
    const { data: storesRows } = await sb
      .from("stores").select("id, created_by").in("id", storeIds);
    const ownerByStore = new Map<string, string>();
    (owners || []).forEach((o: Record<string, string>) => {
      if (!ownerByStore.has(o.store_id)) ownerByStore.set(o.store_id, o.user_id);
    });
    (storesRows || []).forEach((s: Record<string, string>) => {
      if (!ownerByStore.has(s.id) && s.created_by) ownerByStore.set(s.id, s.created_by);
    });

    // Dos ventanas compartidas por todas las tiendas:
    //  1) CAMBIO DE ESTATUS (21d): refresca toda guía que se movió/entregó, sin
    //     importar cuándo se creó → arregla "entregadas que siguen en guía
    //     generada" y "sin movimiento marca casi todas".
    //  2) CREADO (3d): red de seguridad para órdenes nuevas que aún no
    //     registraron cambio de estatus (que aparezcan rápido en /confirmar).
    const today = new Date();
    const to = today.toISOString().split("T")[0];
    const todayStr = to;
    const dateBack = (n: number) => {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - n);
      return d.toISOString().split("T")[0];
    };
    const passes: SyncPass[] = [
      { from: dateBack(STATUS_CHANGE_DAYS_BACK), to, filterDateBy: "FECHA DE CAMBIO DE ESTATUS" },
      { from: dateBack(CREATED_DAYS_BACK), to, filterDateBy: "FECHA DE CREADO" },
    ];
    const from = passes[0].from; // para logs

    let grandSynced = 0;
    let grandTotal = 0;
    const perStore: Record<string, unknown>[] = [];

    for (const cfg of activeConfigs) {
      const storeId = String(cfg.store_id);
      const ownerId = ownerByStore.get(storeId);
      if (!ownerId) {
        console.warn(`dropi-cron: tienda ${storeId} sin dueño, se omite`);
        perStore.push({ store_id: storeId, error: "sin dueño" });
        continue;
      }
      const store: StoreSync = {
        store_id: storeId,
        country_code: String(cfg.country_code || "CO"),
        api_key: String(cfg.dropi_api_key),
        store_url: String(cfg.dropi_store_url || "https://rushmira.com/"),
        owner_id: ownerId,
      };
      console.log(`dropi-cron: sync tienda ${storeId} (${store.country_code}) — cambio_estatus ${from}→${to} + creado ${dateBack(CREATED_DAYS_BACK)}→${to}`);
      const r = await syncStore(sb, store, passes, todayStr);
      grandSynced += r.synced;
      grandTotal += r.total;
      perStore.push({ store_id: storeId, country: store.country_code, ...r });

      // Log por tienda
      await sb.from("sync_logs").insert({
        source: "dropi-cron",
        status: r.error ? "error" : "success",
        synced_count: r.synced,
        duplicates_count: 0,
        total_count: r.total,
        triggered_by: ownerId,
        store_id: storeId,
      });

      // Pausa entre tiendas: evita encadenar la ráfaga de una con la siguiente
      // y dejar el throttle de Dropi caliente para el botón manual.
      await sleep(INTER_STORE_MS);
    }

    // ---- Post-proceso GLOBAL (sobre todas las tiendas) ----
    // Restaurar estado de pedidos confirmados localmente hoy (fecha Bogotá).
    const todayDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(new Date());
    const { data: confirmedToday } = await sb
      .from("order_results").select("order_id").eq("result", "conf").eq("result_date", todayDate);
    if (confirmedToday && confirmedToday.length > 0) {
      const confirmedIds = confirmedToday.map((r: Record<string, string>) => r.order_id);
      for (let i = 0; i < confirmedIds.length; i += 50) {
        const batch = confirmedIds.slice(i, i + 50);
        await sb.from("orders").update({ estado: "PENDIENTE" })
          .in("id", batch).eq("estado", "PENDIENTE CONFIRMACION");
      }
      console.log(`dropi-cron: Restored ${confirmedIds.length} locally confirmed orders`);
    }

    // Cancelar pedidos huérfanos (global).
    try {
      const { data, error: cancelOrphanError } = await sb.rpc("cancel_orphan_pending_orders");
      if (cancelOrphanError) console.warn("cancel_orphan_pending_orders error:", cancelOrphanError.message);
      else if (((data as number) || 0) > 0) console.log(`Cancelados ${data} pedidos huérfanos`);
    } catch (err) {
      console.warn("cancel_orphan_pending_orders exception:", err);
    }

    console.log(`dropi-cron: Done — ${grandSynced} synced / ${grandTotal} from Dropi, ${activeConfigs.length} tiendas`);
    return new Response(
      JSON.stringify({ stores: activeConfigs.length, synced: grandSynced, total: grandTotal, range: `${from} → ${to}`, perStore }),
      { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("dropi-cron error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Error interno" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});

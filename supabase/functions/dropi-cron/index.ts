import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

/**
 * dropi-cron: Automated sync triggered by pg_cron every 5 minutes.
 * Syncs orders from the last 7 days to capture status changes.
 * No user auth required — uses service role key.
 */

const DROPI_API = "https://api.dropi.co";
const MAX_CHUNK_DAYS = 89;
const PAGE_SIZE = 100;
const RATE_LIMIT_MS = 500;
const SYNC_DAYS_BACK = 7; // How many days back to sync for status updates

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
      date_ini: chunkFrom,
      date_end: chunkTo,
    };
    const qs = new URLSearchParams(params).toString();
    const url = `${DROPI_API}/api/v1/orders/list?${qs}`;

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Origin: origin,
      },
    });

    if (!res.ok) {
      const txt = await res.text();
      console.error(`Dropi API error ${res.status}: ${txt}`);
      break;
    }

    const data = await res.json();
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

function mapOrder(o: Record<string, unknown>, userId: string, today: string) {
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
  const fechaConf = !isPendConf && updatedAt ? updatedAt.split("T")[0] : "";

  const novedadServ = o.novedad_servientrega ? String(o.novedad_servientrega) : "";
  const movements = (o.servientrega_movements as Array<Record<string, unknown>>) || [];
  const lastMovement = movements.length > 0 ? String(movements[movements.length - 1]?.description || movements[movements.length - 1]?.status || "") : "";
  const novedad = novedadServ || lastMovement;
  const notes = o.notes ? String(o.notes) : "";

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
    novedad: novedad || notes,
    guia,
    transportadora,
    tags,
    tienda,
    novedad_sol: novedadSol,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, supabaseServiceKey);

    // Get Dropi API key from app_settings or env
    const { data: keySetting } = await sb
      .from("app_settings")
      .select("value")
      .eq("key", "dropi_api_key")
      .maybeSingle();
    const dropiApiKey = keySetting?.value || Deno.env.get("DROPI_API_KEY") || null;

    if (!dropiApiKey) {
      console.error("dropi-cron: No API key configured");
      return new Response(JSON.stringify({ error: "No API key" }), { status: 400 });
    }

    // Get store URL
    const { data: urlSetting } = await sb
      .from("app_settings")
      .select("value")
      .eq("key", "dropi_store_url")
      .maybeSingle();
    const storeUrl = urlSetting?.value || "https://rushmira.com/";

    // Get admin user id for uploaded_by (first admin)
    const { data: adminRole } = await sb
      .from("user_roles")
      .select("user_id")
      .eq("role", "admin")
      .limit(1)
      .maybeSingle();
    const uploadedBy = adminRole?.user_id;

    if (!uploadedBy) {
      console.error("dropi-cron: No admin user found");
      return new Response(JSON.stringify({ error: "No admin" }), { status: 400 });
    }

    // Sync last N days to catch status changes
    const today = new Date();
    const fromDate = new Date(today);
    fromDate.setUTCDate(fromDate.getUTCDate() - SYNC_DAYS_BACK);

    const from = fromDate.toISOString().split("T")[0];
    const to = today.toISOString().split("T")[0];
    const todayStr = to;

    console.log(`dropi-cron: Syncing ${from} → ${to}`);

    const chunks = chunkDateRange(from, to, MAX_CHUNK_DAYS);
    let totalSynced = 0;
    let totalFromDropi = 0;

    for (const chunk of chunks) {
      const dropiOrders = await fetchAllPages(dropiApiKey, storeUrl, chunk.from, chunk.to);
      totalFromDropi += dropiOrders.length;

      if (dropiOrders.length === 0) continue;

      const dbOrders = dropiOrders.map((o) => mapOrder(o, uploadedBy, todayStr));

      for (let i = 0; i < dbOrders.length; i += 50) {
        const batch = dbOrders.slice(i, i + 50);
        const { error: upsertError, data: upsertedData } = await sb
          .from("orders")
          .upsert(batch, { onConflict: "external_id", ignoreDuplicates: false })
          .select("id");

        if (upsertError) {
          console.error("Upsert error:", upsertError);
        } else {
          totalSynced += upsertedData?.length || 0;
        }
      }

      await sleep(RATE_LIMIT_MS);
    }

    // Log the sync
    await sb.from("sync_logs").insert({
      source: "dropi-cron",
      status: "success",
      synced_count: totalSynced,
      duplicates_count: 0,
      total_count: totalFromDropi,
      triggered_by: uploadedBy,
    });

    console.log(`dropi-cron: Done — ${totalSynced} synced, ${totalFromDropi} from Dropi`);

    return new Response(
      JSON.stringify({ synced: totalSynced, total: totalFromDropi, range: `${from} → ${to}` }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("dropi-cron error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Error interno" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});

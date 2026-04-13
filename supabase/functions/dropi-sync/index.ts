import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const DROPI_API = "https://api.dropi.co";
const MAX_CHUNK_DAYS = 89;
const PAGE_SIZE = 200;
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
      from: chunkFrom,
      untill: chunkTo,
      filter_date_by: "FECHA DE CREADO",
      orderBy: "id",
      orderDirection: "desc",
    };

    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");

    const res = await fetch(`${DROPI_API}/integrations/orders/myorders?${qs}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "dropi-integration-key": apiKey,
        "Origin": origin,
      },
    });

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Dropi API [${res.status}]: ${txt}`);
    }

    const data = await res.json();
    if (!data.isSuccess) {
      throw new Error(data.message || "Dropi error");
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

/** Map a Dropi order to our DB schema */
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
  const createdAt = String(o.created_at || "");
  const fecha = createdAt ? createdAt.split("T")[0] : today;

  return {
    external_id: String(o.id || ""),
    uploaded_by: userId,
    upload_date: today,
    nombre: `${o.name || ""} ${o.surname || ""}`.trim() || "Sin nombre",
    phone: String(o.phone || "").replace(/[^0-9]/g, ""),
    ciudad: String(o.city || ""),
    departamento: String(o.state || ""),
    producto: productName || "Sin producto",
    estado: String(o.status || "PENDIENTE"),
    fecha,
    fecha_conf: "",
    dias: 0,
    dias_conf: 0,
    valor: parseFloat(String(o.total_order || "0")) || 0,
    flete: parseFloat(String(o.shipping_amount || "0")) || 0,
    costo_prod: 0,
    costo_dev: 0,
    cantidad: Math.round(cantidad),
    direccion: String(o.dir || ""),
    novedad: "",
    guia: String(o.shipping_guide || ""),
    transportadora: String(o.shipping_company || ""),
    tags: "",
    tienda: "",
    novedad_sol: false,
  };
}

Deno.serve(async (req: Request) => {
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

    // Get Dropi API key
    let dropiApiKey: string | null = null;
    const { data: keySetting } = await sb
      .from("app_settings")
      .select("value")
      .eq("key", "dropi_api_key")
      .maybeSingle();
    dropiApiKey = keySetting?.value || Deno.env.get("DROPI_API_KEY") || null;

    if (!dropiApiKey) {
      return new Response(
        JSON.stringify({ error: "Clave API de Dropi no configurada." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Get store URL for Origin header
    const { data: urlSetting } = await sb
      .from("app_settings")
      .select("value")
      .eq("key", "dropi_store_url")
      .maybeSingle();
    const storeUrl = urlSetting?.value || "https://app.dropi.co";

    // Parse body
    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { /* no body */ }

    const from = (body.from as string) || new Date().toISOString().split("T")[0];
    const untill = (body.untill as string) || from;

    // Chunk the date range
    const chunks = chunkDateRange(from, untill, MAX_CHUNK_DAYS);
    const today = new Date().toISOString().split("T")[0];

    let totalSynced = 0;
    let totalDuplicates = 0;
    let totalFromDropi = 0;

    for (const chunk of chunks) {
      // Fetch all pages for this chunk
      const dropiOrders = await fetchAllPages(dropiApiKey, storeUrl, chunk.from, chunk.to);
      totalFromDropi += dropiOrders.length;

      if (dropiOrders.length === 0) continue;

      const dbOrders = dropiOrders.map((o) => mapOrder(o, user.id, today));

      // UPSERT in batches of 50
      for (let i = 0; i < dbOrders.length; i += 50) {
        const batch = dbOrders.slice(i, i + 50);
        const { error: upsertError, data: upsertedData } = await sb
          .from("orders")
          .upsert(batch, {
            onConflict: "external_id",
            ignoreDuplicates: false,
          })
          .select("id");

        if (upsertError) {
          console.error("Upsert error:", upsertError);
        } else {
          totalSynced += upsertedData?.length || 0;
        }
      }

      await sleep(RATE_LIMIT_MS);
    }

    // Log
    await sb.from("sync_logs").insert({
      source: "dropi",
      status: "success",
      synced_count: totalSynced,
      duplicates_count: totalDuplicates,
      total_count: totalFromDropi,
      triggered_by: user.id,
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

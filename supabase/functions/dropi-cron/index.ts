import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

/**
 * dropi-cron: Automated sync triggered by pg_cron every 5 minutes.
 * Syncs orders from the last 90 days to capture status changes.
 * Auth: pg_cron sends x-cron-secret; admins send Authorization Bearer JWT.
 * v2 — force redeploy to apply shared-secret auth branch.
 */

const DROPI_API = "https://api.dropi.co";
const MAX_CHUNK_DAYS = 89;
const PAGE_SIZE = 100;
const RATE_LIMIT_MS = 500;
const SYNC_DAYS_BACK = 14;

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
      date_from: chunkFrom,
      date_to: chunkTo,
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
        "Accept": "application/json",
        "dropi-integration-key": apiKey,
        "Origin": origin,
      },
    });

    if (!res.ok) {
      const txt = await res.text();
      console.error(`Dropi API error ${res.status}: ${txt}`);
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

import { getCorsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req: Request) => {
  const CORS_HEADERS = getCorsHeaders(req);

  console.log("dropi-cron v3 — secret branch active");
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, supabaseServiceKey);

    // ---- Auth path 1: shared secret for pg_cron ----
    // The pg_cron job sends x-cron-secret matching app_settings.cron_shared_secret.
    // Needed because we can't embed the service_role key in a SQL cron command.
    const cronSecretHeader = req.headers.get("x-cron-secret");
    if (cronSecretHeader) {
      const { data: secretRow } = await sb
        .from("app_settings")
        .select("value")
        .eq("key", "cron_shared_secret")
        .maybeSingle();
      if (!secretRow?.value || secretRow.value !== cronSecretHeader) {
        return new Response(JSON.stringify({ error: "Cron secret invalido" }), {
          status: 401,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
      console.log("dropi-cron: authenticated via cron shared secret");
    } else {
      // ---- Auth path 2: require admin role for authenticated callers ----
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) {
        return new Response(JSON.stringify({ error: "No autorizado" }), {
          status: 401,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
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
            status: 401,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        }
        const { data: roleData } = await sb
          .from("user_roles")
          .select("role")
          .eq("user_id", user.id)
          .eq("role", "admin")
          .maybeSingle();
        if (!roleData) {
          return new Response(
            JSON.stringify({ error: "Solo administradores pueden ejecutar el sync" }),
            { status: 403, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
          );
        }
        console.log(`dropi-cron: triggered by admin ${user.id}`);
      }
    }

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

    // Restore estado for orders confirmed locally today. Usa fecha de Bogotá
    // para calzar con result_date que se escribe desde el cliente (el cron
    // corre en UTC y a partir de las 19:00 COL devolvía la fecha siguiente
    // dejando fuera las confirmaciones de la tarde).
    const todayDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(new Date());
    const { data: confirmedToday } = await sb
      .from("order_results")
      .select("order_id")
      .eq("result", "conf")
      .eq("result_date", todayDate);

    if (confirmedToday && confirmedToday.length > 0) {
      const confirmedIds = confirmedToday.map((r) => r.order_id);
      // Update in batches of 50
      for (let i = 0; i < confirmedIds.length; i += 50) {
        const batch = confirmedIds.slice(i, i + 50);
        await sb
          .from("orders")
          .update({ estado: "PENDIENTE" })
          .in("id", batch)
          .eq("estado", "PENDIENTE CONFIRMACION");
      }
      console.log(`dropi-cron: Restored ${confirmedIds.length} locally confirmed orders`);
    }

    // Retry order_results that failed to sync to Dropi (BUG A fix).
    // We don't call dropi-update-order from here (no JWT context); instead
    // we surface them via marking — the next time the operator opens the
    // Confirmar tab, the local result is preserved and the cron sync above
    // will eventually overwrite the Dropi-side estado on the bulk pull.
    let retried = 0;
    try {
      // BUG fix: dropi-update-order espera { externalId }, no { dbId }.
      // Hacemos JOIN implícito con orders para traer external_id junto al id.
      const { data: pendingRows } = await sb
        .from("order_results")
        .select("id, order_id, orders:order_id(external_id)")
        .in("dropi_sync_status", ["pending", "failed"])
        .eq("result", "conf")
        .gte(
          "result_date",
          new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" })
            .format(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)),
        )
        .limit(200);

      for (const row of (pendingRows || []) as unknown as Array<{ id: string; order_id: string; orders: { external_id: string | null } | { external_id: string | null }[] | null }>) {
        const ordersField = row.orders;
        const externalId = Array.isArray(ordersField)
          ? ordersField[0]?.external_id
          : ordersField?.external_id;
        if (!externalId) {
          await sb
            .from("order_results")
            .update({
              dropi_sync_status: "failed",
              result_notes: "Reintento cron omitido: pedido sin external_id",
            })
            .eq("id", row.id);
          continue;
        }
        try {
          const { data: invokeData, error: invokeErr } = await sb.functions.invoke(
            "dropi-update-order",
            { body: { externalId } },
          );
          const ok = !invokeErr && (invokeData as { ok?: boolean } | null)?.ok !== false;
          await sb
            .from("order_results")
            .update({
              dropi_sync_status: ok ? "synced" : "failed",
              result_notes: ok ? null : `Reintento cron falló: ${invokeErr?.message || "error"}`,
            })
            .eq("id", row.id);
          if (ok) retried++;
        } catch (e) {
          console.error("dropi-cron retry error:", e);
        }
      }
      if (retried > 0) console.log(`dropi-cron: retried ${retried} pending sync rows`);
    } catch (e) {
      console.error("dropi-cron retry block error:", e);
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

    // Log the sync
    await sb.from("sync_logs").insert({
      source: "dropi-cron",
      status: "success",
      synced_count: totalSynced,
      duplicates_count: retried,
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

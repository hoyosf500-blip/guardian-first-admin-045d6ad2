// dropi-health: health check por tienda. Pinga el endpoint integrations con
// result_number=1 y hoy→hoy, y escribe el estado en store_dropi_config:
//   - 'ok'       → HTTP 200 + objects.length > 0
//   - 'degraded' → HTTP 200 pero objects.length === 0 en últimos 7 días
//   - 'down'     → HTTP != 200 (api_key inválida, endpoint caído)
//
// Disparado por pg_cron cada 1h. NUNCA tira excepción: una tienda caída
// no debe frenar a las demás. Auth: x-cron-secret igual que dropi-cron.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { dropiHostFor } from "../_shared/dropiHosts.ts";

interface StoreCfg {
  store_id: string;
  country_code: string;
  dropi_api_key: string;
  dropi_store_url: string | null;
}

// Anti-throttle 2026-07-07: espaciado entre requests (antes los 2 pings de una
// tienda y las tiendas entre sí iban back-to-back — ráfaga puntual que, sumada
// al cron, provocaba el mismo "throttled" que este health pretende medir).
const SPACING_MS = 1500;
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function checkStore(cfg: StoreCfg, statusFilter: string): Promise<{ status: string; sample: number; httpStatus: number }> {
  const base = dropiHostFor(cfg.country_code || "CO");
  const today = new Date().toISOString().split("T")[0];
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];

  // 1er ping: hoy. Si HTTP error → down inmediato.
  // 2do ping (si 1ro vacío): últimos 7d para distinguir degraded de cuenta sin movimiento.
  try {
    const url1 = `${base}/integrations/orders/myorders?result_number=1&date_from=${today}&date_to=${today}&filter_date_by=FECHA DE CREADO`;
    const res1 = await fetch(url1, {
      headers: {
        "Accept": "application/json",
        "dropi-integration-key": cfg.dropi_api_key,
        ...(cfg.dropi_store_url ? { Origin: cfg.dropi_store_url } : {}),
      },
    });
    if (res1.status !== 200) {
      // 429/503 = throttle transitorio de Dropi (la cuenta EC lo hace seguido),
      // NO una cuenta caída: distinguir 'throttled' de 'down' evita pintar la
      // tienda EC en rojo 1h por un rate-limit puntual (auditoría 2026-07-07).
      const transient = res1.status === 429 || res1.status === 503 || res1.status === 502;
      return { status: transient ? "throttled" : "down", sample: 0, httpStatus: res1.status };
    }
    const body1 = await res1.json().catch(() => ({}));
    const objs1 = Array.isArray(body1?.objects) ? body1.objects : [];
    if (objs1.length > 0) {
      return { status: "ok", sample: objs1.length, httpStatus: 200 };
    }

    // Vacío hoy. Probamos 7d con el filter ganador (lo persiste dropi-cron, GAP A).
    await sleep(SPACING_MS);
    const filterParam = statusFilter ? `&filter_date_by=${encodeURIComponent(statusFilter)}` : "";
    const url7 = `${base}/integrations/orders/myorders?result_number=1&date_from=${sevenDaysAgo}&date_to=${today}${filterParam}`;
    const res7 = await fetch(url7, {
      headers: {
        "Accept": "application/json",
        "dropi-integration-key": cfg.dropi_api_key,
        ...(cfg.dropi_store_url ? { Origin: cfg.dropi_store_url } : {}),
      },
    });
    if (res7.status !== 200) {
      const transient = res7.status === 429 || res7.status === 503 || res7.status === 502;
      return { status: transient ? "throttled" : "down", sample: 0, httpStatus: res7.status };
    }
    const body7 = await res7.json().catch(() => ({}));
    const objs7 = Array.isArray(body7?.objects) ? body7.objects : [];
    return {
      status: objs7.length > 0 ? "ok" : "degraded",
      sample: objs7.length,
      httpStatus: 200,
    };
  } catch (err) {
    console.error(`dropi-health: ${cfg.store_id} threw`, err);
    return { status: "down", sample: 0, httpStatus: 0 };
  }
}

Deno.serve(async (req) => {
  const CORS = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Auth: cron secret O service-role bearer.
  const cronSecret = req.headers.get("x-cron-secret");
  const auth = req.headers.get("Authorization") || "";
  if (!cronSecret && auth !== `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!}`) {
    if (cronSecret) {
      const { data: secret } = await sb.from("app_settings").select("value").eq("key", "cron_shared_secret").maybeSingle();
      if (!secret || secret.value !== cronSecret) {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: CORS });
      }
    } else {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: CORS });
    }
  }

  const { data: configs } = await sb
    .from("store_dropi_config")
    .select("store_id, country_code, dropi_api_key, dropi_store_url, stores!inner(status)")
    .eq("stores.status", "active");

  const active = (configs || []).filter((c: Record<string, unknown>) => c.dropi_api_key) as unknown as StoreCfg[];
  const results: Array<Record<string, unknown>> = [];

  // GAP A: leer el filter_date_by ganador que persiste dropi-cron.
  const { data: filterRow } = await sb.from("app_settings")
    .select("value").eq("key", "dropi_winning_status_filter").maybeSingle();
  const STATUS_FILTER = (filterRow?.value as string) || "FECHA DE CAMBIO DE ESTATUS";

  let first = true;
  for (const cfg of active) {
    if (!first) await sleep(SPACING_MS);
    first = false;
    const r = await checkStore(cfg, STATUS_FILTER);
    await sb.from("store_dropi_config").update({
      last_health_status: r.status,
      last_health_checked_at: new Date().toISOString(),
    }).eq("store_id", cfg.store_id);
    results.push({ store_id: cfg.store_id, country: cfg.country_code, ...r });
    console.log(`dropi-health: ${cfg.store_id} → ${r.status} (HTTP ${r.httpStatus}, sample ${r.sample})`);
  }

  return new Response(JSON.stringify({ ok: true, checked: results.length, results }), {
    status: 200,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
});

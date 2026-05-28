// dropi-nightly-reconcile: corre 1x al día (3am UTC) y reconcilia TODAS las
// tiendas activas contra Dropi. Backstop diario: aunque el cron de 5min falle
// silenciosamente, máximo 24h después el estado queda alineado.
//
// Algoritmo por tienda:
//   1. Pull no-terminales de Guardian (últimos 30d)
//   2. Pull rango 30d de Dropi vía integrations
//   3. Cross-reference: diff de estado/guia/transportadora
//   4. UPDATE divergencias (idempotente vía upsert_orders_from_dropi)
//   5. Marcar huérfanos pre-backfill (external_id numérico < 5000000) como CANCELADO
//   6. INSERT log en nightly_reconcile_results
//
// Auth: x-cron-secret o service-role.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { dropiHostFor } from "../_shared/dropiHosts.ts";
import { mapDropiOrderToRow } from "../_shared/dropiOrderMapper.ts";

const PAGE_SIZE = 100;
const RATE_LIMIT_MS = 1500;
const RECONCILE_DAYS_BACK = 30;
const TERMINAL_STATES = new Set([
  "ENTREGADO", "CANCELADO", "DEVOLUCION", "DEVUELTO",
  "DEVOLUCIÓN", "ENTREGADA", "CANCELADA",
]);
const ORPHAN_THRESHOLD = 5000000; // external_ids < 5M son de backfill viejo

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchDropiRange(
  base: string,
  apiKey: string,
  origin: string,
  from: string,
  to: string,
  statusFilter: string,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let start = 0;
  const filterParam = statusFilter ? `&filter_date_by=${encodeURIComponent(statusFilter)}` : "";
  while (true) {
    const url = `${base}/integrations/orders/myorders?result_number=${PAGE_SIZE}&start=${start}&date_from=${from}&date_to=${to}${filterParam}&orderBy=id&orderDirection=desc`;
    const res = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "dropi-integration-key": apiKey,
        ...(origin ? { Origin: origin } : {}),
      },
    });
    if (!res.ok) {
      console.warn(`reconcile: HTTP ${res.status} at start=${start}`);
      break;
    }
    const data = await res.json().catch(() => ({}));
    const objs = Array.isArray(data?.objects) ? data.objects : [];
    if (objs.length === 0) break;
    out.push(...objs);
    if (objs.length < PAGE_SIZE) break;
    start += PAGE_SIZE;
    await sleep(RATE_LIMIT_MS);
  }
  return out;
}

interface GuardianRow {
  id: string;
  external_id: string | null;
  estado: string | null;
  guia: string | null;
  transportadora: string | null;
  last_movement_at: string | null;
}

interface Divergence {
  guardianId: string;
  externalId: string;
  before: { estado: string; guia: string; trans: string };
  after: { estado: string; guia: string; trans: string };
}

async function reconcileStore(
  // deno-lint-ignore no-explicit-any
  sb: any,
  storeId: string,
  countryCode: string,
  apiKey: string,
  storeUrl: string,
  ownerId: string,
  statusFilter: string,
): Promise<{ divergent: number; applied: number; orphanCancelled: number; error?: string }> {
  try {
    const today = new Date();
    const to = today.toISOString().split("T")[0];
    const fromD = new Date(today);
    fromD.setUTCDate(fromD.getUTCDate() - RECONCILE_DAYS_BACK);
    const from = fromD.toISOString().split("T")[0];

    const { data: guardianRows } = await sb
      .from("orders")
      .select("id, external_id, estado, guia, transportadora, last_movement_at")
      .eq("store_id", storeId)
      .not("external_id", "is", null)
      .gte("upload_date", from);
    const guardianNonTerminal: GuardianRow[] = (guardianRows || []).filter((o: GuardianRow) => {
      const e = (o.estado || "").toUpperCase();
      return !TERMINAL_STATES.has(e);
    });
    if (guardianNonTerminal.length === 0) {
      return { divergent: 0, applied: 0, orphanCancelled: 0 };
    }

    const base = dropiHostFor(countryCode);
    const dropiList = await fetchDropiRange(base, apiKey, storeUrl, from, to);
    const dropiMap = new Map<string, Record<string, unknown>>();
    for (const o of dropiList) {
      dropiMap.set(String(o.id), o);
    }

    const divergences: Divergence[] = [];
    const orphans: GuardianRow[] = [];
    const todayStr = to;
    const upsertBatch: Record<string, unknown>[] = [];

    for (const g of guardianNonTerminal) {
      const ext = String(g.external_id);
      const d = dropiMap.get(ext);
      if (!d) {
        // Huérfano: existe en Guardian no-terminal pero no en Dropi.
        // Solo cancelar pre-backfill (id < 5M); los nuevos podrían ser muy recientes.
        const extNum = Number(ext);
        if (Number.isFinite(extNum) && extNum < ORPHAN_THRESHOLD) {
          orphans.push(g);
        }
        continue;
      }

      const mapped = mapDropiOrderToRow(d, ownerId, todayStr, storeId);
      const newEstado = String(mapped.estado || "").toUpperCase();
      const newGuia = String(mapped.guia || "");
      const newTrans = String(mapped.transportadora || "");
      const oldEstado = (g.estado || "").toUpperCase();
      const oldGuia = g.guia || "";
      const oldTrans = g.transportadora || "";

      if (newEstado !== oldEstado || newGuia !== oldGuia || newTrans !== oldTrans) {
        divergences.push({
          guardianId: g.id,
          externalId: ext,
          before: { estado: oldEstado, guia: oldGuia, trans: oldTrans },
          after: { estado: newEstado, guia: newGuia, trans: newTrans },
        });
        upsertBatch.push(mapped);
      }
    }

    let applied = 0;
    if (upsertBatch.length > 0) {
      for (let i = 0; i < upsertBatch.length; i += 50) {
        const batch = upsertBatch.slice(i, i + 50);
        const { data: changed, error } = await sb.rpc("upsert_orders_from_dropi", { p_orders: batch });
        if (!error) applied += (changed as number) || 0;
        else console.error(`reconcile upsert error:`, error);
      }
    }

    let orphanCancelled = 0;
    if (orphans.length > 0) {
      const ids = orphans.map(o => o.id);
      for (let i = 0; i < ids.length; i += 50) {
        const batch = ids.slice(i, i + 50);
        const { error } = await sb.from("orders").update({ estado: "CANCELADO" }).in("id", batch);
        if (!error) orphanCancelled += batch.length;
      }
    }

    return { divergent: divergences.length, applied, orphanCancelled };
  } catch (err) {
    return {
      divergent: 0, applied: 0, orphanCancelled: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

Deno.serve(async (req) => {
  const CORS = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Auth
  const cronSecret = req.headers.get("x-cron-secret");
  if (cronSecret) {
    const { data: secret } = await sb.from("app_settings").select("value").eq("key", "cron_shared_secret").maybeSingle();
    if (!secret || secret.value !== cronSecret) {
      return new Response(JSON.stringify({ error: "bad cron secret" }), { status: 401, headers: CORS });
    }
  } else {
    const auth = req.headers.get("Authorization") || "";
    if (auth !== `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!}`) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: CORS });
    }
  }

  const { data: configs } = await sb
    .from("store_dropi_config")
    .select("store_id, country_code, dropi_api_key, dropi_store_url, stores!inner(status)")
    .eq("stores.status", "active");
  const active = (configs || []).filter((c: Record<string, unknown>) => c.dropi_api_key);

  const ownersRes = await sb.from("store_members").select("store_id, user_id").eq("role", "owner");
  const ownerByStore = new Map<string, string>();
  (ownersRes.data || []).forEach((o: { store_id: string; user_id: string }) => {
    if (!ownerByStore.has(o.store_id)) ownerByStore.set(o.store_id, o.user_id);
  });

  const summary: Array<Record<string, unknown>> = [];
  for (const cfg of active as unknown as Array<{ store_id: string; country_code: string; dropi_api_key: string; dropi_store_url: string | null }>) {
    const ownerId = ownerByStore.get(cfg.store_id);
    if (!ownerId) continue;
    const r = await reconcileStore(
      sb, cfg.store_id, cfg.country_code || "CO",
      cfg.dropi_api_key, cfg.dropi_store_url || "",
      ownerId,
    );
    await sb.from("nightly_reconcile_results").insert({
      store_id: cfg.store_id,
      divergent_count: r.divergent,
      applied_count: r.applied,
      orphan_cancelled: r.orphanCancelled,
      error_message: r.error || null,
    });
    summary.push({ store_id: cfg.store_id, ...r });
    console.log(`reconcile ${cfg.store_id}: divergent=${r.divergent} applied=${r.applied} orphans=${r.orphanCancelled}`);
  }

  return new Response(JSON.stringify({ ok: true, summary }), {
    status: 200,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
});

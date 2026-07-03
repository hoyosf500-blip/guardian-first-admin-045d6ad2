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
// FIX 2026-07-02 (fantasmas de pedidos BORRADOS en Dropi): los huérfanos con id
// >= 5M antes se ignoraban ("podrían ser muy recientes"), pero Dropi permite
// ELIMINAR pedidos y esos quedan para siempre no-terminales en Guardian (mayo EC:
// 9 fantasmas, 4 de ellos "pendientes" que ensuciaban el embudo y la cola de
// Confirmar). Ahora se verifica su EXISTENCIA real una por una con el GET de
// detalle de integraciones y solo se cancela ante el "no existe" EXPLÍCITO.
// 2026-07-03: 20→40. Junio EC dejó 42 fantasmas de una (LucidBot duplica → los
// borran en Dropi a mano); con cap 20 tardaban 3 noches en limpiarse. A las 3am
// UTC la cuenta EC está tranquila y el check tiene backoff — 40 es seguro.
const EXISTENCE_CHECK_MAX = 40;          // cap por tienda por corrida (rate-limit friendly)
const EXISTENCE_CHECK_MIN_AGE_MS = 48 * 3600 * 1000; // no tocar pedidos de <48h (lag de sync)

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

/** Consulta el detalle de UN pedido por integraciones para saber si sigue
 *  existiendo en Dropi. Devuelve:
 *  - 'exists'  → Dropi devolvió el pedido (el miss del rango fue por filtro/fecha)
 *  - 'deleted' → Dropi dijo explícitamente que no existe (fue eliminado)
 *  - 'unknown' → error de red/401/429/respuesta rara → NO tocar (fail-safe) */
async function checkOrderExistence(
  base: string,
  apiKey: string,
  origin: string,
  externalId: string,
): Promise<"exists" | "deleted" | "unknown"> {
  try {
    const res = await fetch(
      `${base}/integrations/orders/myorders/${encodeURIComponent(externalId)}`,
      {
        headers: {
          "Accept": "application/json",
          "dropi-integration-key": apiKey,
          ...(origin ? { Origin: origin } : {}),
        },
      },
    );
    const raw = await res.text();
    let body: Record<string, unknown> = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { return "unknown"; }
    const obj = body.objects as Record<string, unknown> | undefined;
    if (res.ok && body.isSuccess !== false && obj && obj.id != null) return "exists";
    const msg = String(body.message || "");
    // Mismo mensaje verificado en vivo (2026-07-02): "Esta guia no existe en nuestro sistema"
    if (body.isSuccess === false && /no existe|not found/i.test(msg)) return "deleted";
    return "unknown";
  } catch {
    return "unknown";
  }
}

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
  created_at: string | null;
}

interface Divergence {
  guardianId: string;
  externalId: string;
  before: { estado: string; guia: string; trans: string };
  after: { estado: string; guia: string; trans: string };
}

async function reconcileStore(
  // deno-lint-ignore no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  storeId: string,
  countryCode: string,
  apiKey: string,
  storeUrl: string,
  ownerId: string,
  statusFilter: string,
): Promise<{ divergent: number; applied: number; orphanCancelled: number; deletedCancelled: number; error?: string }> {
  try {
    const today = new Date();
    const to = today.toISOString().split("T")[0];
    const fromD = new Date(today);
    fromD.setUTCDate(fromD.getUTCDate() - RECONCILE_DAYS_BACK);
    const from = fromD.toISOString().split("T")[0];

    const { data: guardianRows } = await sb
      .from("orders")
      .select("id, external_id, estado, guia, transportadora, last_movement_at, created_at")
      .eq("store_id", storeId)
      .not("external_id", "is", null)
      .gte("upload_date", from);
    const guardianNonTerminal: GuardianRow[] = (guardianRows || []).filter((o: GuardianRow) => {
      const e = (o.estado || "").toUpperCase();
      return !TERMINAL_STATES.has(e);
    });
    if (guardianNonTerminal.length === 0) {
      return { divergent: 0, applied: 0, orphanCancelled: 0, deletedCancelled: 0 };
    }

    const base = dropiHostFor(countryCode);
    const dropiList = await fetchDropiRange(base, apiKey, storeUrl, from, to, statusFilter);
    const dropiMap = new Map<string, Record<string, unknown>>();
    for (const o of dropiList) {
      dropiMap.set(String(o.id), o);
    }

    const divergences: Divergence[] = [];
    const orphans: GuardianRow[] = [];
    const existenceCandidates: GuardianRow[] = [];
    const todayStr = to;
    const upsertBatch: Record<string, unknown>[] = [];

    for (const g of guardianNonTerminal) {
      const ext = String(g.external_id);
      const d = dropiMap.get(ext);
      if (!d) {
        // Huérfano: existe en Guardian no-terminal pero no en el pull por rango
        // de Dropi. Pre-backfill (id < 5M) → cancelar directo (comportamiento
        // original). Post-backfill (id >= 5M) → candidato a verificación de
        // existencia uno-por-uno (puede haber sido ELIMINADO en Dropi, o solo
        // no entrar al rango por el filter_date_by — el GET de detalle decide).
        const extNum = Number(ext);
        if (Number.isFinite(extNum) && extNum < ORPHAN_THRESHOLD) {
          orphans.push(g);
        } else if (Number.isFinite(extNum)) {
          const ageMs = g.created_at ? Date.now() - new Date(g.created_at).getTime() : 0;
          if (ageMs >= EXISTENCE_CHECK_MIN_AGE_MS) existenceCandidates.push(g);
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

    // Verificación de existencia de huérfanos post-backfill (borrados en Dropi).
    // Cap por corrida + rate-limit; solo cancela ante el "no existe" EXPLÍCITO —
    // 'exists' y 'unknown' se dejan intactos (el próximo nightly reintenta).
    let deletedCancelled = 0;
    const toCheck = existenceCandidates.slice(0, EXISTENCE_CHECK_MAX);
    for (const g of toCheck) {
      const verdict = await checkOrderExistence(base, apiKey, storeUrl, String(g.external_id));
      if (verdict === "deleted") {
        const { error } = await sb.from("orders").update({ estado: "CANCELADO" }).eq("id", g.id);
        if (!error) {
          deletedCancelled++;
          console.log(`reconcile ${storeId}: ${g.external_id} ELIMINADO en Dropi (era ${g.estado}) → CANCELADO local`);
        }
      }
      await sleep(RATE_LIMIT_MS);
    }
    if (existenceCandidates.length > toCheck.length) {
      console.log(`reconcile ${storeId}: ${existenceCandidates.length - toCheck.length} huérfanos post-backfill quedan para la próxima corrida (cap ${EXISTENCE_CHECK_MAX})`);
    }

    return { divergent: divergences.length, applied, orphanCancelled, deletedCancelled };
  } catch (err) {
    return {
      divergent: 0, applied: 0, orphanCancelled: 0, deletedCancelled: 0,
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

  // GAP A: leer el filter_date_by ganador que persiste dropi-cron.
  const { data: filterRow } = await sb.from("app_settings")
    .select("value").eq("key", "dropi_winning_status_filter").maybeSingle();
  const STATUS_FILTER = (filterRow?.value as string) || "FECHA DE CAMBIO DE ESTATUS";

  const summary: Array<Record<string, unknown>> = [];
  for (const cfg of active as unknown as Array<{ store_id: string; country_code: string; dropi_api_key: string; dropi_store_url: string | null }>) {
    const ownerId = ownerByStore.get(cfg.store_id);
    if (!ownerId) continue;
    const r = await reconcileStore(
      sb, cfg.store_id, cfg.country_code || "CO",
      cfg.dropi_api_key, cfg.dropi_store_url || "",
      ownerId, STATUS_FILTER,
    );
    await sb.from("nightly_reconcile_results").insert({
      store_id: cfg.store_id,
      divergent_count: r.divergent,
      applied_count: r.applied,
      // orphan_cancelled agrega ambos tipos de limpieza (pre-backfill + borrados
      // en Dropi) para no cambiar el esquema de la tabla; el desglose va en logs.
      orphan_cancelled: r.orphanCancelled + r.deletedCancelled,
      error_message: r.error || null,
    });
    summary.push({ store_id: cfg.store_id, ...r });
    console.log(`reconcile ${cfg.store_id}: divergent=${r.divergent} applied=${r.applied} orphans=${r.orphanCancelled} deletedInDropi=${r.deletedCancelled}`);
  }

  return new Response(JSON.stringify({ ok: true, summary }), {
    status: 200,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
});

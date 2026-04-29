// dropi-wallet-sync — sincroniza el Historial de Cartera de Dropi.
//
// Endpoint Dropi: GET https://api.dropi.co/api/historywallet
// Auth Dropi:     header `x-authorization: Bearer <dropi_session_token>`
//                 (NO la integration-key. Confirmado en discovery 2026-04-29:
//                  /integrations/wallet* devuelve 404. La billetera vive en
//                  el namespace /api/* con JWT de sesión de usuario.)
//
// Patrón calcado de dropi-sync:
//   - Auth Supabase del caller (Authorization Bearer)
//   - Lee `dropi_session_token` de app_settings, decodifica `sub` (user_id Dropi)
//   - Pagina con start/result_number=100, rate limit 500ms
//   - Chunkea fechas de a 30 días (la billetera puede tener mucho más volumen
//     que orders, chunks chicos para no timeoutear)
//   - RPC idempotente upsert_wallet_movements (evita realtime spam)
//   - Log a sync_logs con source='dropi-wallet-sync'
//
// Body (todos opcionales):
//   { from: "YYYY-MM-DD",  // default: hoy - 30 días
//     untill: "YYYY-MM-DD", // default: hoy
//     dryRun: boolean,      // si true, NO escribe; solo trae y devuelve count
//     limit: number }       // si > 0, corta tras N movimientos (test)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";

const DROPI_API = "https://api.dropi.co";
const WALLET_PATH = "/api/historywallet";
const MAX_CHUNK_DAYS = 30;
const PAGE_SIZE = 100;
const RATE_LIMIT_MS = 500;

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

/**
 * Mapea el `código` textual de Dropi a una categoría interna estable.
 * Las categorías son las que la UI agrupa para los KPIs (entró/salió/neto).
 */
function mapCategoria(codigo: string | undefined | null): string {
  const c = (codigo || "").toUpperCase().trim();
  if (!c) return "otro";
  if (c.includes("FLETE INICIAL"))                                 return "flete_inicial";
  if (c.includes("NUEVA ORDEN"))                                   return "orden_sin_recaudo";
  if (c.includes("CAMBIO DE ESTATUS"))                             return "cobro_entrega";
  if (c.includes("GANANCIA") && c.includes("DROPSHIPPER"))         return "ganancia_dropshipper";
  if (c.includes("GANANCIA") && c.includes("PROVEEDOR"))           return "ganancia_proveedor";
  if (c.includes("DEVOLUCION DE FLETE ORDEN ENTREGADA"))           return "reembolso_flete";
  if (c.includes("DEVOLUCION DE FLETE") && c.includes("NO EFECTIVA")) return "costo_devolucion";
  if (c.includes("COMISION DE REFERIDOS"))                         return "comision_referidos";
  if (c.includes("RETIRO"))                                        return "retiro";
  if (c.includes("DEPOSITO") || c.includes("DEPÓSITO") || c.includes("RECARGA")) return "deposito";
  return "otro";
}

/** Extrae el id de orden del final de la descripción ("...: 71014957"). */
function extractOrderId(desc: string | undefined | null): string | null {
  if (!desc) return null;
  const match = String(desc).match(/(\d{6,})\s*$/);
  return match ? match[1] : null;
}

/**
 * Mapea un movimiento de Dropi al shape que espera la RPC upsert_wallet_movements.
 * Defensivo con nombres de campos: probamos varios alias en español/inglés
 * porque el shape exacto del JSON aún no está confirmado (lo veremos cuando
 * ejecutemos el primer dryRun y el sample del raw venga de vuelta).
 */
function mapMovement(m: Record<string, unknown>, syncedBy: string) {
  const id = Number(m.id ?? m.transaction_id ?? m.transactionId);

  const fechaRaw = String(
    m.created_at ?? m.fecha ?? m.date ?? m.created ?? new Date().toISOString(),
  );

  const tipo = String(m.type ?? m.tipo ?? "").toUpperCase().trim() || "SALIDA";

  const codigo = String(
    m.identification_code ?? m.code ?? m.tipo_codigo ?? m.code_name ?? "",
  ).trim();

  const monto = Number(m.amount ?? m.monto ?? m.value ?? 0);
  const montoAbs = Math.abs(monto);

  const montoPrevio = m.previous_amount !== undefined
    ? Number(m.previous_amount)
    : (m.monto_previo !== undefined ? Number(m.monto_previo) : null);

  const saldoDespues = montoPrevio !== null
    ? (tipo === "ENTRADA" ? montoPrevio + montoAbs : montoPrevio - montoAbs)
    : null;

  const descripcion = String(m.description ?? m.descripcion ?? "");

  const cuenta = m.account !== undefined
    ? String(m.account)
    : (m.cuenta !== undefined ? String(m.cuenta) : null);

  const conceptoRetiro = m.withdrawal_concept !== undefined
    ? String(m.withdrawal_concept)
    : (m.concepto_retiro !== undefined ? String(m.concepto_retiro) : null);

  return {
    dropi_transaction_id: id,
    fecha: fechaRaw,
    tipo,
    codigo: codigo || null,
    categoria: mapCategoria(codigo),
    monto: montoAbs,
    monto_previo: montoPrevio,
    saldo_despues: saldoDespues,
    descripcion: descripcion || null,
    cuenta,
    concepto_retiro: conceptoRetiro,
    related_order_id: extractOrderId(descripcion),
    raw: m,
    synced_by: syncedBy,
  };
}

/** Trae una página de movimientos. */
async function fetchPage(
  sessionToken: string,
  dropiUserId: number,
  from: string,
  to: string,
  start: number,
  pageSize: number,
): Promise<{ items: Record<string, unknown>[]; raw: unknown }> {
  const params = new URLSearchParams({
    orderBy: "id",
    orderDirection: "desc",
    result_number: String(pageSize),
    start: String(start),
    textToSearch: "",
    type: "null",
    id: "null",
    identification_code: "null",
    user_id: String(dropiUserId),
    from,
    until: to,
    wallet_id: "0",
  });

  const res = await fetch(`${DROPI_API}${WALLET_PATH}?${params.toString()}`, {
    method: "GET",
    headers: {
      "Accept": "application/json, text/plain, */*",
      "x-authorization": `Bearer ${sessionToken}`,
      "Origin": "https://app.dropi.co",
      "Referer": "https://app.dropi.co/",
    },
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Dropi historywallet [${res.status}]: ${txt.slice(0, 300)}`);
  }

  const data = await res.json();
  // Defensivo con shape de respuesta — Dropi suele usar { isSuccess, objects }
  // pero también vimos { data, items, transactions } en otros endpoints. Si
  // ninguno matchea, asumimos que la respuesta ES un array directo.
  const items = Array.isArray(data)
    ? data
    : Array.isArray((data as Record<string, unknown>).objects)
      ? (data as { objects: Record<string, unknown>[] }).objects
      : Array.isArray((data as Record<string, unknown>).data)
        ? (data as { data: Record<string, unknown>[] }).data
        : Array.isArray((data as Record<string, unknown>).items)
          ? (data as { items: Record<string, unknown>[] }).items
          : Array.isArray((data as Record<string, unknown>).transactions)
            ? (data as { transactions: Record<string, unknown>[] }).transactions
            : [];

  return { items, raw: data };
}

Deno.serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // 1. Auth Supabase del caller
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "No autorizado" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const sbUrl = Deno.env.get("SUPABASE_URL")!;
    const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
    const sb = createClient(sbUrl, sbKey);
    const anonClient = createClient(sbUrl, anonKey);
    const { data: { user }, error: authError } = await anonClient.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Token inválido" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2. Leer dropi_session_token de app_settings
    const { data: tokenRow } = await sb
      .from("app_settings")
      .select("value")
      .eq("key", "dropi_session_token")
      .maybeSingle();
    const sessionToken = tokenRow?.value || "";
    if (!sessionToken) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "Token de sesión Dropi no configurado. Ve a Admin → Token sesión Dropi.",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 3. Decodificar JWT — extraer sub (user_id Dropi) y exp
    let dropiUserId: number;
    let exp = 0;
    try {
      const parts = sessionToken.split(".");
      const payload = JSON.parse(atob(parts[1]));
      dropiUserId = Number(payload.sub);
      exp = Number(payload.exp || 0);
      if (!dropiUserId) throw new Error("sin sub");
    } catch {
      return new Response(
        JSON.stringify({ ok: false, error: "Token de sesión Dropi inválido — no se pudo decodificar." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Aviso temprano si está expirado (sin gastar la llamada)
    if (exp > 0 && exp * 1000 < Date.now()) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "Token de sesión Dropi expirado. Refrescá Admin → Token sesión Dropi.",
          expired: true,
        }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 4. Body opcional
    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { /* sin body */ }

    const today = new Date();
    const defaultFrom = new Date();
    defaultFrom.setUTCDate(defaultFrom.getUTCDate() - 30);
    const fromDate = String(body.from || defaultFrom.toISOString().split("T")[0]);
    const toDate = String(body.untill || body.to || today.toISOString().split("T")[0]);
    const dryRun = Boolean(body.dryRun);
    const limit = Number(body.limit || 0);

    const chunks = chunkDateRange(fromDate, toDate, MAX_CHUNK_DAYS);

    let totalFromDropi = 0;
    let totalSynced = 0;
    let firstSampleKeys: string[] | null = null;
    let firstSampleRecord: Record<string, unknown> | null = null;

    // 5. Paginar y upsert
    outer: for (const chunk of chunks) {
      let start = 0;
      while (true) {
        const { items, raw } = await fetchPage(
          sessionToken, dropiUserId, chunk.from, chunk.to, start, PAGE_SIZE,
        );

        // Capturar shape de respuesta para diagnostico (solo primera vez)
        if (firstSampleKeys === null && raw && typeof raw === "object" && !Array.isArray(raw)) {
          firstSampleKeys = Object.keys(raw as Record<string, unknown>).slice(0, 12);
        }
        if (firstSampleRecord === null && items.length > 0) {
          firstSampleRecord = items[0];
        }

        if (items.length === 0) break;

        const mapped = items
          .map((m) => mapMovement(m, user.id))
          .filter((m) => Number.isFinite(m.dropi_transaction_id) && m.dropi_transaction_id > 0);

        totalFromDropi += mapped.length;

        if (!dryRun && mapped.length > 0) {
          for (let i = 0; i < mapped.length; i += 50) {
            const batch = mapped.slice(i, i + 50);
            const { data: changedCount, error: upsertError } = await sb.rpc(
              "upsert_wallet_movements",
              { p_movements: batch },
            );
            if (upsertError) {
              console.error("upsert_wallet_movements error:", upsertError);
            } else {
              totalSynced += (changedCount as number) || 0;
            }
          }
        }

        if (limit > 0 && totalFromDropi >= limit) break outer;
        if (items.length < PAGE_SIZE) break;
        start += PAGE_SIZE;
        await sleep(RATE_LIMIT_MS);
      }
      await sleep(RATE_LIMIT_MS);
    }

    // 6. Log a sync_logs (mismo patrón que dropi-sync)
    if (!dryRun) {
      await sb.from("sync_logs").insert({
        source: "dropi-wallet-sync",
        status: "success",
        synced_count: totalSynced,
        duplicates_count: 0,
        total_count: totalFromDropi,
        triggered_by: user.id,
      });
    }

    return new Response(
      JSON.stringify({
        ok: true,
        synced: totalSynced,
        total: totalFromDropi,
        chunks: chunks.length,
        from: fromDate,
        until: toDate,
        dropi_user_id: dropiUserId,
        // Diagnóstico para confirmar shape en primer dryRun
        sample_response_keys: firstSampleKeys,
        sample_movement_keys: firstSampleRecord ? Object.keys(firstSampleRecord).slice(0, 30) : null,
        dry_run: dryRun,
        message: dryRun
          ? `DRY RUN — ${totalFromDropi} movimientos encontrados. Revisar sample_movement_keys antes de sync real.`
          : `${totalSynced} movimientos sincronizados de ${totalFromDropi} traídos en ${chunks.length} chunk${chunks.length > 1 ? "s" : ""}`,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("dropi-wallet-sync error:", msg);

    const expired = msg.includes("[401]");
    return new Response(
      JSON.stringify({
        ok: false,
        error: msg,
        expired,
        ...(expired ? { hint: "Refrescá dropi_session_token en Admin → Token sesión Dropi." } : {}),
      }),
      {
        status: expired ? 401 : 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});

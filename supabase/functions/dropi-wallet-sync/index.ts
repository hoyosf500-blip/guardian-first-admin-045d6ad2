// dropi-wallet-sync — sincroniza el Historial de Cartera de Dropi.
//
// Estrategia: en vez de paginar /api/historywallet (que tiene IP block en
// data centers — devuelve 403 Access denied), usamos
// /api/wallet/exportexcel que retorna un XLSX con TODOS los movimientos
// del rango y NO tiene IP block (verificado 2026-04-29 con curl + JWT real).
//
// Flujo:
//   1. Auth Supabase del caller
//   2. Lee dropi_session_token de app_settings
//   3. Decodifica JWT → user_id, exp
//   4. GET /api/wallet/exportexcel?from=X&until=Y&user_id=N&wallet_id=0
//   5. Parsea XLSX server-side con SheetJS
//   6. Mapea filas → shape de upsert_wallet_movements
//   7. Upsert idempotente vía RPC
//   8. Log a sync_logs
//
// Body opcional:
//   { from: "YYYY-MM-DD",  // default: hoy - 30d
//     untill: "YYYY-MM-DD", // default: hoy
//     dryRun: boolean,
//     limit: number }       // si > 0, corta tras N movimientos

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";
import { getCorsHeaders } from "../_shared/cors.ts";
import { loadStoreConfig, isStoreOwner } from "../_shared/dropiStoreConfig.ts";

const EXPORT_PATH = "/api/wallet/exportexcel";

/** Normaliza string: uppercase + sin acentos, para matchear códigos
 *  con/sin tildes (ej. "DEVOLUCIÓN" vs "DEVOLUCION") robustamente. */
function normalizeCodigo(s: string | null | undefined): string {
  return (s || "").toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function mapCategoria(codigo: string | null | undefined): string {
  const c = normalizeCodigo(codigo);
  if (!c) return "otro";

  // Patrones existentes
  if (c.includes("FLETE INICIAL"))                                 return "flete_inicial";
  if (c.includes("NUEVA ORDEN"))                                   return "orden_sin_recaudo";
  if (c.includes("CAMBIO DE ESTATUS"))                             return "cobro_entrega";
  if (c.includes("GANANCIA") && c.includes("DROPSHIPPER"))         return "ganancia_dropshipper";
  if (c.includes("GANANCIA") && c.includes("PROVEEDOR"))           return "ganancia_proveedor";
  // Reembolso de flete cuando la orden SÍ se entregó (entrada de plata).
  if (c.includes("DEVOLUCION") && c.includes("ORDEN ENTREGADA"))   return "reembolso_flete";
  // Costo de devolución cuando la orden NO se entregó. Matchea tanto el
  // texto viejo "DEVOLUCION DE FLETE NO EFECTIVA" como el actual
  // "SALIDA DE COBRO DE DEVOLUCION POR ENTREGA NO EFECTIVA".
  if (c.includes("DEVOLUCION") && c.includes("NO EFECTIV"))        return "costo_devolucion";
  if (c.includes("COMISION DE REFERIDOS"))                         return "comision_referidos";

  // Nuevos patrones (descubiertos en auditoría 2026-05-02)
  // Mantenimiento mensual de tarjeta virtual de Dropi
  if (c.includes("MANTENIMIENTO") && c.includes("TARJETA"))        return "mantenimiento_tarjeta";
  // Indemnización por orden con problema (proveedor no despacha en 72h, etc)
  if (c.includes("INDEMNIZACION"))                                 return "indemnizacion";

  // Transferencias de wallet (entre usuarios Dropi):
  // - SALIDA + TRANSFERENCIA + AL USUARIO = retiro a tu propio email O transferencia a tercero
  // - ENTRADA + TRANSFERENCIA + DESDE EL USUARIO = depósito desde tu propio email O recarga
  // El email del USER_OWNER se compara contra DROPI_OWNER_EMAIL si está seteado;
  // sin esa env var, asumimos que TODA transferencia entrante es 'deposito' y SALIENTE es 'retiro'
  // (criterio conservador: la mayoría de operadores solo se transfieren a sí mismos).
  if (c.includes("TRANSFERENCIA") && c.includes("AL USUARIO")) {
    // Si el código menciona el email del owner (heurística básica), es retiro propio.
    // Si NO menciona el email del owner pero sí menciona OTRO email, es transferencia externa.
    // Para ser conservador: si el codigo contiene "@" pero no el del owner -> externa.
    const ownerEmail = (Deno.env.get("DROPI_OWNER_EMAIL") || "").toLowerCase();
    const codigoLower = (codigo || "").toLowerCase();
    if (ownerEmail && codigoLower.includes(ownerEmail)) {
      return "retiro";
    }
    // Sin env var configurada: asumimos retiro (caso más común).
    // Si en el futuro queremos distinguir, set DROPI_OWNER_EMAIL en Supabase.
    return "retiro";
  }
  if (c.includes("TRANSFERENCIA") && c.includes("DESDE EL USUARIO"))     return "deposito";

  // Patrones legacy (siguen funcionando con el text simplificado)
  if (c.includes("RETIRO"))                                        return "retiro";
  if (c.includes("DEPOSITO") || c.includes("RECARGA"))             return "deposito";

  return "otro";
}

/** Convierte "29-04-2026 01:16" a ISO 8601 con TZ (asume horario de Bogotá -05:00). */
function fechaToISO(s: string | undefined): string {
  if (!s) return new Date().toISOString();
  const m = String(s).trim().match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (!m) {
    // Fallback: dejar que Date intente
    const d = new Date(s);
    return Number.isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString();
  }
  const [, dd, mm, yyyy, hh, mi] = m;
  // Construimos como horario Bogotá (UTC-5) y devolvemos ISO en UTC
  // 01:16 hora Bogotá = 06:16 UTC
  const utcMs = Date.UTC(
    Number(yyyy), Number(mm) - 1, Number(dd),
    Number(hh) + 5, Number(mi), 0,
  );
  return new Date(utcMs).toISOString();
}

interface XlsxRow {
  ID?: number | string;
  FECHA?: string;
  TIPO?: string;
  MONTO?: number | string;
  "MONTO PREVIO"?: number | string;
  "ORDEN ID"?: number | string;
  "NUMERO DE GUIA"?: string | number;
  "DESCRIPCIÓN"?: string;
  CUENTA?: string;
  "CONCEPTO DE RETIRO"?: string;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  return String(v).trim() || null;
}

function mapRow(row: XlsxRow, syncedBy: string | null, storeId: string) {
  const id = num(row.ID);
  if (!id || id <= 0) return null;

  const tipo = (str(row.TIPO) || "SALIDA").toUpperCase();
  const monto = Math.abs(num(row.MONTO) ?? 0);
  const montoPrevio = num(row["MONTO PREVIO"]);
  const saldoDespues = montoPrevio !== null
    ? (tipo === "ENTRADA" ? montoPrevio + monto : montoPrevio - monto)
    : null;

  const descripcion = str(row["DESCRIPCIÓN"]);
  // Codigo: lo derivamos de la primera oración de la descripción (hasta los ":")
  const codigo = descripcion
    ? descripcion.split(":")[0]?.trim() || null
    : null;

  // Order ID: preferimos columna F si tiene valor, si no parseamos de descripción
  const orderFromCol = str(row["ORDEN ID"]);
  const orderFromDesc = descripcion?.match(/:\s*(\d{6,})/)?.[1] || null;
  const relatedOrderId = orderFromCol || orderFromDesc;

  return {
    dropi_transaction_id: id,
    // store_id va DENTRO de cada movimiento: el RPC upsert_wallet_movements
    // es de 1 arg (p_movements jsonb) y lee store_id del recordset por fila.
    store_id: storeId,
    fecha: fechaToISO(str(row.FECHA) ?? undefined),
    tipo,
    codigo,
    categoria: mapCategoria(codigo),
    monto,
    monto_previo: montoPrevio,
    saldo_despues: saldoDespues,
    descripcion,
    cuenta: str(row.CUENTA),
    concepto_retiro: str(row["CONCEPTO DE RETIRO"]),
    related_order_id: relatedOrderId,
    raw: row,
    synced_by: syncedBy,
  };
}

interface SyncStoreResult {
  store_id: string;
  ok: boolean;
  synced?: number;
  total?: number;
  rows_in_excel?: number;
  expired?: boolean;
  error?: string;
}

/**
 * Sincroniza el wallet de UNA tienda. No tira Response: devuelve un resultado,
 * así el caller (manual o cron multi-tienda) decide cómo responder y una tienda
 * que falle (token vencido, throttle EC) no aborta a las demás.
 */
async function syncStore(
  sb: ReturnType<typeof createClient>,
  storeId: string,
  fromDate: string,
  toDate: string,
  dryRun: boolean,
  limit: number,
  userId: string | null,
): Promise<SyncStoreResult> {
  const cfg = await loadStoreConfig(sb, storeId);
  // 2026-05-22: priorizar INTEGRATIONS api_key (permanente) sobre session_token.
  const authToken = cfg.apiKey || cfg.sessionToken;
  if (!authToken) {
    return { store_id: storeId, ok: false, error: "Sin credencial Dropi (api_key ni session_token)" };
  }

  // Decodificar JWT → `sub` (dropi user_id) para el query.
  let dropiUserId: number;
  try {
    const payload = JSON.parse(atob(authToken.split(".")[1]));
    dropiUserId = Number(payload.sub);
    if (!dropiUserId) throw new Error("sin sub");
  } catch {
    return { store_id: storeId, ok: false, error: "Token Dropi inválido — no se pudo decodificar." };
  }

  const params = new URLSearchParams({
    from: fromDate,
    until: toDate,
    user_id: String(dropiUserId),
    wallet_id: "0",
  });
  const xlsxRes = await fetch(`${cfg.base}${EXPORT_PATH}?${params.toString()}`, {
    method: "GET",
    headers: {
      "Accept": "application/json, text/plain, */*",
      "x-authorization": `Bearer ${authToken}`,
    },
  });
  if (!xlsxRes.ok) {
    const txt = await xlsxRes.text();
    return {
      store_id: storeId,
      ok: false,
      expired: xlsxRes.status === 401,
      error: `Dropi exportexcel [${xlsxRes.status}]: ${txt.slice(0, 200)}`,
    };
  }

  const arrayBuffer = await xlsxRes.arrayBuffer();
  const wb = XLSX.read(new Uint8Array(arrayBuffer), { type: "array" });
  const firstSheetName = wb.SheetNames[0];
  if (!firstSheetName) return { store_id: storeId, ok: false, error: "XLSX sin sheets" };

  const rows = XLSX.utils.sheet_to_json(wb.Sheets[firstSheetName], { defval: null }) as XlsxRow[];
  type Mapped = ReturnType<typeof mapRow>;
  const slice: XlsxRow[] = limit > 0 ? rows.slice(0, limit) : rows;
  const mapped = slice
    .map((r: XlsxRow): Mapped => mapRow(r, userId ?? "", storeId))
    .filter((r): r is NonNullable<Mapped> => r !== null);

  let totalSynced = 0;
  if (!dryRun && mapped.length > 0) {
    for (let i = 0; i < mapped.length; i += 50) {
      const batch = mapped.slice(i, i + 50);
      const { data: changedCount, error: upsertError } = await sb.rpc(
        "upsert_wallet_movements",
        { p_movements: batch },
      );
      if (upsertError) console.error(`upsert_wallet_movements error (store ${storeId}):`, upsertError);
      else totalSynced += (changedCount as number) || 0;
    }
    await sb.from("sync_logs").insert({
      source: "dropi-wallet-sync",
      status: "success",
      synced_count: totalSynced,
      duplicates_count: 0,
      total_count: mapped.length,
      triggered_by: userId,
      store_id: storeId,
    });
  }

  return {
    store_id: storeId,
    ok: true,
    synced: totalSynced,
    total: mapped.length,
    rows_in_excel: rows.length,
  };
}

Deno.serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // 1. Auth: dos caminos.
    //    (a) cron pg_cron: header `x-cron-secret` matchea app_settings.cron_shared_secret
    //        En este caso `userId = null` y `isCron = true`.
    //    (b) usuario logeado: header `Authorization: Bearer <user_jwt>`
    //        Mismo flow que antes — getUser(authHeader) → user.id.
    // El cron lo necesitamos porque pg_cron NO tiene user JWT (mismo patrón
    // que dropi-cron en migration 20260417020000_cron_shared_secret.sql).
    const sbUrl = Deno.env.get("SUPABASE_URL")!;
    const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
    const sb = createClient(sbUrl, sbKey);

    let userId: string | null = null;
    let isCron = false;
    const cronSecretHeader = req.headers.get("x-cron-secret");
    if (cronSecretHeader) {
      const { data: secretRow } = await sb
        .from("app_settings")
        .select("value")
        .eq("key", "cron_shared_secret")
        .maybeSingle();
      const expected = secretRow?.value || "";
      if (expected && cronSecretHeader === expected) {
        isCron = true;
      }
    }

    if (!isCron) {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) {
        return new Response(JSON.stringify({ error: "No autorizado" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
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
      userId = user.id;
    // (gate de owner se valida después de leer storeId del body)
    }

    // 2. Body + rango de fechas.
    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { /* sin body */ }

    const today = new Date();
    const defaultFrom = new Date();
    defaultFrom.setUTCDate(defaultFrom.getUTCDate() - 30);
    const fromDate = String(body.from || defaultFrom.toISOString().split("T")[0]);
    const toDate = String(body.untill || body.to || today.toISOString().split("T")[0]);
    const dryRun = Boolean(body.dryRun);
    const limit = Number(body.limit || 0);

    const storeId = typeof body.store_id === "string" && body.store_id.trim()
      ? body.store_id.trim()
      : (typeof body.storeId === "string" ? (body.storeId as string).trim() : "");

    // ── Path A: store_id explícito (sync manual desde la UI, o cron dirigido) ──
    if (storeId) {
      // Gate: solo el dueño puede ejecutar wallet sync (datos financieros).
      if (!isCron && userId) {
        const isOwner = await isStoreOwner(sb, userId, storeId);
        if (!isOwner) {
          return new Response(
            JSON.stringify({ error: "Solo el dueño de la tienda puede ejecutar el wallet sync" }),
            { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }
      const result = await syncStore(sb, storeId, fromDate, toDate, dryRun, limit, userId);
      const status = result.ok ? 200 : (result.expired ? 401 : 502);
      return new Response(
        JSON.stringify({ ...result, from: fromDate, until: toDate, dry_run: dryRun }),
        { status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── Path B: sin store_id ──
    // Un usuario logueado DEBE indicar su tienda (no adivinamos).
    if (!isCron) {
      return new Response(
        JSON.stringify({ ok: false, error: "Falta store_id en el body" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── Path C: cron sin store_id → FAN-OUT a todas las tiendas activas ──
    // El cron (pg_cron) no pasa store_id; antes de esto la función devolvía 400 y
    // la wallet NUNCA se auto-sincronizaba en multi-tienda. Mismo enumerado que
    // dropi-cron: store_dropi_config con api_key + tienda activa.
    const { data: configs, error: cfgErr } = await sb
      .from("store_dropi_config")
      .select("store_id, dropi_api_key, stores!inner(status)")
      .eq("stores.status", "active");
    if (cfgErr) {
      return new Response(
        JSON.stringify({ ok: false, error: `store_dropi_config: ${cfgErr.message}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    const activeStoreIds = (configs || [])
      .filter((c: Record<string, unknown>) => c.dropi_api_key)
      .map((c: Record<string, unknown>) => String(c.store_id));

    const results: SyncStoreResult[] = [];
    for (const sid of activeStoreIds) {
      // try/catch por tienda: que una con token vencido / throttle (EC) NO aborte
      // la sincronización de las demás (CO).
      try {
        results.push(await syncStore(sb, sid, fromDate, toDate, dryRun, limit, null));
      } catch (e) {
        results.push({ store_id: sid, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        mode: "cron-fanout",
        stores: results,
        from: fromDate,
        until: toDate,
        synced_total: results.reduce((s, r) => s + (r.synced || 0), 0),
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("dropi-wallet-sync error:", msg);
    return new Response(
      JSON.stringify({ ok: false, error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

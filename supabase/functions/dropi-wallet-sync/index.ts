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
// Clasificador robusto de categoría: matchea por contención sobre la descripción
// COMPLETA normalizada (no el `codigo` truncado en el primer ":"). Ver el header de
// _shared/walletCategoria.ts para el root cause del bug 2026-06-24.
import { mapCategoria } from "../_shared/walletCategoria.ts";

const EXPORT_PATH = "/api/wallet/exportexcel";

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
  // Codigo: etiqueta corta de display (primera oración, hasta el primer ":").
  // OJO: NO se usa para clasificar — `mapCategoria` recibe la descripción COMPLETA
  // (este split truncaba el texto y mandaba a 'otro' lo que tenía la palabra clave
  // después del ":"). Ver _shared/walletCategoria.ts.
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
    categoria: mapCategoria(descripcion),
    monto,
    monto_previo: montoPrevio,
    saldo_despues: saldoDespues,
    descripcion,
    cuenta: str(row.CUENTA),
    concepto_retiro: str(row["CONCEPTO DE RETIRO"]),
    related_order_id: relatedOrderId,
    raw: row,
    // Nunca "" — la columna es UUID nullable (FK a auth.users). Ver el comentario
    // del call-site: un string vacío acá tumba el upsert completo.
    synced_by: syncedBy || null,
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
    const errMsg = `Dropi exportexcel [${xlsxRes.status}]: ${txt.slice(0, 200)}`;
    // Loguear el FALLO a sync_logs: antes el wallet-sync solo escribía en el
    // camino de éxito → un 401 (token vencido) o 429 (throttle EC) dejaba CERO
    // rastro y el banner solo lo notaba como envejecimiento, sin distinguir
    // "cron caído" de "token vencido". Auditoría EC 2026-07-07.
    if (!dryRun) {
      await sb.from("sync_logs").insert({
        source: "dropi-wallet-sync",
        status: "error",
        synced_count: 0,
        total_count: 0,
        error_message: errMsg,
        triggered_by: userId,
        store_id: storeId,
      });
    }
    return {
      store_id: storeId,
      ok: false,
      expired: xlsxRes.status === 401,
      error: errMsg,
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
    // `userId` es NULL cuando dispara el cron (no hay usuario autenticado).
    // El `?? ""` que había acá metía string vacío en `synced_by`, que es UUID:
    // Postgres respondía `invalid input syntax for type uuid: ""` y RECHAZABA EL
    // LOTE ENTERO. Resultado: el cron falló en TODAS sus corridas, en las dos
    // tiendas, y la billetera quedó congelada (último movimiento 7-jul en EC,
    // 26-jun en CO). Los datos que había entraron por corridas manuales, donde
    // sí hay usuario. Verificado en producción 2026-07-21.
    .map((r: XlsxRow): Mapped => mapRow(r, userId, storeId))
    .filter((r): r is NonNullable<Mapped> => r !== null);

  let totalSynced = 0;
  let anyUpsertError: string | null = null;
  if (!dryRun && mapped.length > 0) {
    for (let i = 0; i < mapped.length; i += 50) {
      const batch = mapped.slice(i, i + 50);
      const { data: changedCount, error: upsertError } = await sb.rpc(
        "upsert_wallet_movements",
        { p_movements: batch },
      );
      if (upsertError) {
        console.error(`upsert_wallet_movements error (store ${storeId}):`, upsertError);
        anyUpsertError = upsertError.message || String(upsertError);
      } else {
        totalSynced += (changedCount as number) || 0;
      }
    }
    // status='error' si algún batch falló (antes siempre 'success' aunque el
    // upsert reventara → un fallo de RPC quedaba oculto). Auditoría EC 2026-07-07.
    await sb.from("sync_logs").insert({
      source: "dropi-wallet-sync",
      status: anyUpsertError ? "error" : "success",
      synced_count: totalSynced,
      duplicates_count: 0,
      total_count: mapped.length,
      error_message: anyUpsertError,
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

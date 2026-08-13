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
// SheetJS desde su CDN oficial (0.20.3), NO esm.sh/xlsx@0.18.5: la 0.18.5 tiene
// prototype-pollution (GHSA-4r6h-8v6p-xvw6) y ReDoS (GHSA-5pgg-2g8v-p4x9) SIN
// parche en npm — SheetJS sacó las versiones nuevas del registro y solo las
// publica en cdn.sheetjs.com. Misma API (XLSX.read / utils.sheet_to_json).
// OJO: requiere redeploy (Lovable no auto-despliega edge functions); si tras el
// deploy wallet-sync falla al leer el XLSX, revertir esta línea a esm.sh@0.18.5.
import * as XLSX from "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs";
import { getCorsHeaders } from "../_shared/cors.ts";
import { loadStoreConfig, isStoreOwner } from "../_shared/dropiStoreConfig.ts";
import { ensureFreshSessionToken } from "../_shared/dropiSessionLogin.ts";
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
  // El contrato del badge (useWalletSyncHealth) es "TODA corrida deja fila en
  // sync_logs, éxito con 0 movimientos también". Los caminos de RETURN ya lo
  // cumplen, pero los de THROW no: loadStoreConfig tira si la config está
  // corrupta y el fetch del XLSX puede tirar por red. El catch del fan-out solo
  // apila el error en una respuesta HTTP que pg_cron nadie lee → la billetera se
  // congelaba sin que el badge marcara 'failing' (lección del 21-jul).
  try {
    return await syncStoreInner(sb, storeId, fromDate, toDate, dryRun, limit, userId);
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    if (!dryRun) {
      try {
        await sb.from("sync_logs").insert({
          source: "dropi-wallet-sync",
          status: "error",
          synced_count: 0,
          total_count: 0,
          error_message: `Excepción en syncStore: ${errMsg.slice(0, 500)}`,
          triggered_by: userId,
          store_id: storeId,
        });
      } catch (logErr) {
        console.error(`[wallet] no se pudo escribir sync_logs (store ${storeId}):`, logErr);
      }
    }
    return { store_id: storeId, ok: false, error: errMsg };
  }
}

async function syncStoreInner(
  sb: ReturnType<typeof createClient>,
  storeId: string,
  fromDate: string,
  toDate: string,
  dryRun: boolean,
  limit: number,
  userId: string | null,
): Promise<SyncStoreResult> {
  const cfg = await loadStoreConfig(sb, storeId);

  // 2026-07-29: Dropi empezó a rechazar la api_key de INTEGRATIONS en
  // exportexcel — "Token not issued to this api" — en las DOS cuentas a la
  // misma hora (04:23 UTC), sin que nadie tocara credenciales acá. El endpoint
  // volvió a exigir el token de SESIÓN web (como era antes de 2026-05-22).
  // Cadena de intentos, del más probable al último recurso:
  //   1. session token (auto-renovado por exp; EC tiene login configurado),
  //   2. si Dropi rechaza un session "vigente", UN re-login forzado
  //      (Dropi puede revocar tokens antes del exp),
  //   3. api_key — funcionó hasta el 28-jul; si Dropi revierte, seguimos vivos.
  // Cada intento decodifica su PROPIO `sub` (ambos JWT traen el dropi user_id).
  let sessionToken = "";
  // Si el auto-login falla, su mensaje es la CAUSA RAÍZ (clave mala, 2FA) — se
  // guarda para adjuntarlo al error final en sync_logs, no solo a console.
  let loginFailMsg = "";
  try {
    sessionToken = await ensureFreshSessionToken(sb, cfg);
  } catch (e) {
    loginFailMsg = e instanceof Error ? e.message : String(e);
    console.warn(`[wallet] auto-login Dropi falló (store ${storeId}):`, loginFailMsg);
  }

  const decodeSub = (token: string): number => {
    try {
      return Number(JSON.parse(atob(token.split(".")[1])).sub) || 0;
    } catch {
      return 0;
    }
  };

  const candidates: Array<{ label: string; token: string }> = [];
  if (sessionToken) candidates.push({ label: "session", token: sessionToken });
  if (cfg.apiKey) candidates.push({ label: "api_key", token: cfg.apiKey });
  if (candidates.length === 0) {
    const errMsg = "Sin credencial Dropi (api_key ni session_token)" +
      (loginFailMsg ? ` (auto-login: ${loginFailMsg.slice(0, 160)})` : "");
    // También a sync_logs: un fallo de config sin fila era invisible al badge.
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
    return { store_id: storeId, ok: false, error: errMsg };
  }

  let xlsxRes: Response | null = null;
  // TODOS los fallos se acumulan (no solo el último): el diagnóstico completo
  // llega a sync_logs, que es lo único que ve el dueño en el badge.
  const fallos: string[] = [];
  // Solo un 401/403 REAL de Dropi (no un token indescifrable local) habilita el
  // hint de credenciales y el `expired` de la respuesta.
  let sawAuthReject = false;
  let renewedOnce = false;

  // UN re-login forzado por corrida, insertado como candidato siguiente. Se
  // dispara tanto por 401 de Dropi como por un session token indescifrable en
  // DB (paste corrupto): en ambos casos el login lo repara solo.
  const tryForcedRenew = async (i: number, currentToken: string) => {
    if (renewedOnce) return;
    renewedOnce = true;
    try {
      const forced = await ensureFreshSessionToken(sb, cfg, { force: true });
      if (forced && forced !== currentToken) {
        candidates.splice(i + 1, 0, { label: "session renovado", token: forced });
      }
    } catch (e) {
      loginFailMsg = e instanceof Error ? e.message : String(e);
      console.warn(`[wallet] re-login forzado falló (store ${storeId}):`, loginFailMsg);
    }
  };

  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    const dropiUserId = decodeSub(cand.token);
    if (!dropiUserId) {
      fallos.push(`token (${cand.label}) indescifrable — sin user_id`);
      if (cand.label === "session") await tryForcedRenew(i, cand.token);
      continue;
    }
    const params = new URLSearchParams({
      from: fromDate,
      until: toDate,
      user_id: String(dropiUserId),
      wallet_id: "0",
    });
    // Timeout duro: sin él, un hang de Dropi mata la función por wall-clock y la
    // corrida no deja fila en sync_logs (el badge solo ve envejecimiento).
    let res: Response;
    try {
      res = await fetch(`${cfg.base}${EXPORT_PATH}?${params.toString()}`, {
        method: "GET",
        headers: {
          "Accept": "application/json, text/plain, */*",
          "x-authorization": `Bearer ${cand.token}`,
        },
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      fallos.push(`red/timeout con ${cand.label}: ${msg.slice(0, 160)}`);
      console.warn(`[wallet] exportexcel ${fallos[fallos.length - 1]}`);
      break;
    }
    if (res.ok) {
      xlsxRes = res;
      break;
    }
    const txt = await res.text();
    fallos.push(`[${res.status}] con ${cand.label}: ${txt.slice(0, 160)}`);
    console.warn(`[wallet] exportexcel ${fallos[fallos.length - 1]}`);
    // Errores que NO son de credencial (429 throttle EC, 5xx): probar otro
    // token no ayuda y suma requests al throttle — cortar acá.
    if (res.status !== 401 && res.status !== 403) break;
    sawAuthReject = true;
    // 401 con un session "vigente" por exp → Dropi lo revocó antes: renovar.
    if (cand.label === "session") await tryForcedRenew(i, cand.token);
  }

  if (!xlsxRes) {
    const hint = sawAuthReject
      ? " Dropi rechazó las credenciales para la billetera. Si la tienda no tiene auto-login (cuenta con 2FA), pegá un session token fresco en Admin → Credenciales Dropi."
      : "";
    const login = loginFailMsg ? ` (auto-login: ${loginFailMsg.slice(0, 160)})` : "";
    const errMsg = `Dropi exportexcel: ${fallos.join(" | ") || "sin respuesta"}${hint}${login}`;
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
      expired: sawAuthReject,
      error: errMsg,
    };
  }

  // Parseo defensivo: si Dropi devuelve 200 con basura (HTML de mantenimiento
  // en vez del binario), XLSX.read tira — y ese fallo TAMBIÉN va a sync_logs,
  // no solo al catch del fan-out (donde el badge no lo veía).
  let rows: XlsxRow[];
  try {
    const arrayBuffer = await xlsxRes.arrayBuffer();
    const wb = XLSX.read(new Uint8Array(arrayBuffer), { type: "array" });
    const firstSheetName = wb.SheetNames[0];
    if (!firstSheetName) throw new Error("XLSX sin sheets");
    rows = XLSX.utils.sheet_to_json(wb.Sheets[firstSheetName], { defval: null }) as XlsxRow[];
  } catch (e) {
    const errMsg = `El export de Dropi no se pudo leer como XLSX: ${e instanceof Error ? e.message : String(e)}`;
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
    return { store_id: storeId, ok: false, error: errMsg };
  }
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
  if (!dryRun) {
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
    // OJO: este insert corre AUNQUE mapped esté vacío — el contrato del badge
    // (useWalletSyncHealth) es "una fila por CADA corrida, incluso con 0
    // movimientos". Con el guard `mapped.length > 0` una tienda quieta
    // envejecía el badge a stale/critical en falso.
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

  // Si el upsert falló, decirlo también en la RESPUESTA — no solo en sync_logs.
  // Antes esto devolvía ok:true y el sync manual mostraba "Sync OK: 0
  // movimientos" con la RPC reventada: el mismo "fallar en verde" del 21-jul,
  // en el otro canal.
  if (anyUpsertError) {
    return {
      store_id: storeId,
      ok: false,
      synced: totalSynced,
      total: mapped.length,
      rows_in_excel: rows.length,
      error: `upsert_wallet_movements: ${anyUpsertError}`,
    };
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

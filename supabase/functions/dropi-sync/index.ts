import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { respuestaPing } from "../_shared/versionEdge.ts";
import { loadStoreConfig, isStoreOwner } from "../_shared/dropiStoreConfig.ts";
import { mapDropiOrderToRow } from "../_shared/dropiOrderMapper.ts";
import { restoreLocalGestiones } from "../_shared/restoreLocalGestiones.ts";

const MAX_CHUNK_DAYS = 89;
const PAGE_SIZE = 100;
const RATE_LIMIT_MS = 1500;
// Anti-throttle 2026-07-07: tope de páginas por chunk (patrón dropi-snapshot).
// Un rango enorme (preset "Histórico") no puede monopolizar el rate-limit de la
// cuenta — se devuelve partial:true y el caller lo surfacea.
const MAX_PAGES = 30;
// Si Dropi pide esperar más que esto vía Retry-After, abortamos ya (el sleep
// largo reventaría el wall-clock del edge y el cliente vería un error genérico).
const MAX_RETRY_AFTER_MS = 30_000;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Error tipado para distinguir el throttle de Dropi (429) de un fallo real
 *  de credenciales/endpoint. El handler lo usa para responder 200 (no es un
 *  error del cliente) en vez de 500 — así el botón "Forzar sync" no muestra
 *  el genérico "non-2xx status code". */
class DropiRateLimitError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "DropiRateLimitError";
  }
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
  base: string,
  apiKey: string,
  origin: string,
  chunkFrom: string,
  chunkTo: string,
  // Corte por fecha de creación (anti-throttle 2026-07-07): Dropi ECUADOR
  // IGNORA date_from/date_to en este endpoint (verificado: un sync "30 días"
  // paginó la cuenta entera, ~2700+ pedidos). Como viene orderBy=id desc
  // (≈ creación desc), cuando el pedido más viejo de la página ya es anterior
  // al rango pedido, TODO lo restante es más viejo → cortamos. "Pedir el mes
  // pasado trae el mes pasado", no el histórico completo. En CO (el filtro
  // sí funciona) es un no-op. Válido porque este pull SIEMPRE filtra por
  // FECHA DE CREADO.
  stopBeforeCreated?: string,
): Promise<{ orders: Record<string, unknown>[]; partial: boolean }> {
  const allOrders: Record<string, unknown>[] = [];
  let start = 0;
  let pagesFetched = 0;

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

    let res: Response | null = null;
    // Anti-throttle 2026-07-07: 2 intentos (antes 5) + honrar Retry-After.
    // Martillar 5 veces la misma página contra la cuenta ya limitada quemaba
    // 4 req extra + ~30s por página, justo cuando el cron necesita el cupo.
    for (let attempt = 0; attempt < 2; attempt++) {
      res = await fetch(`${base}/integrations/orders/myorders?${qs}`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "dropi-integration-key": apiKey,
          "Origin": origin,
        },
      });
      if (res.status !== 429) break;
      await res.text(); // drenar el body del 429 antes de reintentar
      if (attempt < 1) {
        // Honrar Retry-After (viene en segundos). Number.isFinite es obligatorio:
        // el header puede venir como HTTP-date → NaN → sin la guardia sería un
        // retry inmediato sin backoff (peor que no honrarlo).
        const raRaw = Number(res.headers.get("retry-after"));
        const raMs = Number.isFinite(raRaw) && raRaw > 0 ? raRaw * 1000 : 0;
        if (raMs > MAX_RETRY_AFTER_MS) break; // Dropi pide esperar demasiado → abortar ya (throw abajo)
        await sleep(Math.max(raMs, 2000 * Math.pow(2, attempt)));
      }
    }

    if (res && res.status === 429) {
      // Dropi (sobre todo Ecuador) throttlea cuando el sync manual coincide con
      // el cron. No es un error de credenciales: el sync automático mantiene los
      // pedidos al día igual. Mensaje claro en vez de volcar el stacktrace de Laravel.
      // Tipado como DropiRateLimitError → el handler responde 200, no 500, así el
      // cliente no muestra el genérico "Edge Function returned a non-2xx status code".
      throw new DropiRateLimitError("Dropi está limitando las peticiones (Too Many Attempts). Esperá ~1 minuto y probá de nuevo — el sync automático igual mantiene tus pedidos al día.");
    }
    if (!res || !res.ok) {
      const txt = res ? await res.text() : "no-response";
      throw new Error(`Dropi API [${res?.status ?? "no-response"}]: ${txt}`);
    }

    const data = await res.json();
    if (!data.isSuccess) {
      throw new Error(String(data.message || data.error || "Dropi error"));
    }

    const orders = data.objects || [];
    if (!Array.isArray(orders) || orders.length === 0) break;

    allOrders.push(...orders);
    pagesFetched++;

    if (stopBeforeCreated) {
      const oldest = String((orders[orders.length - 1] as Record<string, unknown>).created_at || "");
      // Ya pasamos el inicio del rango: lo restante es más viejo → completo.
      if (oldest && oldest.split("T")[0] < stopBeforeCreated) break;
    }

    if (orders.length < PAGE_SIZE) break;
    if (pagesFetched >= MAX_PAGES) {
      // Tope defensivo: quedaron páginas sin traer. El caller surfacea
      // partial:true (dropi-sync UPSERTEA, así que un corte silencioso sería
      // un hueco de paridad invisible — a diferencia de dropi-snapshot read-only).
      return { orders: allOrders, partial: true };
    }
    start += PAGE_SIZE;
    await sleep(RATE_LIMIT_MS);
  }

  return { orders: allOrders, partial: false };
}

async function probeConnection(
  base: string,
  apiKey: string,
  origin: string,
): Promise<{ ok: boolean; status: number; rateLimited: boolean; total?: number; sample?: number; error?: string }> {
  const today = new Date().toISOString().split("T")[0];
  const qs = new URLSearchParams({
    result_number: "1",
    start: "0",
    date_from: today,
    date_to: today,
    filter_date_by: "FECHA DE CREADO",
    orderBy: "id",
    orderDirection: "desc",
  }).toString();

  const res = await fetch(`${base}/integrations/orders/myorders?${qs}`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "dropi-integration-key": apiKey,
      "Origin": origin,
    },
  });

  const txt = await res.text();
  if (res.status === 429) {
    return { ok: true, status: 429, rateLimited: true, error: txt.slice(0, 500) };
  }
  if (!res.ok) {
    return { ok: false, status: res.status, rateLimited: false, error: txt.slice(0, 500) };
  }
  try {
    const data = JSON.parse(txt);
    if (!data.isSuccess) {
      return { ok: false, status: res.status, rateLimited: false, error: String(data.message || data.error || "Dropi error") };
    }
    return {
      ok: true,
      status: res.status,
      rateLimited: false,
      total: typeof data.count === "number" ? data.count : undefined,
      sample: Array.isArray(data.objects) ? data.objects.length : undefined,
    };
  } catch {
    return { ok: false, status: res.status, rateLimited: false, error: txt.slice(0, 500) || "Respuesta inválida de Dropi" };
  }
}


/**
 * Marca de versión desplegada. Se contesta con `?ping=1` y NO toca la base.
 * ⛔ Subila en TODO commit que cambie esta función o algo que importa: es lo
 *    único que distingue "Lovable dijo que desplegó" de "está desplegado".
 *    El guardián `src/test/edgeVersionPing.test.ts` exige que exista y que el
 *    ping se conteste ANTES de cualquier auth.
 */
const VERSION = "dropi-sync 2026-08-30.1 auditoria-44";

Deno.serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Antes de auth y sin tocar la base: "¿qué versión está desplegada?".
  { const p = respuestaPing(req, VERSION, corsHeaders); if (p) return p; }

  // Hoisted para que el catch pueda dejar rastro del fallo en sync_logs.
  let logStoreId = "";
  let logUserId = "";

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




    // Parse body — store_id is required (multi-tenant)
    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { /* no body */ }

    const storeId = typeof body.store_id === "string" && body.store_id.trim()
      ? body.store_id.trim()
      : (typeof body.storeId === "string" ? (body.storeId as string).trim() : "");

    if (!storeId) {
      return new Response(
        JSON.stringify({ error: "Falta store_id en el body" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    logStoreId = storeId;
    logUserId = user.id;

    // Gate: caller debe ser owner de la tienda (sync es operación pesada)
    const isOwner = await isStoreOwner(sb, user.id, storeId);
    if (!isOwner) {
      return new Response(
        JSON.stringify({ error: "Solo el dueño de la tienda puede ejecutar el sync" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Load store credentials + país host
    const cfg = await loadStoreConfig(sb, storeId);
    if (!cfg.apiKey) {
      return new Response(
        JSON.stringify({ error: "La tienda no tiene Clave API de Dropi configurada" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (body.mode === "probe" || body.testOnly === true) {
      // Atajo anti-falso-429: si el cron sincronizó esta tienda con éxito en los
      // últimos 10 min, la credencial está OK por definición — no hace falta
      // pegarle a Dropi (que con volumen alto, EC, suele estar throttled justo
      // cuando el usuario aprieta "Probar conexión"). Esto elimina el toast
      // "Dropi está limitando temporalmente las peticiones" en EC.
      const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      // .in("source", ...): sin el filtro, cualquier success (wallet-sync,
      // change-carrier) validaba la credencial de PEDIDOS — bug latente.
      const { data: recentSync } = await sb
        .from("sync_logs")
        .select("created_at, total_count, synced_count")
        .eq("store_id", storeId)
        .in("source", ["dropi-cron", "dropi"])
        .eq("status", "success")
        .gte("created_at", tenMinAgo)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (recentSync) {
        const ageMin = Math.max(0, Math.round((Date.now() - new Date(recentSync.created_at as string).getTime()) / 60000));
        return new Response(
          JSON.stringify({
            ok: true,
            connected: true,
            country: cfg.countryCode,
            host: cfg.base,
            status: 200,
            rateLimited: false,
            recentSync: true,
            ageMinutes: ageMin,
            total: recentSync.total_count,
            message: ageMin <= 0
              ? "Conexión OK — sincronizando ahora"
              : `Conexión OK — último sync hace ${ageMin} min`,
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const probe = await probeConnection(cfg.base, cfg.apiKey, cfg.storeUrl);
      const connected = probe.ok || probe.rateLimited;
      return new Response(
        JSON.stringify({
          ok: connected,
          connected,
          country: cfg.countryCode,
          host: cfg.base,
          status: probe.status,
          rateLimited: probe.rateLimited,
          total: probe.total,
          sample: probe.sample,
          error: connected ? undefined : probe.error,
          dropiError: probe.rateLimited ? probe.error : undefined,
          message: probe.rateLimited
            ? "Conexión OK — Dropi está limitando temporalmente (el sync automático sigue funcionando)."
            : connected
              ? "Conexión OK"
              : "Dropi rechazó la conexión",
        }),
        { status: connected ? 200 : 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Default = últimos 30 días. Antes 90d disparaba 50+ páginas en cuentas
    // grandes (Ecuador) y caía en el throttle de Dropi (429) → se devolvía 500
    // → el cliente mostraba "Edge Function returned a non-2xx status code".
    // El cron mantiene el histórico al día; el botón manual solo necesita un
    // refresco reciente. Para backfill completo, pasar {from, untill} explícito.
    const defaultFrom = new Date();
    defaultFrom.setUTCDate(defaultFrom.getUTCDate() - 30);
    const from = (body.from as string) || defaultFrom.toISOString().split("T")[0];
    const untill = (body.untill as string) || new Date().toISOString().split("T")[0];

    // ── Freshness-guard server-side (anti-throttle 2026-07-07 — EL fix del
    // incidente). El guard de frescura existía solo en mode:"probe"; el sync
    // real re-paginaba el rango completo aunque el cron hubiera sincronizado
    // hace 1 min → 429 garantizado en EC. Cubre de una los 6 call-sites.
    // Skip SOLO si se cumplen las tres:
    //  1. no es force (escape hatch para backfill inmediato desde /admin),
    //  2. el rango es reciente (from ≥ hoy−45d) — un backfill explícito viejo
    //     SIEMPRE corre (si no, el backfill documentado arriba quedaría muerto),
    //  3. hay un sync de PEDIDOS (source dropi-cron/dropi) success con
    //     total_count>0 hace <10 min. El total_count>0 preserva el botón
    //     "Reintentar" anti-zombie de SyncFreshness (un success con 0 traídos
    //     NO debe suprimir el reintento manual).
    const fortyFiveDaysAgo = new Date();
    fortyFiveDaysAgo.setUTCDate(fortyFiveDaysAgo.getUTCDate() - 45);
    const isRecentRange = new Date(from + "T00:00:00Z") >= fortyFiveDaysAgo;
    if (body.force !== true && isRecentRange) {
      const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const { data: freshSync } = await sb
        .from("sync_logs")
        .select("created_at, total_count")
        .eq("store_id", storeId)
        .in("source", ["dropi-cron", "dropi"])
        .eq("status", "success")
        .gt("total_count", 0)
        .gte("created_at", tenMinAgo)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (freshSync) {
        const ageMin = Math.max(0, Math.round((Date.now() - new Date(freshSync.created_at as string).getTime()) / 60000));
        // Shape compatible con los parsers existentes: ConfirmarTab gatea la
        // carga de la DB con `data?.total > 0` — devolver el total_count del
        // sync reciente hace que la operadora cargue los pendientes igual.
        return new Response(
          JSON.stringify({
            synced: 0,
            duplicates: 0,
            total: (freshSync.total_count as number) ?? 0,
            skipped: true,
            freshMinutes: ageMin,
            message: `Pedidos ya sincronizados hace ${ageMin} min por el sync automático — sin peticiones extra a Dropi.`,
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    // Chunk the date range
    const chunks = chunkDateRange(from, untill, MAX_CHUNK_DAYS);
    const today = new Date().toISOString().split("T")[0];

    let totalSynced = 0;
    const totalDuplicates = 0;
    let totalFromDropi = 0;
    let anyPartial = false;
    let anyUpsertError: string | null = null;

    for (const chunk of chunks) {
      const { orders: dropiOrders, partial } = await fetchAllPages(cfg.base, cfg.apiKey, cfg.storeUrl, chunk.from, chunk.to, chunk.from);
      if (partial) anyPartial = true;
      totalFromDropi += dropiOrders.length;

      if (dropiOrders.length === 0) continue;

      const dbOrders = dropiOrders.map((o) => mapOrder(o, user.id, today, storeId));

      // RPC upsert_orders_from_dropi: ON CONFLICT DO UPDATE WHERE
      // IS DISTINCT FROM. Filas idénticas no se reescriben → no se
      // dispara realtime espurio que hacía parpadear la UI de
      // operadoras. Mismo patrón que dropi-cron.
      for (let i = 0; i < dbOrders.length; i += 50) {
        const batch = dbOrders.slice(i, i + 50);
        const { data: changedCount, error: upsertError } = await sb.rpc(
          "upsert_orders_from_dropi",
          { p_orders: batch },
        );

        if (upsertError) {
          // "Fallar en verde" (el mismo bug que congeló la billetera en julio):
          // antes esto solo hacía console.error y al final se escribía un
          // sync_logs status='success' con total_count>0 — que además activa el
          // freshness-guard de arriba y BLOQUEA los reintentos manuales 10 min.
          // Cero filas escritas y el sistema convenciendo de que todo anda.
          console.error("upsert_orders_from_dropi error:", upsertError);
          anyUpsertError = upsertError.message || String(upsertError);
        } else {
          totalSynced += (changedCount as number) || 0;
        }
      }

      await sleep(RATE_LIMIT_MS);
    }

    // Restore de gestiones LOCALES (conf y canc juntas, ganando la más reciente
    // — ver restoreLocalGestiones). Antes eran dos pasadas: la de conf corría
    // primero y dejaba el pedido en PENDIENTE, así que una cancelación posterior
    // ya no matcheaba su WHERE y el pedido volvía a la cola como confirmado.
    const restore = await restoreLocalGestiones(sb, storeId);
    if (restore.error) {
      console.error("dropi-sync: restore de gestiones locales FALLÓ:", restore.error);
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

    // Log. status='error' si algún batch del upsert falló: con 'success' el
    // freshness-guard (source dropi-cron/dropi + status success + total_count>0)
    // suprimía los reintentos manuales 10 min y SyncFreshness quedaba verde con
    // cero filas escritas. Mismo contrato que dropi-wallet-sync.
    const upsertFailed = anyUpsertError !== null;
    const restoreFailed = restore.error !== null;
    const syncErrorMessage = upsertFailed
      ? `upsert_orders_from_dropi: ${anyUpsertError}`
      : restoreFailed
        ? `restore de gestiones locales: ${restore.error}`
        : null;
    await sb.from("sync_logs").insert({
      source: "dropi",
      status: syncErrorMessage ? "error" : "success",
      synced_count: totalSynced,
      duplicates_count: totalDuplicates,
      total_count: totalFromDropi,
      error_message: syncErrorMessage,
      triggered_by: user.id,
      store_id: storeId,
    });

    if (upsertFailed) {
      // 200 con ok:false + error (no 502): los call-sites leen `data.error` y
      // supabase.functions.invoke colapsa cualquier non-2xx en el genérico
      // "non-2xx status code", que esconde el motivo real.
      return new Response(
        JSON.stringify({
          ok: false,
          synced: totalSynced,
          duplicates: totalDuplicates,
          total: totalFromDropi,
          chunks: chunks.length,
          partial: true,
          error: syncErrorMessage,
          message: `Dropi devolvió ${totalFromDropi} pedidos pero la base los RECHAZÓ (${anyUpsertError}). No se guardó nada nuevo.`,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        ok: true,
        synced: totalSynced,
        duplicates: totalDuplicates,
        total: totalFromDropi,
        chunks: chunks.length,
        partial: anyPartial || undefined,
        // El restore no bloquea el sync (los pedidos SÍ se guardaron), pero un
        // fallo ahí deja gestiones locales pisadas por el estado de Dropi.
        restoreError: restore.error || undefined,
        message: anyPartial
          ? `${totalSynced} pedidos sincronizados (sync PARCIAL: el rango era muy grande y quedaron páginas sin traer — el sync automático completa el resto)`
          : `${totalSynced} pedidos sincronizados (${chunks.length} chunk${chunks.length > 1 ? "s" : ""})`,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("dropi-sync error:", err);
    const msg = err instanceof Error ? err.message : "Error interno";

    // Anti-throttle 2026-07-07: dejar rastro del fallo MANUAL en sync_logs.
    // Antes los 429 manuales eran invisibles para SyncFreshness, para el chip
    // del dashboard y para el propio freshness-guard. 'warn' para throttle
    // (SyncFreshness lo mapea a amarillo), 'error' para el resto (rojo).
    if (logStoreId) {
      try {
        const sbLog = createClient(
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        );
        await sbLog.from("sync_logs").insert({
          source: "dropi",
          status: err instanceof DropiRateLimitError ? "warn" : "error",
          synced_count: 0,
          total_count: 0,
          error_message: msg.slice(0, 500),
          triggered_by: logUserId || null,
          store_id: logStoreId,
        });
      } catch { /* best-effort: el log nunca debe tapar el error real */ }
    }

    // Throttle de Dropi: NO es un error del cliente. Responder 200 con
    // rateLimited:true y un mensaje claro, así supabase.functions.invoke no
    // colapsa la respuesta en el genérico "non-2xx status code" y el usuario
    // ve la causa real (el sync automático igual mantiene los pedidos al día).
    if (err instanceof DropiRateLimitError) {
      return new Response(
        JSON.stringify({ synced: 0, total: 0, rateLimited: true, error: msg, message: msg }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Cualquier otro fallo de Dropi (credenciales, endpoint, body sin
    // isSuccess) sale como 502 con el mensaje REAL en `error`, para que la UI
    // lo pueda mostrar en vez del genérico non-2xx.
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

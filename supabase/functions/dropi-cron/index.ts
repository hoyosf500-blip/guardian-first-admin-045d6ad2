import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { dropiHostFor } from "../_shared/dropiHosts.ts";
import { loadStoreConfig, type StoreDropiConfig } from "../_shared/dropiStoreConfig.ts";
import { ensureFreshSessionToken } from "../_shared/dropiSessionLogin.ts";
import { cancelOrderInDropi, dropiGetOrder, notFoundSignal, type CancelOrderResult } from "../_shared/dropiCancelOrder.ts";
import { checkOrderLivenessWeb } from "../_shared/dropiOrderLiveness.ts";

/**
 * dropi-cron: Automated sync triggered by pg_cron every 5 minutes.
 * Syncs orders from the last 14 days to capture status changes.
 * Auth: pg_cron sends x-cron-secret; admins send Authorization Bearer JWT.
 *
 * v4 — MULTI-TIENDA. Antes leía UNA credencial global de app_settings y
 *      pegaba siempre a api.dropi.co. Ahora recorre todas las tiendas
 *      activas de store_dropi_config y sincroniza cada una con SU país
 *      (host correcto), SUS credenciales y SU dueño, etiquetando cada
 *      pedido con su store_id. Una tienda que falla no frena a las demás.
 *
 * v3 — usa RPC upsert_orders_from_dropi (con guardia IS DISTINCT FROM)
 *      para no spamear realtime.
 */

const MAX_CHUNK_DAYS = 89;
const PAGE_SIZE = 100;
// 1500ms entre páginas = ~40 req/min, por debajo del throttle de Dropi (~60/min).
// Antes 500ms (~120 req/min) hacía que el cron mismo se pasara del límite en
// cuentas grandes (Ecuador: ~50 páginas/corrida) → 429 "Too Many Attempts", que
// además tumbaba el botón manual "Probar conexión". Más lento pero estable.
const RATE_LIMIT_MS = 1500;
// Dos ventanas: una por CAMBIO DE ESTATUS (refresca guías que se movieron/
// entregaron, sin importar la fecha de creación) y una corta por CREADO
// (red de seguridad para órdenes nuevas que aún no cambiaron de estatus).
const STATUS_CHANGE_DAYS_BACK = 21;
const CREATED_DAYS_BACK = 3;
// Pausa entre tiendas para no encadenar ráfagas de una tienda con la siguiente.
const INTER_STORE_MS = 3000;
// Presupuesto de tiempo de pared POR TIENDA. Si una tienda (típicamente Ecuador,
// que Dropi throttlea fuerte) se pasa de esto, cortamos su sync y devolvemos lo
// parcial. Garantiza que el edge function NUNCA muera a mitad de una tienda sin
// alcanzar a escribir su fila en sync_logs — que era la causa del banner rojo
// falso "Sin sincronización hace 61h" (los pedidos SÍ entraban, pero el log no).
const STORE_TIME_BUDGET_MS = 90_000;
// Presupuesto GLOBAL de la corrida (todas las tiendas). Backstop por debajo del
// límite de pared del edge function (~150s) para que SIEMPRE alcance a loguear
// cada tienda y correr el post-proceso, aunque dos tiendas vengan pesadas.
const GLOBAL_TIME_BUDGET_MS = 120_000;
// Reintentos cortos ante 429: fail-fast. Si tras esto sigue throttleado, se
// lanza DropiRateLimitError y la tienda corta YA (no encadena ~117s de backoff
// que reventaban el presupuesto del edge function).
const RL_MAX_ATTEMPTS = 3;

// Marca un 429 sostenido de Dropi como condición ESPERADA (no un error duro):
// la tienda corta rápido, se loguea como sync parcial 'success' y el próximo
// tick (cada 5 min) reintenta. Distinto de un fallo real (credenciales, upsert).
class DropiRateLimitError extends Error {
  constructor(msg = "Dropi rate limit (429)") {
    super(msg);
    this.name = "DropiRateLimitError";
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Reintenta el PUT a Dropi para una orden cuya confirmación original falló
// (order_results.dropi_sync_status='failed'). Devuelve ok=true si Dropi aceptó.
async function dropiPutOrderRetry(
  base: string,
  apiKey: string,
  storeUrl: string,
  externalId: string,
  newStatus = "PENDIENTE",
): Promise<{ ok: boolean; httpStatus: number; error?: string }> {
  try {
    const res = await fetch(
      `${base}/integrations/orders/myorders/${encodeURIComponent(externalId)}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "dropi-integration-key": apiKey,
          "Origin": storeUrl,
        },
        body: JSON.stringify({ status: newStatus }),
      },
    );
    const rawText = await res.text();
    let body: Record<string, unknown> = {};
    try { body = rawText ? JSON.parse(rawText) : {}; } catch { body = { raw: rawText }; }
    const ok = res.ok && body.isSuccess !== false;
    return {
      ok,
      httpStatus: res.status,
      error: ok ? undefined : String(body.message || body.error || rawText).slice(0, 200),
    };
  } catch (e) {
    return { ok: false, httpStatus: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---- CAP anti-eterno para los retries (conf y canc) ----
// Pedidos del bot de Dropi (LucidBot/FINAL_ORDER): NINGUNA superficie por-id
// los escribe — el PUT de integración devuelve 200 {isSuccess:false, status:404,
// "Orden no encontrada"} y el PUT web da "Error SQL desconocido [1001][9999]".
// Sin cap, el retry de esas filas fallaba ETERNO los 7 días de la ventana
// (~84 PUTs inútiles/día por fila). Tras RETRY_MAX_BOT_ATTEMPTS fallos con
// señal de esa clase, la fila se marca con el prefijo BOT-SIN-API en
// result_notes y el select de retries la excluye para siempre.
const RETRY_MAX_BOT_ATTEMPTS = 5;
const BOT_NOTES_PREFIX = "BOT-SIN-API: ";
// "no (se )?encontr" cubre "Orden no encontrada" Y "No se encontró registro" —
// esta última era LA variante real de los pedidos bot EC y el regex viejo no la
// matcheaba: el cap nunca disparaba y el cron martilló stubs REEMPLAZADA hasta
// 138 intentos (~550 PUTs inútiles/día alimentando el throttle 429, 2026-07-13).
const BOT_SIGNAL_RE = /no (se )?encontr|no existe|not found|error sql desconocido/i;
// Filtro PostgREST NULL-safe: `not.ilike` a secas descartaría también las filas
// con result_notes NULL (NULL NOT ILIKE ... → NULL → excluida). El patrón va
// SIN el ":" del prefijo para esquivar chars reservados del parser de or=().
const NOT_BOT_FILTER = "result_notes.is.null,result_notes.not.ilike.BOT-SIN-API*";

function isBotClassFailure(httpStatus: number, errText: string): boolean {
  return httpStatus === 404 || BOT_SIGNAL_RE.test(String(errText || ""));
}

// ---- "YA confirmado" (no es un fallo) ----
// El PUT PENDIENTE CONFIRMACION → PENDIENTE falla con "La orden no se encuentra
// en estatus PENDIENTE_CONFIRMACION" cuando el pedido YA salió de esa etapa (lo
// confirmó un intento previo, el bot, o Dropi mismo). La meta ya está cumplida.
// Sin esto, pedidos reales YA confirmados se reintentaban en loop y figuraban
// "confirmación falló" en el panel (auditoría 2026-07-13). Se verifica con un GET
// que de verdad esté PENDIENTE o más adelante (no cancelado/reemplazado).
const ALREADY_CONFIRMED_RE = /no se encuentra en estatus\s+pendiente[_\s]?confirmacion/i;
function isAlreadyConfirmedSignal(errText: string): boolean {
  return ALREADY_CONFIRMED_RE.test(
    String(errText || "").normalize("NFD").replace(/[̀-ͯ]/g, ""),
  );
}
// Estados que confirman que la orden YA pasó la etapa de confirmación (no hay que
// reintentar). Cualquier estado que NO sea pre-confirmación ni cancelado/borrado.
const PRE_O_MUERTO_RE = /PENDIENTE CONFIRMACION|POR CONFIRMAR|CANCELAD|REEMPLAZAD|RECHAZAD/i;

// ---- Filas 'pending' ATASCADAS ----
// El cliente (OrderContext.markResult) inserta la fila 'pending' y la promueve
// a 'synced' (Dropi confirmó) o 'failed' (markDropiFailure/markCancelFailure)
// al resolver el invoke. Si la pestaña muere en el medio, la fila queda
// 'pending' PARA SIEMPRE: el restore sí la contempla (failed+pending) pero el
// retry solo miraba 'failed' → el push a Dropi se perdía en silencio. Tras
// esta gracia (holgada vs el wall-limit ~150s del edge) un 'pending' viejo se
// trata igual que 'failed'. El timestamp va entre comillas dobles: el parser
// de or=() de PostgREST corta en chars reservados (mismo motivo por el que
// NOT_BOT_FILTER va sin el ":" del prefijo).
const STALE_PENDING_GRACE_MS = 15 * 60_000;
function retryStatusFilter(): string {
  const staleIso = new Date(Date.now() - STALE_PENDING_GRACE_MS).toISOString();
  return `dropi_sync_status.eq.failed,and(dropi_sync_status.eq.pending,created_at.lt."${staleIso}")`;
}

/** Lee el contador "(intento N)" que los retries acumulan en result_notes. */
function parseRetryAttempts(notes: string | null | undefined): number {
  const m = /\(intento (\d+)\)/i.exec(String(notes || ""));
  return m ? Number(m[1]) || 0 : 0;
}

/** Nota de fallo con contador; al fallo Nº RETRY_MAX_BOT_ATTEMPTS con señal
 *  clase-bot antepone BOT-SIN-API (el select de retries la excluye → esa fila
 *  no se reintenta nunca más). */
function buildRetryFailureNotes(
  label: string,
  attempts: number,
  httpStatus: number,
  errText: string,
): string {
  const base = `${label} falló (intento ${attempts}) [${httpStatus}]: ${errText || ""}`.slice(0, 420);
  if (attempts >= RETRY_MAX_BOT_ATTEMPTS && isBotClassFailure(httpStatus, errText)) {
    return (BOT_NOTES_PREFIX +
      `pedido sin superficie API por-id (clase bot) — no se reintenta más. ` + base).slice(0, 500);
  }
  return base;
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
  base: string,
  apiKey: string,
  origin: string,
  chunkFrom: string,
  chunkTo: string,
  filterDateBy: string,
  deadline: number,
  // Corte por fecha de creación (anti-throttle 2026-07-07): Dropi ECUADOR
  // IGNORA date_from/date_to → el pase de "creado 3d" paginaba la cuenta
  // ENTERA cada 5 min (~2700 pedidos/corrida medidos en vivo) hasta que el
  // deadline lo cortaba — la causa raíz del throttle permanente de EC. Como
  // viene orderBy=id desc (≈ creación desc), al pasar el inicio de la ventana
  // cortamos: lo restante es más viejo. El caller decide cuándo aplica (ver
  // buildPasses: pase creado = siempre; pase estatus = solo EC, con margen).
  stopBeforeCreated?: string,
): Promise<Record<string, unknown>[]> {
  const allOrders: Record<string, unknown>[] = [];
  let start = 0;

  while (true) {
    // Presupuesto de tiempo agotado → devolvemos lo que tengamos (parcial).
    if (Date.now() > deadline) {
      console.warn(`fetchAllPages: presupuesto agotado, corte parcial con ${allOrders.length} órdenes`);
      break;
    }

    const params: Record<string, string> = {
      result_number: String(PAGE_SIZE),
      start: String(start),
      date_from: chunkFrom,
      date_to: chunkTo,
      filter_date_by: filterDateBy,
      orderBy: "id",
      orderDirection: "desc",
    };

    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");

    let res: Response | null = null;
    let lastTxt = "";
    let rateLimited = false;
    for (let attempt = 0; attempt < RL_MAX_ATTEMPTS; attempt++) {
      res = await fetch(`${base}/integrations/orders/myorders?${qs}`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "dropi-integration-key": apiKey,
          "Origin": origin,
        },
      });
      if (res.status !== 429) { rateLimited = false; break; }
      rateLimited = true;
      lastTxt = await res.text();
      // Backoff corto (1s, 2s). No reintentar tras el último: fail-fast.
      if (attempt < RL_MAX_ATTEMPTS - 1) {
        const backoffMs = 1000 * Math.pow(2, attempt);
        // Anti-throttle 2026-07-07: honrar Retry-After (segundos). Guardia
        // Number.isFinite: si viene como HTTP-date, Number() da NaN → sin
        // guardia sería un retry inmediato sin backoff.
        const raRaw = Number(res.headers.get("retry-after"));
        const raMs = Number.isFinite(raRaw) && raRaw > 0 ? raRaw * 1000 : 0;
        const waitMs = Math.max(raMs, backoffMs);
        // Si la espera no cabe en el presupuesto de la tienda, cortar YA en vez
        // de quemar el deadline durmiendo (syncStore rescata como parcial).
        if (Date.now() + waitMs > deadline) throw new DropiRateLimitError();
        await sleep(waitMs);
      }
    }

    // 429 sostenido: cortar la tienda YA en vez de seguir paginando hacia más
    // 429. Devolvemos lo parcial vía la excepción (syncStore la rescata).
    if (rateLimited && res?.status === 429) {
      console.warn(`Dropi 429 sostenido tras ${RL_MAX_ATTEMPTS} intentos: ${lastTxt.slice(0, 120)}`);
      throw new DropiRateLimitError();
    }

    if (!res || !res.ok) {
      const txt = res ? await res.text() : "no-response";
      console.error(`Dropi API error ${res?.status ?? "?"}: ${txt}`);
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

    if (stopBeforeCreated) {
      const oldest = String((orders[orders.length - 1] as Record<string, unknown>).created_at || "");
      // Ya pasamos el inicio de la ventana: lo restante es más viejo → listo.
      if (oldest && oldest.split("T")[0] < stopBeforeCreated) break;
    }

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

function mapOrder(o: Record<string, unknown>, userId: string, today: string, storeId: string) {
  const products = (o.orderdetails as Array<Record<string, unknown>>) || [];
  const productName = products
    .map((p) => (p.product as Record<string, unknown>)?.name || "")
    .filter(Boolean)
    .join(", ");
  const cantidad = products.reduce(
    (sum, p) => sum + (parseFloat(String(p.quantity || "1")) || 1),
    0,
  );
  // FIX 2026-07-02: × quantity (igual que _shared/dropiOrderMapper.ts) — sin esto
  // el COGS de pedidos multi-unidad quedaba subcontado (31.3% vs 37.3% real en mayo EC).
  const costoProd = products.reduce((sum, p) => {
    const supplierPrice = parseFloat(String(p.supplier_price || "0")) || 0;
    const salePrice = parseFloat(String((p.product as Record<string, unknown>)?.sale_price || "0")) || 0;
    const qty = parseFloat(String(p.quantity || "1")) || 1;
    return sum + (supplierPrice || salePrice) * qty;
  }, 0);

  const createdAt = String(o.created_at || "");
  const updatedAt = String(o.updated_at || "");
  const fecha = createdAt ? createdAt.split("T")[0] : today;
  const status = String(o.status || "PENDIENTE").toUpperCase();
  const isPendConf = status === "PENDIENTE CONFIRMACION";
  const fechaConf = !isPendConf && updatedAt ? updatedAt.split("T")[0] : null;

  const novedadServ = o.novedad_servientrega ? String(o.novedad_servientrega) : "";
  const movements = (o.servientrega_movements as Array<Record<string, unknown>>) || [];
  const lastMovement = movements.length > 0 ? String(movements[movements.length - 1]?.description || movements[movements.length - 1]?.status || "") : "";
  const novedad = novedadServ || lastMovement;

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
    store_id: storeId,
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
    novedad,
    guia,
    transportadora,
    tags,
    tienda,
    novedad_sol: novedadSol,
    // Último movimiento real en Dropi (updated_at). Lo usan las Listas SLA de
    // /seguimiento para medir días hábiles SIN MOVIMIENTO (no antigüedad).
    last_movement_at: updatedAt || null,
  };
}

interface StoreSync {
  store_id: string;
  country_code: string;
  api_key: string;
  store_url: string;
  owner_id: string;
}

/** Una "pasada" de sync: un rango de fechas con un criterio de filtrado.
 *  Corremos 2 por tienda: cambio de estatus (refresca guías que se movieron,
 *  sin importar antigüedad) + creado reciente (red de seguridad para nuevas). */
// `role` marca cual pasada es la de estatus, para atribuir su conteo por
// separado (winner filter + deteccion zombie miran SOLO el pase de estatus).
interface SyncPass { from: string; to: string; filterDateBy: string; role?: "created" | "status"; stopBeforeCreated?: string }

// Sincroniza UNA tienda con varias pasadas. Devuelve {synced, total}. No lanza:
// captura su propio error para que una tienda caída no frene a las demás. El
// upsert es idempotente (guardia IS DISTINCT FROM), así que pasadas que se
// solapan no duplican ni spamean realtime.
async function syncStore(
  // deno-lint-ignore no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  store: StoreSync,
  passes: SyncPass[],
  todayStr: string,
  deadline: number,
): Promise<{ synced: number; total: number; statusTotal: number; error?: string; throttled?: boolean }> {
  const base = dropiHostFor(store.country_code);
  // Anti-throttle 2026-07-07: el deadline viene PRE-calculado por el caller
  // (rebanada justa de la tienda ∩ global) y es EL MISMO para la invocación
  // inicial y las re-invocaciones del fallback de filter_date_by. Antes cada
  // re-invocación obtenía deadline fresco → una tienda probeando variantes
  // podía devorar los 120s globales y dejar a EC con 0s de paginación.
  let synced = 0;
  let total = 0;
  // Conteo SOLO del pase de cambio de estatus. El winner-filter y la deteccion
  // zombie miran este numero, NO el total (que ahora incluye el pase de CREADO
  // que corre primero y casi siempre trae ordenes nuevas -> enmascararia un
  // filter_date_by roto, el bug zombie del 21-28/05).
  let statusTotal = 0;

  try {
    for (const pass of passes) {
      const chunks = chunkDateRange(pass.from, pass.to, MAX_CHUNK_DAYS);
      for (const chunk of chunks) {
        if (Date.now() > deadline) {
          console.warn(`[store ${store.store_id}] presupuesto agotado, corte parcial`);
          return { synced, total, statusTotal, throttled: true };
        }
        const dropiOrders = await fetchAllPages(base, store.api_key, store.store_url, chunk.from, chunk.to, pass.filterDateBy, deadline, pass.stopBeforeCreated);
        total += dropiOrders.length;
        if (pass.role === "status") statusTotal += dropiOrders.length;
        if (dropiOrders.length === 0) continue;

        const dbOrders = dropiOrders.map((o) => mapOrder(o, store.owner_id, todayStr, store.store_id));
        for (let i = 0; i < dbOrders.length; i += 50) {
          const batch = dbOrders.slice(i, i + 50);
          const { data: changedCount, error: upsertError } = await sb.rpc(
            "upsert_orders_from_dropi",
            { p_orders: batch },
          );
          if (upsertError) {
            console.error(`[store ${store.store_id}] upsert error:`, upsertError);
          } else {
            synced += (changedCount as number) || 0;
          }
        }
        await sleep(RATE_LIMIT_MS);
      }
    }
    return { synced, total, statusTotal };
  } catch (err) {
    // 429 sostenido NO es un fallo: la tienda sincronizó lo que pudo y el próximo
    // tick reintenta. Se devuelve como throttled (parcial) para loguear 'success'
    // y NO pintar el banner de rojo. Cualquier otra excepción sí es error duro.
    if (err instanceof DropiRateLimitError) {
      console.warn(`[store ${store.store_id}] throttled por Dropi (429) — sync parcial: ${synced}/${total}`);
      return { synced, total, statusTotal, throttled: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[store ${store.store_id}] sync failed:`, msg);
    return { synced, total, statusTotal, error: msg };
  }
}

Deno.serve(async (req: Request) => {
  const CORS_HEADERS = getCorsHeaders(req);
  console.log("dropi-cron v4 — multi-tienda");
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, supabaseServiceKey);

    // ---- Auth path 1: shared secret for pg_cron ----
    const cronSecretHeader = req.headers.get("x-cron-secret");
    if (cronSecretHeader) {
      const { data: secretRow } = await sb
        .from("app_settings").select("value").eq("key", "cron_shared_secret").maybeSingle();
      if (!secretRow?.value || secretRow.value !== cronSecretHeader) {
        return new Response(JSON.stringify({ error: "Cron secret invalido" }), {
          status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
      console.log("dropi-cron: authenticated via cron shared secret");
    } else {
      // ---- Auth path 2: require admin role for authenticated callers ----
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) {
        return new Response(JSON.stringify({ error: "No autorizado" }), {
          status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
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
            status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        }
        const { data: roleData } = await sb
          .from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin").maybeSingle();
        if (!roleData) {
          return new Response(
            JSON.stringify({ error: "Solo administradores pueden ejecutar el sync" }),
            { status: 403, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
          );
        }
        console.log(`dropi-cron: triggered by admin ${user.id}`);
      }
    }

    // ---- Cargar todas las tiendas ACTIVAS con credenciales ----
    const { data: configs, error: cfgErr } = await sb
      .from("store_dropi_config")
      .select("store_id, country_code, dropi_api_key, dropi_store_url, stores!inner(status)")
      .eq("stores.status", "active");

    if (cfgErr) {
      console.error("dropi-cron: error leyendo store_dropi_config:", cfgErr);
      return new Response(JSON.stringify({ error: cfgErr.message }), { status: 500 });
    }

    const activeConfigs = (configs || []).filter((c: Record<string, unknown>) => c.dropi_api_key);
    // Orden determinista: CO (mercado principal) primero. Antes el orden era el
    // que devolvía Postgres (indefinido) y si Ecuador —que Dropi throttlea
    // fuerte— caía primero, consumía el presupuesto global y dejaba a Colombia
    // SIN sincronizar → guías "que no se mueven". Con CO primero + presupuesto
    // justo por tienda (abajo), ninguna tienda puede starvear a otra.
    activeConfigs.sort((a: Record<string, unknown>, b: Record<string, unknown>) => {
      const rank = (cc: unknown) => (String(cc || "CO") === "CO" ? 0 : 1);
      return rank(a.country_code) - rank(b.country_code);
    });
    if (activeConfigs.length === 0) {
      console.warn("dropi-cron: no hay tiendas activas con dropi_api_key");
      return new Response(JSON.stringify({ stores: 0, message: "Sin tiendas configuradas" }), {
        status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // Resolver el dueño de cada tienda (uploaded_by). Preferimos el owner;
    // fallback a stores.created_by.
    const storeIds = activeConfigs.map((c: Record<string, unknown>) => c.store_id);
    const { data: owners } = await sb
      .from("store_members").select("store_id, user_id").eq("role", "owner").in("store_id", storeIds);
    const { data: storesRows } = await sb
      .from("stores").select("id, created_by").in("id", storeIds);
    const ownerByStore = new Map<string, string>();
    (owners || []).forEach((o: Record<string, string>) => {
      if (!ownerByStore.has(o.store_id)) ownerByStore.set(o.store_id, o.user_id);
    });
    (storesRows || []).forEach((s: Record<string, string>) => {
      if (!ownerByStore.has(s.id) && s.created_by) ownerByStore.set(s.id, s.created_by);
    });

    // Dos ventanas compartidas por todas las tiendas:
    //  1) CAMBIO DE ESTATUS (21d): refresca toda guía que se movió/entregó, sin
    //     importar cuándo se creó → arregla "entregadas que siguen en guía
    //     generada" y "sin movimiento marca casi todas".
    //  2) CREADO (3d): red de seguridad para órdenes nuevas que aún no
    //     registraron cambio de estatus (que aparezcan rápido en /confirmar).
    const today = new Date();
    const to = today.toISOString().split("T")[0];
    const todayStr = to;
    const dateBack = (n: number) => {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - n);
      return d.toISOString().split("T")[0];
    };
    // Fallback chain de filter_date_by: si la primera variante devuelve 0,
    // probamos la siguiente. Cuando una funciona, la "ganadora" se cachea para
    // las próximas tiendas del run (evita probar 4 variantes por tienda).
    // Por qué: el 2026-05-21 Dropi cambió silenciosamente algo en su endpoint
    // integrations y "FECHA DE CAMBIO DE ESTATUS" empezó a devolver 0 sin
    // error. Con el chain, si vuelve a pasar, el cron auto-cura.
    const STATUS_FILTER_VARIANTS = [
      "FECHA DE CAMBIO DE ESTATUS",
      "Modified Date",
      "MODIFIED_DATE",
      "", // sin filter_date_by (default)
    ];
    // GAP A: arrancamos por el último ganador persistido (si existe) para que
    // health y reconcile auto-curen también vía app_settings. Si Dropi cambia
    // el valor otra vez, el chain de fallback abajo lo re-descubre y persiste.
    let winningStatusFilter: string | null = null;
    try {
      const { data: prev } = await sb.from("app_settings")
        .select("value").eq("key", "dropi_winning_status_filter").maybeSingle();
      const prevVal = prev?.value;
      if (prevVal !== undefined && prevVal !== null) {
        const idx = STATUS_FILTER_VARIANTS.indexOf(prevVal);
        if (idx > 0) {
          STATUS_FILTER_VARIANTS.splice(idx, 1);
          STATUS_FILTER_VARIANTS.unshift(prevVal);
        } else if (idx === -1) {
          STATUS_FILTER_VARIANTS.unshift(prevVal);
        }
      }
    } catch (e) {
      console.warn("dropi-cron: no se pudo leer dropi_winning_status_filter previo:", e);
    }
    // ORDEN CRITICO: el pase BARATO de CREADO (3d, ordenes nuevas -> /confirmar)
    // corre PRIMERO; el pase PESADO de CAMBIO DE ESTATUS (21d) va DESPUES.
    // syncStore itera este array en orden, asi que si el presupuesto se agota o
    // Dropi throttlea (429) durante el pase pesado, los pedidos NUEVOS ya
    // entraron. Antes iba al reves y el pase pesado (~21d) se comia el
    // presupuesto/deadline -> las ordenes nuevas de Ecuador eran el sacrificio
    // sistematico y no aparecian en /confirmar (fuga de inflow).
    // Corte-por-rango (anti-throttle 2026-07-07, "pedir 3 días trae 3 días"):
    // - Pase CREADO: stopBeforeCreated SIEMPRE (el pull es por FECHA DE CREADO,
    //   el corte es exacto; en CO no-op porque el filtro sí funciona, en EC
    //   corta la paginación de la cuenta entera → 1-2 páginas).
    // - Pase ESTATUS: SOLO en EC (donde el filtro se ignora y la lista es toda
    //   la cuenta por creación desc). Margen +7d: pedidos creados hasta 28d
    //   atrás que aún se mueven conservan el refresh de 5 min; los más viejos
    //   los reconcilia el nightly (corte-por-ID, fix 2026-07-07). En CO NO se
    //   corta: el filtro funciona y sus resultados viejos son legítimos
    //   (pedido viejo con estatus recién cambiado).
    const EC_STATUS_SCAN_EXTRA_DAYS = 7;
    const buildPasses = (statusFilter: string, countryCode: string): SyncPass[] => ([
      {
        from: dateBack(CREATED_DAYS_BACK), to, filterDateBy: "FECHA DE CREADO", role: "created",
        stopBeforeCreated: dateBack(CREATED_DAYS_BACK),
      },
      {
        from: dateBack(STATUS_CHANGE_DAYS_BACK), to, filterDateBy: statusFilter, role: "status",
        stopBeforeCreated: countryCode === "EC"
          ? dateBack(STATUS_CHANGE_DAYS_BACK + EC_STATUS_SCAN_EXTRA_DAYS)
          : undefined,
      },
    ]);
    const from = dateBack(STATUS_CHANGE_DAYS_BACK); // para logs

    let grandSynced = 0;
    let grandTotal = 0;
    const perStore: Record<string, unknown>[] = [];
    // Deadline global de la corrida: ninguna tienda paginará más allá de esto,
    // así siempre queda tiempo para loguear y correr el post-proceso.
    const globalDeadline = Date.now() + GLOBAL_TIME_BUDGET_MS;
    // Rebanada justa por tienda: reparte el presupuesto global en partes iguales
    // para que la 1ª tienda no lo devore. Con 2 tiendas → ~60s c/u. Si una
    // termina antes, las siguientes igual respetan su techo (no se penaliza CO).
    const perStoreBudget = Math.floor(GLOBAL_TIME_BUDGET_MS / activeConfigs.length);

    for (const cfg of activeConfigs) {
      const storeId = String(cfg.store_id);
      const ownerId = ownerByStore.get(storeId);
      if (!ownerId) {
        console.warn(`dropi-cron: tienda ${storeId} sin dueño, se omite`);
        perStore.push({ store_id: storeId, error: "sin dueño" });
        continue;
      }
      const store: StoreSync = {
        store_id: storeId,
        country_code: String(cfg.country_code || "CO"),
        api_key: String(cfg.dropi_api_key),
        store_url: String(cfg.dropi_store_url || "https://rushmira.com/"),
        owner_id: ownerId,
      };
      console.log(`dropi-cron: sync tienda ${storeId} (${store.country_code}) — cambio_estatus ${from}→${to} + creado ${dateBack(CREATED_DAYS_BACK)}→${to}`);

      // Rebanada de ESTA tienda: se calcula UNA vez y se comparte con las
      // re-invocaciones del fallback — el probing ya no obtiene presupuesto
      // fresco ni puede starvear a las tiendas siguientes (EC sin sync).
      const storeDeadline = Math.min(
        Date.now() + Math.min(STORE_TIME_BUDGET_MS, perStoreBudget),
        globalDeadline,
      );

      // Si ya sabemos qué filter_date_by funciona (de una tienda previa), arrancamos con ese.
      let chosenFilter = winningStatusFilter ?? STATUS_FILTER_VARIANTS[0];
      let r = await syncStore(sb, store, buildPasses(chosenFilter, store.country_code), todayStr, storeDeadline);

      // Fallback: si la 1ª variante devolvió 0/0 SIN error/throttle, probamos el resto.
      // Solo aplicamos fallback si aún no tenemos winner (evita penalizar a las tiendas siguientes).
      // Anti-throttle 2026-07-07: cada probe re-corre SOLO el pase de estatus
      // ([1]) — el pase de CREADO ya corrió en la invocación inicial y es
      // idéntico entre variantes (re-correrlo duplicaba la paginación de 3d
      // por cada variante probada). role:"status" se preserva → statusTotal
      // sigue alimentando winner/zombie igual que antes.
      if (!winningStatusFilter && r.statusTotal === 0 && !r.error && !r.throttled) {
        for (const variant of STATUS_FILTER_VARIANTS.slice(1)) {
          if (Date.now() > storeDeadline) break;
          console.warn(`dropi-cron: tienda ${storeId} — filter_date_by="${chosenFilter}" dio 0. Probando "${variant}"`);
          chosenFilter = variant;
          const probe = await syncStore(sb, store, [buildPasses(variant, store.country_code)[1]], todayStr, storeDeadline);
          // Acumular lo que el probe haya traído sobre el resultado inicial
          // (synced/total del pase de creado inicial + estatus del probe).
          r = {
            synced: r.synced + probe.synced,
            total: r.total + probe.total,
            statusTotal: probe.statusTotal,
            error: probe.error,
            throttled: probe.throttled,
          };
          if (r.statusTotal > 0) {
            console.log(`dropi-cron: filter_date_by GANADOR="${variant}" (pase de estatus devolvio ${r.statusTotal} pedidos)`);
            winningStatusFilter = variant;
            break;
          }
        }
      } else if (r.statusTotal > 0 && !winningStatusFilter) {
        winningStatusFilter = chosenFilter;
      }

      grandSynced += r.synced;
      grandTotal += r.total;
      perStore.push({ store_id: storeId, country: store.country_code, filter: chosenFilter, ...r });

      // Detección de estado zombie: sync corrió sin error/throttle pero el pase
      // de CAMBIO DE ESTATUS devolvió 0 pedidos. Eso es lo que pasó del 21/05 al
      // 28/05 — invisible con status='success'. Miramos statusTotal (NO total)
      // igual que el winner-filter: el pase de CREADO casi siempre trae ordenes
      // nuevas y enmascararía un filter_date_by roto (el bug zombie exacto).
      // Ahora se loguea como 'warn' con mensaje explícito para que el banner
      // SyncFreshness lo detecte.
      const isZombie = !r.error && !r.throttled && r.synced === 0 && r.statusTotal === 0;
      // STATUS STARVED: la cuenta throttleó y el pase de CAMBIO DE ESTATUS (el
      // pesado, ~21d) no completó (statusTotal===0), aunque el pase liviano de
      // CREADO sí trajo pedidos nuevos (synced>0). Antes esto era 'success' →
      // banner verde mientras las guías en curso no refrescaban su estado. Ahora
      // 'warn' con mensaje de throttle para que SyncFreshness lo pinte amarillo
      // y ofrezca "reintenta solo" en vez de "auditar" (auditoría EC 2026-07-07).
      const statusStarved = r.throttled && r.statusTotal === 0;
      const logStatus = r.error ? "error" : (isZombie || statusStarved ? "warn" : "success");
      const logMsg = r.error
        ? r.error
        : statusStarved
          ? "Dropi throttle (429): el refresh de estatus quedó incompleto — las guías en curso pueden no reflejar su último estado. Reintenta solo."
          : r.throttled
            ? "Dropi throttle (429) — sincronización parcial"
            : isZombie
              ? `Dropi devolvió 0 pedidos en el pase de cambio de estatus (filter_date_by="${chosenFilter}") — posible api_key inválida, endpoint cambiado o filter_date_by roto`
              : null;
      await sb.from("sync_logs").insert({
        source: "dropi-cron",
        status: logStatus,
        synced_count: r.synced,
        duplicates_count: 0,
        total_count: r.total,
        error_message: logMsg,
        triggered_by: ownerId,
        store_id: storeId,
      });

      // Pausa entre tiendas: evita encadenar la ráfaga de una con la siguiente
      // y dejar el throttle de Dropi caliente para el botón manual.
      await sleep(INTER_STORE_MS);
    }

    // GAP A: persistir el filter ganador para que health/reconcile lo usen.
    if (winningStatusFilter !== null) {
      try {
        await sb.from("app_settings").upsert(
          { key: "dropi_winning_status_filter", value: winningStatusFilter, updated_at: new Date().toISOString() },
          { onConflict: "key" },
        );
      } catch (e) {
        console.warn("dropi-cron: no se pudo persistir dropi_winning_status_filter:", e);
      }
    }

    // ---- Post-proceso GLOBAL (sobre todas las tiendas) ----

    // Restaurar PRIMERO (rápido) — evita que si el reintento consume todo el
    // presupuesto del edge, queden pedidos confirmados reapareciendo en /confirmar.
    const todayDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(new Date());
    const { data: confirmedToday } = await sb
      .from("order_results").select("order_id").eq("result", "conf").eq("result_date", todayDate);
    const { data: confirmedStuck } = await sb
      .from("order_results").select("order_id").eq("result", "conf").in("dropi_sync_status", ["failed", "pending"]);
    const idsToRestore = new Set<string>();
    (confirmedToday || []).forEach((r: { order_id: string }) => idsToRestore.add(r.order_id));
    (confirmedStuck || []).forEach((r: { order_id: string }) => idsToRestore.add(r.order_id));
    if (idsToRestore.size > 0) {
      const confirmedIds = Array.from(idsToRestore);
      for (let i = 0; i < confirmedIds.length; i += 50) {
        const batch = confirmedIds.slice(i, i + 50);
        await sb.from("orders").update({ estado: "PENDIENTE" })
          .in("id", batch).eq("estado", "PENDIENTE CONFIRMACION");
      }
      console.log(`dropi-cron: Restored ${confirmedIds.length} locally confirmed orders (today + stuck-failed)`);
    }

    // Reintento de confirmaciones cuyo push a Dropi falló en su momento
    // (dropi_sync_status='failed'). Corre DESPUÉS del restore para no quedarnos
    // sin presupuesto antes de proteger el estado local. Ventana 7 días, máx 50.
    try {
      const cfgByStore = new Map<string, { base: string; apiKey: string; storeUrl: string }>();
      for (const c of activeConfigs) {
        cfgByStore.set(String(c.store_id), {
          base: dropiHostFor(String(c.country_code || "CO")),
          apiKey: String(c.dropi_api_key),
          storeUrl: String(c.dropi_store_url || "https://rushmira.com/"),
        });
      }
      const retryFrom = new Date();
      retryFrom.setUTCDate(retryFrom.getUTCDate() - 7);
      const retryFromStr = retryFrom.toISOString().split("T")[0];
      const { data: failedRows } = await sb
        .from("order_results")
        .select("id, order_id, result_date, result_notes")
        .eq("result", "conf")
        // 'failed' + 'pending' atascado (ver retryStatusFilter).
        .or(retryStatusFilter())
        .gte("result_date", retryFromStr)
        // CAP anti-eterno: filas marcadas BOT-SIN-API no se reintentan más.
        .or(NOT_BOT_FILTER)
        .limit(50);
      if (failedRows && failedRows.length > 0) {
        const orderIds = (failedRows as Array<{ order_id: string }>).map(r => r.order_id);
        const { data: ordersForRetry } = await sb
          .from("orders").select("id, external_id, store_id, estado").in("id", orderIds);
        const orderById = new Map<string, { external_id: string | null; store_id: string; estado: string | null }>();
        (ordersForRetry || []).forEach((o: { id: string; external_id: string | null; store_id: string; estado: string | null }) => {
          orderById.set(o.id, { external_id: o.external_id, store_id: o.store_id, estado: o.estado });
        });
        // Anti-throttle 2026-07-07: antes este loop re-PUTeaba hasta 50 filas
        // cada 5 min PARA SIEMPRE, a 2 req/s, sin mirar 429 ni deadline — el
        // mayor desperdicio sostenido del inventario (~600 PUTs/h bajo throttle)
        // y un feedback loop: el throttle marca confirmaciones como failed → la
        // cola crece → el retry perpetúa el 429 que la creó.
        // Tiendas que ESTA corrida ya vio throttleadas: ni intentar sus PUTs.
        const throttled429 = new Set<string>(
          perStore.filter((p) => p.throttled === true).map((p) => String(p.store_id)),
        );
        // Gracia de +20s sobre el deadline global: el crudo suele estar vencido
        // tras dos tiendas pesadas (el retry se saltearía TODA corrida pesada
        // aunque no haya throttle); +20s cabe en el wall limit (~150s).
        const postDeadline = globalDeadline + 20_000;
        let retryOk = 0, retryFail = 0, retryDeferred = 0;
        for (const row of failedRows as Array<{ id: string; order_id: string; result_notes: string | null }>) {
          if (Date.now() > postDeadline) break;
          // Cinturón extra por si el filtro .or() del select no excluyó la fila.
          if (String(row.result_notes || "").startsWith(BOT_NOTES_PREFIX)) continue;
          const ord = orderById.get(row.order_id);
          if (!ord || !ord.external_id) continue;
          // Fila OBSOLETA (2026-07-13): la orden local ya está REEMPLAZADA/
          // CANCELADA (stub superado por una hermana del forwarding de Dropi).
          // Confirmarla en Dropi sería un ERROR aunque el PUT funcionara — y el
          // cron llegó a martillar 46 de estas hasta 138 intentos c/u porque el
          // cap de clase-bot no matcheaba "No se encontró registro". Se termina
          // acá mismo (mismo mecanismo BOT-SIN-API) SIN gastar un PUT.
          if (ord.estado && /CANCELAD|REEMPLAZAD|RECHAZAD/i.test(String(ord.estado))) {
            await sb.from("order_results").update({
              dropi_sync_status: "failed",
              result_notes: (BOT_NOTES_PREFIX +
                `orden local ${ord.estado} (stub superado) — confirmación obsoleta, no se reintenta más.`).slice(0, 500),
            }).eq("id", row.id);
            continue;
          }
          const sid = String(ord.store_id);
          if (throttled429.has(sid)) { retryDeferred++; continue; }
          const cfg = cfgByStore.get(sid);
          if (!cfg) continue;
          const prevAttempts = parseRetryAttempts(row.result_notes);
          const r = await dropiPutOrderRetry(cfg.base, cfg.apiKey, cfg.storeUrl, ord.external_id, "PENDIENTE");
          if (r.httpStatus === 429) {
            // 429 → posponer los retries de ESA tienda (no abortar el loop:
            // un 429 de EC no debe starvear los retries de CO). El próximo
            // tick reintenta; la fila queda failed, no se pierde nada. El
            // contador "(intento N)" se conserva para no resetear el CAP.
            throttled429.add(sid);
            retryDeferred++;
            await sb.from("order_results").update({
              result_notes: "Reintento pospuesto: Dropi throttled (429)" +
                (prevAttempts > 0 ? ` (intento ${prevAttempts})` : ""),
            }).eq("id", row.id);
            continue;
          }
          // "Ya confirmado": Dropi rechaza el PUT porque el pedido ya salió de
          // PENDIENTE_CONFIRMACION. NO es fallo — verificamos con un GET y, si
          // está PENDIENTE o más adelante (no cancelado/borrado), lo damos por
          // sincronizado. Evita el loop de retry y el falso "falló" en el panel.
          let alreadyConfirmed = false;
          if (!r.ok && isAlreadyConfirmedSignal(r.error || "")) {
            try {
              const chk = await dropiGetOrder(cfg.base, cfg.apiKey, cfg.storeUrl, ord.external_id);
              if (chk.ok) {
                const st = String(
                  (chk.body?.objects ?? chk.body?.data ?? chk.body?.order ?? chk.body ?? {} as Record<string, unknown>)
                    ?.status ?? "",
                ).toUpperCase();
                if (st && !PRE_O_MUERTO_RE.test(st)) alreadyConfirmed = true;
              }
            } catch (e) {
              console.warn(`dropi-cron: verify 'ya confirmado' de #${ord.external_id} falló:`, e instanceof Error ? e.message : e);
            }
            await sleep(RATE_LIMIT_MS);
          }
          if (r.ok || alreadyConfirmed) {
            retryOk++;
            await sb.from("order_results").update({
              dropi_sync_status: "synced",
              result_notes: null,
            }).eq("id", row.id);
          } else {
            retryFail++;
            await sb.from("order_results").update({
              // Normaliza los 'pending' atascados: tras el primer reintento
              // fallido la fila queda 'failed' (visible en el panel y en todos
              // los filtros downstream). No-op para las que ya eran 'failed'.
              dropi_sync_status: "failed",
              result_notes: buildRetryFailureNotes(
                "Reintento dropi-cron", prevAttempts + 1, r.httpStatus, r.error || "",
              ),
            }).eq("id", row.id);
          }
          // Mismo espaciado que el resto del cron (antes 500ms = 2 req/s,
          // por encima del ~1 req/s que tolera Dropi).
          await sleep(RATE_LIMIT_MS);
        }
        console.log(`dropi-cron: retry confirmaciones failed → ${retryOk} OK / ${retryFail} aún fallan / ${retryDeferred} pospuestos por throttle`);
      }
    } catch (err) {
      console.warn("dropi-cron retry-failed exception:", err);
    }

    // Reintento de CANCELACIONES cuyo push a Dropi falló (result='canc',
    // dropi_sync_status='failed' — markCancelFailure del cliente). Mismo patrón
    // que el retry de conf: ventana 7 días, máx 20 por corrida, backoff 429 por
    // tienda y CAP anti-eterno BOT-SIN-API. A diferencia del conf (PUT de
    // integración con api_key), acá se reusa el MISMO núcleo del mode:"cancel"
    // de dropi-change-carrier (cancelOrderInDropi: PUT web CANCELADO →
    // fantasma GET 404 → rechazo), que necesita session token web fresco por
    // tienda (ensureFreshSessionToken). Si el login de una tienda falla, se
    // saltean SUS filas esta corrida (el próximo tick reintenta).
    try {
      const retryFrom = new Date();
      retryFrom.setUTCDate(retryFrom.getUTCDate() - 7);
      const retryFromStr = retryFrom.toISOString().split("T")[0];
      const { data: cancRows } = await sb
        .from("order_results")
        .select("id, order_id, reason, result_notes")
        .eq("result", "canc")
        // 'failed' + 'pending' atascado (ver retryStatusFilter).
        .or(retryStatusFilter())
        .gte("result_date", retryFromStr)
        // CAP anti-eterno: filas marcadas BOT-SIN-API no se reintentan más.
        .or(NOT_BOT_FILTER)
        .limit(20);
      if (cancRows && cancRows.length > 0) {
        const cancOrderIds = (cancRows as Array<{ order_id: string }>).map((r) => r.order_id);
        const { data: ordersForCancel } = await sb
          .from("orders").select("id, external_id, store_id, estado").in("id", cancOrderIds);
        const cancOrderById = new Map<string, { external_id: string | null; store_id: string; estado: string | null }>();
        (ordersForCancel || []).forEach((o: { id: string; external_id: string | null; store_id: string; estado: string | null }) => {
          cancOrderById.set(o.id, { external_id: o.external_id, store_id: o.store_id, estado: o.estado });
        });
        // Config + session token fresco por tienda, UNA sola vez por corrida.
        // null = tienda salteada (login falló / sin credenciales) — como pide el
        // patrón del mode:cancel, si ensureFreshSessionToken no puede entrar,
        // esa tienda no se toca en esta corrida.
        const cancelCfgByStore = new Map<string, StoreDropiConfig | null>();
        // Mismo backoff 429 por tienda que el retry de conf: tiendas que ESTA
        // corrida ya vio throttleadas ni se intentan.
        const cancelThrottled = new Set<string>(
          perStore.filter((p) => p.throttled === true).map((p) => String(p.store_id)),
        );
        // Misma gracia de +20s del retry de conf sobre el deadline global.
        const cancelDeadline = globalDeadline + 20_000;
        let cancOk = 0, cancFail = 0, cancDeferred = 0, cancSkipped = 0;
        for (const row of cancRows as Array<{ id: string; order_id: string; reason: string | null; result_notes: string | null }>) {
          if (Date.now() > cancelDeadline) break;
          // Cinturón extra por si el filtro .or() del select no excluyó la fila.
          if (String(row.result_notes || "").startsWith(BOT_NOTES_PREFIX)) continue;
          const ord = cancOrderById.get(row.order_id);
          if (!ord || !ord.external_id) continue;
          // Fila OBSOLETA (mismo guard que el retry de conf, 2026-07-13): la
          // orden local ya está REEMPLAZADA/RECHAZADA (stub superado) — no hay
          // nada que cancelar en Dropi. Terminal sin gastar requests. OJO: acá
          // NO se incluye CANCELADO (ese es justamente el estado objetivo del
          // cancel local; la fila puede seguir failed porque Dropi no lo tiene).
          if (ord.estado && /REEMPLAZAD|RECHAZAD/i.test(String(ord.estado))) {
            await sb.from("order_results").update({
              dropi_sync_status: "failed",
              result_notes: (BOT_NOTES_PREFIX +
                `orden local ${ord.estado} (stub superado) — cancelación obsoleta, no se reintenta más.`).slice(0, 500),
            }).eq("id", row.id);
            continue;
          }
          const sid = String(ord.store_id);
          if (cancelThrottled.has(sid)) { cancDeferred++; continue; }

          let storeCfg = cancelCfgByStore.get(sid);
          if (storeCfg === undefined) {
            try {
              const loaded = await loadStoreConfig(sb, sid);
              if (!loaded.apiKey) throw new Error("tienda sin Clave API de Dropi");
              loaded.sessionToken = await ensureFreshSessionToken(sb, loaded);
              storeCfg = loaded;
            } catch (e) {
              console.warn(
                `dropi-cron: cancel-retry — credenciales/login fallaron para la tienda ${sid}, se saltea esta corrida:`,
                e instanceof Error ? e.message : e,
              );
              storeCfg = null;
            }
            cancelCfgByStore.set(sid, storeCfg);
          }
          if (!storeCfg) { cancSkipped++; continue; }

          const prevAttempts = parseRetryAttempts(row.result_notes);
          let res: CancelOrderResult;
          try {
            res = await cancelOrderInDropi(storeCfg, sb, {
              externalId: ord.external_id,
              orderId: row.order_id,
              storeId: sid,
              reason: String(row.reason || ""),
            });
          } catch (e) {
            // cancelOrderInDropi no debería lanzar por fallos de Dropi, pero un
            // error inesperado no debe tumbar el resto de la cola.
            res = {
              ok: false, code: "dropi_rejected", dropiStatus: 0,
              error: (e instanceof Error ? e.message : String(e)).slice(0, 300),
            };
          }

          if (res.ok) {
            cancOk++;
            await sb.from("order_results").update({
              dropi_sync_status: "synced",
              result_notes: "cancel reintentado ok por cron" +
                ("dropiMissing" in res && res.dropiMissing
                  ? " (la orden ya no existía en Dropi — cancelada local)"
                  : ""),
            }).eq("id", row.id);
          } else if (res.dropiStatus === 429) {
            // 429 → posponer los retries de ESA tienda; el contador "(intento N)"
            // se conserva para no resetear el CAP.
            cancelThrottled.add(sid);
            cancDeferred++;
            await sb.from("order_results").update({
              result_notes: "Reintento de cancelación pospuesto: Dropi throttled (429)" +
                (prevAttempts > 0 ? ` (intento ${prevAttempts})` : ""),
            }).eq("id", row.id);
          } else {
            // ¿YA está muerta en Dropi? (cancelada a mano en el panel, por otro
            // camino, o reemplazada): Dropi rechaza el PUT CANCELADO sobre una
            // orden ya cancelada ("Error al actualizar la orden...") y la fila
            // quedaba failed ETERNA aunque la meta (que no se despache) ya está
            // cumplida. Verificación web (v2) → muerta = éxito idempotente.
            // Caso real: #6107398 (Fausto) cancelada 2026-07-13 y su fila de
            // retry seguía gritando en el panel de fallos.
            let deadEstado: string | null = null;
            try {
              const live = await checkOrderLivenessWeb(storeCfg, ord.external_id);
              if (live.state === "dead") deadEstado = live.estado || "CANCELADO";
            } catch (e) {
              console.warn(`dropi-cron: verify 'ya cancelada' de #${ord.external_id} falló:`, e instanceof Error ? e.message : e);
            }
            if (deadEstado) {
              cancOk++;
              await sb.from("order_results").update({
                dropi_sync_status: "synced",
                result_notes: `verificada ${deadEstado} en Dropi (v2) — nada pendiente`,
              }).eq("id", row.id);
            } else {
              cancFail++;
              await sb.from("order_results").update({
                // Normaliza los 'pending' atascados (mismo motivo que en conf).
                dropi_sync_status: "failed",
                result_notes: buildRetryFailureNotes(
                  "Reintento de cancelación dropi-cron", prevAttempts + 1, res.dropiStatus, res.error || "",
                ),
              }).eq("id", row.id);
            }
          }
          // Mismo espaciado que el resto del cron.
          await sleep(RATE_LIMIT_MS);
        }
        console.log(
          `dropi-cron: retry cancelaciones failed → ${cancOk} OK / ${cancFail} aún fallan / ${cancDeferred} pospuestos por throttle / ${cancSkipped} sin credenciales`,
        );
      }
    } catch (err) {
      console.warn("dropi-cron cancel-retry exception:", err);
    }

    // Resolver PARES stub+reenvío del bot de Dropi (auditoría 2026-07-12).
    // El bot deja un STUB (invisible para el panel y para TODAS las superficies
    // por-id — el GET de integración da 404) y Dropi crea el pedido REAL con
    // otro id, mismo teléfono. El stub queda PENDIENTE en Guardian y las
    // asesoras lo gestionan en vano (conf/canc/edición mueren contra la API).
    //
    // CLASE "HERMANA DESPACHADA" (barrido manual 2026-07-12: 23 stubs así, 21
    // EC + 2 CO): el reenvío REAL casi siempre ya avanzó (GUIA_GENERADA / POR
    // RECOLECTAR / EN TRÁNSITO / NOVEDAD...), así que un pool limitado a
    // PENDIENTE* nunca forma el par y el stub queda pendiente para siempre.
    // Por eso el pool son TODOS los estados NO terminales; el candidato a
    // retirar sigue siendo únicamente el MÁS VIEJO del grupo y SOLO si él mismo
    // está en PENDIENTE / PENDIENTE CONFIRMACION — un "más viejo" con guía es
    // un pedido real: nunca retirar algo despachado.
    //
    // Al MÁS VIEJO se le hace el GET de integración; SOLO si da la señal 404
    // (stub confirmado — un cliente con 2 compras reales NO la da) se marca
    // REEMPLAZADA local (excluida de colas y métricas, PR #111).
    // Verificado 2026-07-13: la marca sobrevive a las corridas del cron (el
    // stub no reaparece en la ventana del sync porque su estado nunca cambia);
    // si Dropi lo re-listara vivo, el upsert lo resucita solo (auto-corrección,
    // mismo principio que el fantasma-cancel). Máx 5 checks por corrida.
    try {
      const activesFrom = new Date();
      activesFrom.setUTCDate(activesFrom.getUTCDate() - 4);
      const { data: actives } = await sb
        .from("orders")
        .select("id, external_id, phone, store_id, created_at, estado")
        // Todos los NO terminales (sintaxis PostgREST de not-in: los valores
        // con espacios van entre comillas dobles dentro del paréntesis).
        .not("estado", "in", '("CANCELADO","ENTREGADO","REEMPLAZADA","DEVOLUCION","DEVOLUCION EN CAMINO","NOVEDAD SOLUCIONADA","RECHAZADO")')
        .gte("created_at", activesFrom.toISOString())
        .limit(500);
      type ParRow = { id: string; external_id: string | null; phone: string | null; store_id: string; created_at: string; estado: string | null };
      const porTel = new Map<string, ParRow[]>();
      for (const o of (actives || []) as ParRow[]) {
        const digits = String(o.phone || "").replace(/\D/g, "");
        if (digits.length < 7) continue;
        const key = `${o.store_id}:${digits.slice(-9)}`;
        const arr = porTel.get(key) || [];
        arr.push(o);
        porTel.set(key, arr);
      }
      const pairCfgByStore = new Map<string, StoreDropiConfig | null>();
      let pairChecks = 0;
      let stubsResueltos = 0;
      for (const grupo of porTel.values()) {
        if (grupo.length < 2) continue;
        if (pairChecks >= 5) break;
        // El más viejo por external_id numérico (Dropi autoincrementa); fallback created_at.
        const ordenados = [...grupo].sort((a, b) => {
          const na = Number(a.external_id), nb = Number(b.external_id);
          if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
          return String(a.created_at).localeCompare(String(b.created_at));
        });
        const viejo = ordenados[0];
        // Guard hermana-despachada: solo un "más viejo" AÚN pendiente puede ser
        // stub retirable. Si ya tiene guía / avanzó de estado, es un pedido
        // real (cliente con 2 compras, reenvío legítimo, etc.) → skip.
        if (viejo.estado !== "PENDIENTE" && viejo.estado !== "PENDIENTE CONFIRMACION") continue;
        if (!viejo.external_id) continue;
        const sidPar = String(viejo.store_id);
        let cfgPar = pairCfgByStore.get(sidPar);
        if (cfgPar === undefined) {
          try {
            const loaded = await loadStoreConfig(sb, sidPar);
            cfgPar = loaded.apiKey ? loaded : null;
          } catch {
            cfgPar = null;
          }
          pairCfgByStore.set(sidPar, cfgPar);
        }
        if (!cfgPar) continue;
        pairChecks++;
        try {
          const check = await dropiGetOrder(cfgPar.base, cfgPar.apiKey, cfgPar.storeUrl, viejo.external_id);
          if (!check.ok && notFoundSignal(check.httpStatus, check.body)) {
            await sb.from("orders").update({ estado: "REEMPLAZADA" }).eq("id", viejo.id);
            stubsResueltos++;
            console.log(
              `dropi-cron: par stub+reenvío — stub #${viejo.external_id} → REEMPLAZADA (grupo de ${grupo.length}, tel …${String(viejo.phone || "").slice(-4)})`,
            );
          }
        } catch (e) {
          console.warn(`dropi-cron: check de stub #${viejo.external_id} falló:`, e instanceof Error ? e.message : e);
        }
        await sleep(RATE_LIMIT_MS);
      }
      if (stubsResueltos > 0) {
        console.log(`dropi-cron: ${stubsResueltos} stubs de bot retirados de la cola (pares resueltos)`);
      }
    } catch (err) {
      console.warn("dropi-cron pares stub+reenvío exception:", err);
    }

    // Cancelar pedidos huérfanos (global).
    try {
      const { data, error: cancelOrphanError } = await sb.rpc("cancel_orphan_pending_orders");
      if (cancelOrphanError) console.warn("cancel_orphan_pending_orders error:", cancelOrphanError.message);
      else if (((data as number) || 0) > 0) console.log(`Cancelados ${data} pedidos huérfanos`);
    } catch (err) {
      console.warn("cancel_orphan_pending_orders exception:", err);
    }

    console.log(`dropi-cron: Done — ${grandSynced} synced / ${grandTotal} from Dropi, ${activeConfigs.length} tiendas`);
    return new Response(
      JSON.stringify({ stores: activeConfigs.length, synced: grandSynced, total: grandTotal, range: `${from} → ${to}`, perStore }),
      { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("dropi-cron error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Error interno" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});

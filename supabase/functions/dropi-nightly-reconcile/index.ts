// dropi-nightly-reconcile: corre 1x al día (3am UTC) y reconcilia TODAS las
// tiendas activas contra Dropi. Backstop diario: aunque el cron de 5min falle
// silenciosamente, máximo 24h después el estado queda alineado.
//
// Algoritmo por tienda:
//   1. Pull no-terminales de Guardian (últimos 30d)
//   2. Pull rango 30d de Dropi vía integrations (por fecha de cambio de estatus)
//   3. Cross-reference: diff de estado/guia/transportadora
//   4. UPDATE divergencias (idempotente vía upsert_orders_from_dropi)
//   5. Marcar huérfanos pre-backfill (external_id < 5M) como CANCELADO
//   6. Detectar BORRADOS en Dropi (id >= 5M): 2do pull por FECHA DE CREADO; si
//      vino COMPLETO, todo huérfano ausente de él (y >=48h) → CANCELADO
//   7. INSERT log en nightly_reconcile_results
//
// Auth: x-cron-secret o service-role.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { dropiHostFor } from "../_shared/dropiHosts.ts";
import { mapDropiOrderToRow } from "../_shared/dropiOrderMapper.ts";
import {
  planRepesca, decidirArchivado, REPESCA_FROZEN_DAYS, type RepescaRow,
} from "../_shared/reconcileRepesca.ts";

const PAGE_SIZE = 100;
const RATE_LIMIT_MS = 1500;
const RECONCILE_DAYS_BACK = 30;

// Paginado del lado de GUARDIAN (PostgREST), que es OTRO límite distinto al de
// arriba: `PAGE_SIZE` es de la API de Dropi, que rechaza result_number > 100.
// PostgREST corta en 1000 por defecto, así que 1000 es una página entera.
//
// Estas dos constantes se USABAN sin estar declaradas desde el 31-jul-2026
// (commit dbadf0d, que agregó el paginado): la función reventaba con
// "GUARDIAN_PAGE_SIZE is not defined" apenas llegaba al bucle, en las dos
// tiendas. Falló la noche del 1-ago y la agarró el badge de /logistica.
const GUARDIAN_PAGE_SIZE = 1000;
// Tope de seguridad contra un bucle desbocado. Ecuador ronda los 2.700 pedidos
// en 30 días, así que 20.000 deja muchísimo aire y sigue estando acotado. Si se
// alcanza, la función lo AVISA por consola en vez de callarse: el set quedaría
// incompleto y sobre él se decide qué cancelar.
const GUARDIAN_MAX_ROWS = 20000;
const TERMINAL_STATES = new Set([
  "ENTREGADO", "CANCELADO", "DEVOLUCION", "DEVUELTO",
  "DEVOLUCIÓN", "ENTREGADA", "CANCELADA",
  // RECHAZADO es final (el cliente rechazó en la puerta): NO es un fantasma
  // pendiente. Sin esto, un RECHAZADO viejo (cambio de estado hace meses) no
  // aparece en el pull por FECHA DE CAMBIO DE ESTATUS y el nightly lo cancelaba
  // → distorsiona la tasa de rechazo (RECHAZADO=despachado, CANCELADO=no). Caso
  // real: 4 pedidos EC id~4.3M en ping-pong nightly↔cron el 2026-07-03.
  "RECHAZADO", "RECHAZADA",
  // REEMPLAZADA/ARCHIVADO GHOST son soft-deletes de Guardian (orden vieja de una
  // edición estilo Dropi): ya son terminales. Sin esto el nightly las trataría
  // como no-terminales y podría flipearlas a CANCELADO (churn + ruido en
  // cancelled_external_ids). Auditoría EC 2026-07-07.
  "REEMPLAZADA", "ARCHIVADO GHOST", "ARCHIVADO_GHOST",
]);
const ORPHAN_THRESHOLD = 5000000; // external_ids < 5M son de backfill viejo — SOLO Rushmira
// La rama "huérfano <5M → cancelar directo" codifica HISTORIA de las cuentas
// Rushmira (CO/EC): sus ids ya van en 7-8 dígitos y todo id<5M es backfill de
// abr-may 2026. Pero el umbral NO es una propiedad de Dropi: cada plataforma de
// país tiene su propia secuencia, y una cuenta JOVEN (GT o cualquier tienda
// nueva) arranca con ids BAJOS — sin este guard, TODOS sus pedidos caían en la
// cancelación directa (sin el guard de 48h ni el barrido por FECHA DE CREADO)
// → cancelaciones masivas erróneas (auditoría 2026-08-13; esta rama ya produjo
// 2 incidentes reales incluso dentro de Rushmira, ver comentarios más abajo).
// Toda tienda FUERA de esta lista trata a sus huérfanos con el camino protegido.
const LEGACY_BACKFILL_STORES = new Set([
  "00000000-0000-0000-0000-000000000001", // Rushmira Colombia
  "512309c3-d5b7-4434-898a-31bed51dcd4d", // Rushmira Ecuador
]);
// FIX 2026-07-03 (fantasmas de pedidos BORRADOS en Dropi): Dropi permite ELIMINAR
// pedidos y esos quedan para siempre no-terminales en Guardian (LucidBot duplica,
// el dueño los borra a mano en Dropi → mayo=9, junio=42, julio ~27). El chequeo
// anterior (GET de detalle uno-por-uno) lo tumbaba el rate-limit de Dropi EC →
// cancelaba 0 SIEMPRE (verificado: nightly_reconcile_results.orphan_cancelled=0).
// Ahora la baja se detecta por un BARRIDO COMPLETO por FECHA DE CREADO: si el pull
// vino completo, todo huérfano id>=5M / >=48h ausente de él fue eliminado (ver
// reconcileStore). Auto-reversible: si se equivoca, el cron de 5min lo restaura.
const EXISTENCE_CHECK_MIN_AGE_MS = 48 * 3600 * 1000; // no tocar pedidos de <48h (lag de sync)

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

/** Baja un rango de Dropi paginado. Devuelve los pedidos Y un flag `complete`:
 *  `true` SOLO si paginó hasta el final del rango sin ningún error HTTP definitivo.
 *  Cada page reintenta hasta 3 veces con backoff (2s/4s/8s, mismo patrón que
 *  dropi-snapshot) — sin esto la cuenta EC casi nunca lograba un pull completo
 *  y el fail-safe dejaba los fantasmas para siempre. Si aun con backoff un page
 *  falla, corta y `complete=false` → el llamador NO debe concluir "borrado".
 *
 *  `stopBeforeDate` (corte temprano, 2026-07-03): Dropi EC IGNORA date_from/
 *  date_to en este endpoint (verificado: pull "30 días" devolvió 2100 pedidos =
 *  la cuenta entera, y el throttle lo mataba antes de terminar → nunca complete).
 *  Como viene orderBy=id desc (≈ creación desc), cuando el pedido más viejo del
 *  page ya es anterior a la ventana, TODO lo que falta es más viejo → ya tenemos
 *  el superset completo de la ventana → complete=true y paramos. MAX_PAGES es el
 *  freno de mano si ni eso corta. */
const MAX_PAGES = 40;

async function fetchDropiRange(
  base: string,
  apiKey: string,
  origin: string,
  from: string,
  to: string,
  statusFilter: string,
  stopBeforeDate?: string,
  // Corte temprano por ID (anti-throttle 2026-07-07): como viene orderBy=id
  // desc, cuando el id más viejo de la página ya es menor que el menor id que
  // el caller necesita cruzar, todo lo restante es más viejo → el pull es
  // EQUIVALENTE al completo para sus usos (divergencias + ausencia) →
  // complete=true. Aparte de stopBeforeDate (NO reusar la fecha en el pull por
  // estatus: cortaría por created_at en un pull filtrado por cambio-de-estatus
  // y perdería pedidos viejos con estatus recién cambiado).
  stopBeforeId?: number,
): Promise<{ orders: Record<string, unknown>[]; complete: boolean }> {
  const out: Record<string, unknown>[] = [];
  let start = 0;
  let pages = 0;
  let complete = false;
  const filterParam = statusFilter ? `&filter_date_by=${encodeURIComponent(statusFilter)}` : "";
  while (pages < MAX_PAGES) {
    const url = `${base}/integrations/orders/myorders?result_number=${PAGE_SIZE}&start=${start}&date_from=${from}&date_to=${to}${filterParam}&orderBy=id&orderDirection=desc`;
    let res: Response | null = null;
    let data: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await sleep(2000 * Math.pow(2, attempt - 1)); // 2s/4s/8s
      res = await fetch(url, {
        headers: {
          "Accept": "application/json",
          "dropi-integration-key": apiKey,
          ...(origin ? { Origin: origin } : {}),
        },
      }).catch(() => null);
      if (res?.ok) {
        data = await res.json().catch(() => null) as Record<string, unknown> | null;
        if (data && data.isSuccess !== false) break;
        // Dropi responde 200 con {isSuccess:false} ante un error de SU lado
        // (mantenimiento, query inválida). Tomarlo como fin-de-datos dejaba
        // `complete=true` con un pull VACÍO o truncado, y ese flag es justo el
        // gate que habilita cancelar huérfanos en bloque y archivar GHOST
        // pedidos vivos. Es una página FALLIDA: se reintenta, y si agota se
        // corta con complete=false.
        console.warn(`reconcile: 200 con isSuccess=false at start=${start} (intento ${attempt + 1}/4)`);
        data = null;
        continue;
      }
      console.warn(`reconcile: HTTP ${res?.status ?? "fetch-fail"} at start=${start} (intento ${attempt + 1}/4)`);
      // Anti-throttle 2026-07-07: un 4xx definitivo (400/401/403/404 ≠ 429) no
      // se cura reintentando — cortar sin quemar 3 fetches + ~14s contra una
      // api_key revocada. 429 y TODO 5xx (el Laravel de Dropi tira 500
      // transitorios) sí se reintentan, igual que fetch-fail (res null).
      if (res && res.status >= 400 && res.status < 500 && res.status !== 429) break;
    }
    if (!res?.ok || !data) {
      console.warn(`reconcile: page start=${start} agotó reintentos (pull INCOMPLETO)`);
      break; // complete queda false
    }
    const objs = Array.isArray(data.objects) ? data.objects as Record<string, unknown>[] : [];
    out.push(...objs);
    pages++;
    if (objs.length < PAGE_SIZE) { complete = true; break; } // último page → pull completo
    if (stopBeforeDate && objs.length > 0) {
      const oldest = String((objs[objs.length - 1] as Record<string, unknown>).created_at || "");
      if (oldest && oldest.split("T")[0] < stopBeforeDate) { complete = true; break; }
    }
    if (stopBeforeId !== undefined && objs.length > 0) {
      const oldestId = Number((objs[objs.length - 1] as Record<string, unknown>).id);
      // Comparación estricta <; si el id no parsea, NO cortar (fail-safe).
      if (Number.isFinite(oldestId) && oldestId < stopBeforeId) { complete = true; break; }
    }
    start += PAGE_SIZE;
    await sleep(RATE_LIMIT_MS);
  }
  if (pages >= MAX_PAGES) console.warn(`reconcile: MAX_PAGES (${MAX_PAGES}) alcanzado sin cerrar el rango (pull INCOMPLETO)`);
  return { orders: out, complete };
}

interface GuardianRow {
  id: string;
  external_id: string | null;
  estado: string | null;
  guia: string | null;
  transportadora: string | null;
  last_movement_at: string | null;
  created_at: string | null;
  fecha: string | null;
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
): Promise<{
  divergent: number; applied: number; orphanCancelled: number; deletedCancelled: number;
  deletedCheckComplete: boolean | null; dropiCreatedCount: number | null;
  cancelledIds: { orphans: string[]; deleted: string[] };
  /** Fantasmas rezagados (fuera de la ventana de 30d) archivados esta corrida. */
  repescaArchivados: number;
  /** Qué decidió la repesca y por qué. `null` = no había rezagados que mirar.
   *  Se guarda aparte del contador: "0 archivados porque el barrido vino
   *  truncado" y "0 archivados porque no había fantasmas" son cosas distintas. */
  repescaMotivo: string | null;
  error?: string;
}> {
  try {
    const today = new Date();
    const to = today.toISOString().split("T")[0];
    const fromD = new Date(today);
    fromD.setUTCDate(fromD.getUTCDate() - RECONCILE_DAYS_BACK);
    const from = fromD.toISOString().split("T")[0];

    // PAGINADO OBLIGATORIO: PostgREST corta en 1000 filas por defecto y EC pasa
    // los 2700 pedidos en 30 días — sin esto el "backstop diario" reconciliaba
    // un subconjunto ARBITRARIO (~35%) y el resto quedaba con guías y estados
    // congelados semanas, sin ninguna señal. El .order('id') es lo que hace
    // determinista el rango entre páginas.
    const guardianRows: GuardianRow[] = [];
    for (let offset = 0; ; offset += GUARDIAN_PAGE_SIZE) {
      const { data: page, error: pageErr } = await sb
        .from("orders")
        .select("id, external_id, estado, guia, transportadora, last_movement_at, created_at, fecha")
        .eq("store_id", storeId)
        .not("external_id", "is", null)
        .gte("upload_date", from)
        .order("id", { ascending: true })
        .range(offset, offset + GUARDIAN_PAGE_SIZE - 1);
      // Una página que falla deja el set INCOMPLETO, y sobre ese set se decide
      // qué cancelar: cortar con error en vez de reconciliar a ciegas.
      if (pageErr) throw new Error(`lectura de orders paginada falló en offset=${offset}: ${pageErr.message}`);
      const rows = (page || []) as GuardianRow[];
      guardianRows.push(...rows);
      if (rows.length < GUARDIAN_PAGE_SIZE) break;
      if (guardianRows.length >= GUARDIAN_MAX_ROWS) {
        console.warn(`reconcile ${storeId}: tope de ${GUARDIAN_MAX_ROWS} filas alcanzado — set posiblemente incompleto`);
        break;
      }
    }
    // El filtro de terminales queda client-side (no en la query): un
    // `.not('estado','in',(...))` descartaría además las filas con estado NULL
    // —que SÍ hay que reconciliar— porque en SQL `NULL NOT IN (...)` es NULL.
    const guardianNonTerminal: GuardianRow[] = guardianRows.filter((o: GuardianRow) => {
      const e = (o.estado || "").toUpperCase();
      return !TERMINAL_STATES.has(e);
    });
    const emptyIds = { orphans: [] as string[], deleted: [] as string[] };
    if (guardianNonTerminal.length === 0) {
      return { divergent: 0, applied: 0, orphanCancelled: 0, deletedCancelled: 0, deletedCheckComplete: null, dropiCreatedCount: null, cancelledIds: emptyIds };
    }

    const base = dropiHostFor(countryCode);
    // Corte temprano por ID: en EC (que ignora date_from/date_to y tiene >4k
    // pedidos) el status pull agotaba MAX_PAGES=40 TODAS las noches → nunca
    // complete=true → la limpieza de huérfanos <5M llevaba PERMANENTEMENTE
    // anulada por el fail-safe. El pull solo alimenta el cruce contra
    // guardianNonTerminal: cortar cuando ya pasamos su id más viejo es
    // equivalente al pull completo.
    const guardianIdNums = guardianNonTerminal.map((g) => Number(g.external_id)).filter(Number.isFinite);
    const statusStopId = guardianIdNums.length ? Math.min(...guardianIdNums) : undefined;
    const statusPull = await fetchDropiRange(base, apiKey, storeUrl, from, to, statusFilter, undefined, statusStopId);
    const dropiMap = new Map<string, Record<string, unknown>>();
    for (const o of statusPull.orders) {
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
        // original). Post-backfill (id >= 5M, >=48h) → candidato: puede haber sido
        // ELIMINADO en Dropi, o solo no entrar al pull por status-filter. Lo decide
        // el barrido COMPLETO por FECHA DE CREADO más abajo (ausente = eliminado).
        //
        // GUARD CRÍTICO (2026-07-03): el candidato exige `fecha` (creación en
        // Dropi) DENTRO de la ventana del barrido. Sin esto, un pedido viejo cuyo
        // upload_date se re-bumpeó (re-sync) entra al set de Guardian, pero un pull
        // "creados en [from,to]" jamás lo va a traer → se cancelaba por una
        // inferencia inválida (pasó en la 1ra corrida: 24 pedidos CO de abr/may).
        const extNum = Number(ext);
        // La rama de cancelación directa SOLO aplica a las tiendas legacy con
        // backfill real <5M (Rushmira). Una tienda nueva con ids bajos trata a
        // TODOS sus huérfanos como candidatos (48h + ventana + barrido).
        if (Number.isFinite(extNum) && extNum < ORPHAN_THRESHOLD && LEGACY_BACKFILL_STORES.has(storeId)) {
          orphans.push(g);
        } else if (Number.isFinite(extNum)) {
          const ageMs = g.created_at ? Date.now() - new Date(g.created_at).getTime() : 0;
          const fechaEnVentana = !!g.fecha && g.fecha >= from && g.fecha <= to;
          if (ageMs >= EXISTENCE_CHECK_MIN_AGE_MS && fechaEnVentana) existenceCandidates.push(g);
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

    const cancelledIds = { orphans: [] as string[], deleted: [] as string[] };
    let orphanCancelled = 0;
    // GATE (2026-07-03): si el pull por status vino INCOMPLETO (throttle), "no
    // está en el pull" no prueba nada — sin este gate 4 pedidos <5M vivos en
    // Dropi entraban en ping-pong (nightly cancela ↔ cron restaura, 2 veces el
    // mismo día, ver cancelled_external_ids 19:12 y 20:01 del 2026-07-03).
    // El `orders.length > 0` es el MISMO guard que ya exige el barrido de
    // borrados: un pull que volvió vacío no prueba que los huérfanos no existan
    // en Dropi — prueba que no trajimos nada. Sin él, una noche rara (Dropi
    // devolviendo 0 sin error) cancelaba en bloque todo lo no-terminal <5M.
    if ((!statusPull.complete || statusPull.orders.length === 0) && orphans.length > 0) {
      console.warn(`reconcile ${storeId}: pull por status no confiable (complete=${statusPull.complete}, n=${statusPull.orders.length}) → ${orphans.length} huérfanos <5M NO se cancelan (fail-safe)`);
      orphans.length = 0;
    }
    if (orphans.length > 0) {
      for (let i = 0; i < orphans.length; i += 50) {
        const batch = orphans.slice(i, i + 50);
        const { error } = await sb.from("orders").update({ estado: "CANCELADO" }).in("id", batch.map(o => o.id));
        if (!error) {
          orphanCancelled += batch.length;
          cancelledIds.orphans.push(...batch.map(o => String(o.external_id)));
        }
      }
    }

    // Detección de BORRADOS en Dropi por BARRIDO COMPLETO (reemplaza el GET
    // uno-por-uno que el rate-limit de Dropi EC tumbaba → cancelaba 0). Segundo
    // pull por FECHA DE CREADO (fecha estable: todo pedido creado en la ventana
    // vuelve, no importa su estado). Si el pull vino COMPLETO, cualquier huérfano
    // id>=5M / >=48h ausente de él fue ELIMINADO. Si vino incompleto (throttle) o
    // vacío → NO se cancela nada esta corrida (fail-safe).
    let deletedCancelled = 0;
    let deletedCheckComplete: boolean | null = null;
    let dropiCreatedCount: number | null = null;
    if (existenceCandidates.length > 0) {
      await sleep(5000); // pausa entre los dos pulls — le da aire al rate-limit EC
      // stopBeforeDate=from: EC ignora date_from/date_to → sin corte temprano
      // paginaría la cuenta entera y el throttle lo mataría antes de completar.
      // + corte por ID (mismo argumento que el status pull): el createdSet solo
      // se cruza contra existenceCandidates.
      const candidateIdNums = existenceCandidates.map((g) => Number(g.external_id)).filter(Number.isFinite);
      const createdStopId = candidateIdNums.length ? Math.min(...candidateIdNums) : undefined;
      const createdPull = await fetchDropiRange(base, apiKey, storeUrl, from, to, "FECHA DE CREADO", from, createdStopId);
      deletedCheckComplete = createdPull.complete && createdPull.orders.length > 0;
      dropiCreatedCount = createdPull.orders.length;
      if (deletedCheckComplete) {
        const createdSet = new Set(createdPull.orders.map((o) => String(o.id)));
        const deleted = existenceCandidates.filter((g) => !createdSet.has(String(g.external_id)));
        for (let i = 0; i < deleted.length; i += 50) {
          const batch = deleted.slice(i, i + 50);
          // 'ARCHIVADO GHOST', NO 'CANCELADO' (fix 2026-07-21).
          //
          // Un pedido BORRADO en Dropi no es una cancelación del cliente, pero
          // marcarlo CANCELADO lo metía en la tasa de cancelación. Efecto real:
          // en julio EC, Guardian mostraba 250 cancelados contra los 154 del
          // informe de Dropi — 22,5% vs 19,87% — y el dueño dejó de confiar en
          // el número. Los 96 de diferencia eran ESTOS.
          //
          // 'ARCHIVADO GHOST' (con ESPACIO) es la escritura que reconoce
          // `_estado_bucket` en SQL → bucket 'borrado' → excluido de TODAS las
          // RPCs de logística. Con guion bajo NO lo excluye: no cambiar.
          const { error } = await sb.from("orders").update({ estado: "ARCHIVADO GHOST" }).in("id", batch.map(g => g.id));
          if (!error) {
            deletedCancelled += batch.length;
            cancelledIds.deleted.push(...batch.map(g => String(g.external_id)));
          }
        }
        console.log(`reconcile ${storeId}: barrido creación COMPLETO (${createdPull.orders.length} pedidos); ${deleted.length} huérfanos ELIMINADOS en Dropi → ARCHIVADO GHOST`);
      } else {
        console.warn(`reconcile ${storeId}: barrido por creación NO confiable (complete=${createdPull.complete}, n=${createdPull.orders.length}) → 0 cancelados esta corrida (fail-safe)`);
      }
    }

    // ── REPESCA de rezagados ──────────────────────────────────────────────
    // Todo lo de arriba solo mira los últimos RECONCILE_DAYS_BACK días, y el
    // guard `fechaEnVentana` exige que el pedido caiga DENTRO de esa ventana. El
    // guard es correcto (evitó cancelar 24 pedidos CO buenos en la 1ra corrida),
    // pero deja un agujero permanente: un fantasma que no se detecta en sus
    // primeros 30 días NO se detecta nunca, y cada día se aleja más.
    //
    // Medido el 2026-08-05: 76 pedidos no-terminales congelados fuera de la
    // ventana en las dos tiendas — 49 PENDIENTE en CO por $5.376.049 desde el 15
    // de abril, y en EC hasta pedidos de noviembre de 2025. De los 11 de julio de
    // EC se verificó uno por uno contra la API: los 11 responden "esta guía no
    // existe en nuestro sistema".
    //
    // Se barre UN mes por corrida, el más viejo primero (ver reconcileRepesca.ts):
    // la deuda se salda de a un mes por noche sin darle otro barrido entero al
    // rate-limit de EC, y una vez saldada no dispara ni un request.
    let repescaArchivados = 0;
    let repescaMotivo: string | null = null;
    try {
      const ventanaInicio = from; // los de adentro ya los cubre el barrido de arriba
      const congeladoAntes = new Date(Date.now() - REPESCA_FROZEN_DAYS * 86400000).toISOString();
      const { data: rezagados, error: rezErr } = await sb
        .from("orders")
        .select("id, external_id, estado, fecha, created_at, last_movement_at")
        .eq("store_id", storeId)
        .not("external_id", "is", null)
        .lt("fecha", ventanaInicio)
        .or(`last_movement_at.is.null,last_movement_at.lt.${congeladoAntes}`)
        .order("fecha", { ascending: true })
        .limit(GUARDIAN_PAGE_SIZE);
      if (rezErr) throw new Error(`lectura de rezagados falló: ${rezErr.message}`);

      // El filtro de terminales va client-side por el mismo motivo que arriba:
      // un `.not('estado','in',...)` descartaría también las filas con estado NULL.
      const noTerminales = (rezagados || []).filter(
        (r) => !TERMINAL_STATES.has(String(r.estado || "").toUpperCase()),
      );
      const plan = planRepesca(noTerminales as RepescaRow[], {
        ahoraMs: Date.now(),
        minAgeMs: EXISTENCE_CHECK_MIN_AGE_MS,
      });

      if (plan) {
        await sleep(5000); // aire para el rate-limit, igual que entre los otros pulls
        const pull = await fetchDropiRange(
          base, apiKey, storeUrl, plan.from, plan.to, "FECHA DE CREADO",
          plan.from, plan.stopBeforeId,
        );
        const decision = decidirArchivado(plan, {
          ids: new Set(pull.orders.map((o) => String((o as { id: unknown }).id))),
          complete: pull.complete,
          total: pull.orders.length,
        });
        repescaMotivo = decision.motivo;
        for (let i = 0; i < decision.archivar.length; i += 50) {
          const batch = decision.archivar.slice(i, i + 50);
          // 'ARCHIVADO GHOST' CON ESPACIO — es la escritura que `_estado_bucket`
          // manda al bucket 'borrado'. Con guion bajo NO se excluye y el fantasma
          // vuelve a contaminar los KPIs (misma trampa que la línea 378).
          const { error } = await sb.from("orders")
            .update({ estado: "ARCHIVADO GHOST" })
            .in("id", batch.map((g) => g.id));
          if (!error) {
            repescaArchivados += batch.length;
            cancelledIds.deleted.push(...batch.map((g) => String(g.external_id)));
          }
        }
        console.log(`reconcile ${storeId}: repesca ${plan.yearMonth} — ${repescaMotivo} · quedan ${plan.mesesRestantes} mes(es) rezagados`);
      }
    } catch (err) {
      // La repesca es un extra: si falla, la reconciliación de la ventana normal
      // ya se aplicó y no se pierde. Se registra y se sigue.
      repescaMotivo = `repesca falló: ${err instanceof Error ? err.message : String(err)}`;
      console.warn(`reconcile ${storeId}: ${repescaMotivo}`);
    }

    return { divergent: divergences.length, applied, orphanCancelled, deletedCancelled, deletedCheckComplete, dropiCreatedCount, cancelledIds, repescaArchivados, repescaMotivo };
  } catch (err) {
    return {
      divergent: 0, applied: 0, orphanCancelled: 0, deletedCancelled: 0,
      deletedCheckComplete: null, dropiCreatedCount: null,
      cancelledIds: { orphans: [], deleted: [] },
      repescaArchivados: 0, repescaMotivo: null,
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
    // Requiere migration 20260703190000 (columnas de observabilidad):
    // deleted_check_complete = ¿el barrido de borrados fue confiable esta noche?
    //   true=verificado · false=fail-safe por throttle (¡NO es "todo limpio"!) ·
    //   null=no hubo candidatos que verificar.
    // cancelled_external_ids = auditoría de QUÉ se canceló (sin esto los cancels
    //   del nightly son irrastreables — orders no tiene updated_at).
    const baseLog = {
      store_id: cfg.store_id,
      divergent_count: r.divergent,
      applied_count: r.applied,
      // orphan_cancelled agrega ambos tipos de limpieza (pre-backfill + borrados
      // en Dropi); el desglose exacto va en cancelled_external_ids.
      // La repesca archiva por el MISMO motivo (borrado en Dropi), así que suma
      // acá: si no, el contador diría 0 en una noche que sí limpió rezagados.
      orphan_cancelled: r.orphanCancelled + r.deletedCancelled + r.repescaArchivados,
      error_message: r.error || null,
    };
    const { error: logErr } = await sb.from("nightly_reconcile_results").insert({
      ...baseLog,
      deleted_check_complete: r.deletedCheckComplete,
      dropi_created_count: r.dropiCreatedCount,
      cancelled_external_ids: (r.cancelledIds.orphans.length + r.cancelledIds.deleted.length) > 0 ? r.cancelledIds : null,
    });
    if (logErr) {
      // Migration 20260703190000 aún no aplicada → reintentar con el esquema viejo
      // para no perder el log de la corrida.
      console.warn(`reconcile log insert falló (${logErr.message}); reintento legacy`);
      await sb.from("nightly_reconcile_results").insert(baseLog);
    }
    summary.push({ store_id: cfg.store_id, ...r });
    console.log(`reconcile ${cfg.store_id}: divergent=${r.divergent} applied=${r.applied} orphans=${r.orphanCancelled} deletedInDropi=${r.deletedCancelled} repesca=${r.repescaArchivados} checkComplete=${r.deletedCheckComplete}${r.repescaMotivo ? ` | ${r.repescaMotivo}` : ""}`);
  }

  return new Response(JSON.stringify({ ok: true, summary }), {
    status: 200,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
});

// wa-status-notifier — avisos PROACTIVOS por cambio de estado en Dropi.
//
// Lo dispara pg_cron (~cada 10 min). Para cada tienda con canal WA + bot activo +
// avisos activos, busca pedidos cuyo "bucket" de estado cambió y le manda UN
// aviso (plantilla editable) al cliente. El bot deja de ser solo reactivo: ahora
// escribe primero cuando el pedido se mueve.
//
// SEGURIDAD ANTI-BLAST: la PRIMERA vez que ve un pedido solo guarda baseline en
// wa_order_notifications (sin avisar) → no blastea el histórico. Solo avisa en
// TRANSICIONES posteriores. Pacing de MAX_SENDS_PER_RUN por corrida.
//
// Auth: x-cron-secret === app_settings.cron_shared_secret (igual que dropi-cron).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { loadWaChannel, sendAndRecord, upsertConversation } from "../_shared/waChannel.ts";
import { getTrackingUrl } from "../_shared/waTracking.ts";

const MAX_SENDS_PER_RUN = 40; // pacing anti-baneo (gateway QR no oficial)
const LOOKBACK_DAYS = 21; // solo pedidos movidos recientemente
const ORDERS_PER_STORE = 600;

// Follow-up por SILENCIO: si el bot le escribió a un cliente y este no respondió
// en FOLLOWUP_SILENCE_HOURS (pero la conversación no es más vieja que
// FOLLOWUP_MAX_AGE_HOURS), el bot manda UN recordatorio suave. Una sola vez por
// episodio (lo controla wa_conversations.last_followup_at).
const FOLLOWUP_SILENCE_HOURS = 8;
const FOLLOWUP_MAX_AGE_HOURS = 72;
const FOLLOWUP_CANDIDATES = 80; // candidatos a revisar por tienda y corrida
const ESTADOS_TERMINALES = new Set(["ENTREGADO", "CANCELADO", "ANULADO", "DEVUELTO", "DEVOLUCION"]);

// Franja horaria de avisos PROACTIVOS (hora Bogotá/Quito = UTC-5, sin DST). Fuera
// de esta ventana el cron corre pero NO manda nada (no molestar de madrugada).
// OJO: esto solo afecta los avisos que el bot INICIA. Las respuestas reactivas
// (wa-ai-responder, cuando el cliente escribe) NO se tocan: contesta 24/7.
const SEND_HOUR_START = 8;  // arranca 8:00 am
const SEND_HOUR_END = 21;   // hasta las 9:00 pm (no incluido)
function withinSendHours(): boolean {
  const bogotaHour = (new Date().getUTCHours() - 5 + 24) % 24;
  return bogotaHour >= SEND_HOUR_START && bogotaHour < SEND_HOUR_END;
}

type Bucket = "guia_generada" | "en_camino" | "reparto" | "oficina" | "novedad" | "entregado";

// Taxonomía canónica de estados Dropi. Réplica server-side de src/lib/segLists.ts
// (Deno no puede importar src/, igual que waTracking.ts). Si cambian los estados
// en segLists.ts, actualizar también acá.
const E = (s: string | null | undefined): string => (s || "").toUpperCase().trim();

const ESTADOS_GUIA = new Set([
  "GUIA_GENERADA", "GUIA GENERADA", "ADMITIDA",
  "PREPARADO PARA TRANSPORTADORA", "ENTREGADO A TRANSPORTADORA",
]);

const ESTADOS_TRANSITO = new Set([
  "EN TRANSPORTE", "EN DESPACHO", "EN TRASLADO NACIONAL", "EN TERMINAL ORIGEN",
  "EN TERMINAL DESTINO", "EN DISTRIBUCION", "EN REEXPEDICION", "ENTREGADA A CONEXIONES",
  "TELEMERCADEO", "REENVIO", "REENVÍO", "EN BODEGA TRANSPORTADORA", "EN BODEGA DROPI",
  "EN BODEGA ORIGEN", "BODEGA DESTINO", "RECOGIDO POR DROPI", "DESPACHADA",
  "EN ESPERA DE RUTA DOMESTICA",
]);
const matchTransito = (e: string): boolean =>
  ESTADOS_TRANSITO.has(e) || e.startsWith("EN RUTA") || e.startsWith("INGRESANDO") || e.startsWith("ASIGNADO");

const matchOficina = (e: string): boolean =>
  e.includes("OFICINA") || e.includes("RECLAME") || e.includes("RECLAMAR") ||
  e.includes("EN PUNTO") || e.startsWith("PARA RETIRO") || e.startsWith("RETIRO");

const ESTADOS_NOVEDAD = new Set([
  "NOVEDAD", "INTENTO DE ENTREGA", "RECHAZADO", "DEVUELTO",
  "DEVOLUCION", "DEVOLUCION EN TRANSITO",
]);

/** Mapea el estado canónico de Dropi a un "bucket" de aviso (o null = no avisar). */
function bucketOf(estadoRaw: string): Bucket | null {
  const e = E(estadoRaw);
  if (!e) return null;
  if (e === "ENTREGADO") return "entregado";                       // terminal exacto
  if (e === "NOVEDAD SOLUCIONADA") return null;                    // bueno, no es problema
  if (ESTADOS_NOVEDAD.has(e) || e.includes("DEVOLUC")) return "novedad";
  if (matchOficina(e)) return "oficina";                          // recoge en oficina
  if (e === "EN REPARTO") return "reparto";
  if (matchTransito(e)) return "en_camino";
  if (ESTADOS_GUIA.has(e)) return "guia_generada";               // ya hay guía real
  return null;                                                     // PENDIENTE/ALISTAMIENTO/etc.
}

const DEFAULT_TEMPLATES: Record<Bucket, string> = {
  guia_generada:
    "¡Buenas noticias {nombre}! 📦 Tu pedido de {producto} ya tiene guía y se está preparando con {transportadora}.\nTu número de guía es: {guia}\nLo podés rastrear acá: {link}\nCualquier cosa, acá estoy 💛 — {agente}",
  en_camino:
    "¡Hola {nombre}! 📦 Tu pedido de {producto} ya va en camino con {transportadora}. Lo podés seguir acá: {link}\nCualquier cosa me escribís, acá estoy 💛 — {agente}",
  reparto:
    "¡Hola {nombre}! 🚚 ¡Hoy sale tu pedido a entrega! Tené listo el pago contra entrega de {total}. Apenas llegue el mensajero te lo entrega. ¿Alguna duda? Acá estoy 💛 — {agente}",
  oficina:
    "Hola {nombre} 📍 ¡Tu pedido de {producto} ya llegó a tu ciudad y está en oficina de {transportadora} para que lo recojas! Llevá tu cédula y ten listo el pago de {total}. Tu guía es {guia}. ¿Necesitás algo más? Acá estoy 💛 — {agente}",
  novedad:
    "Hola {nombre} 🙏 Tu pedido tuvo una novedad con la entrega. ¿Me confirmás tu dirección y un horario en que estés, así lo reprogramamos y te llega bien? 📦",
  entregado:
    "¡Llegó tu pedido, {nombre}! 🎉 Espero que lo disfrutes muchísimo. Si necesitás cualquier cosa, acá sigo para ayudarte 💛 — {agente}",
};

function fmtMoney(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return "$" + Math.round(n).toLocaleString("es-CO");
}

type OrderRow = Record<string, unknown>;

function render(tpl: string, o: OrderRow, agente: string, country: string): string {
  const guia = o.guia ? String(o.guia) : "";
  const carrier = o.transportadora ? String(o.transportadora) : "";
  const link = guia && carrier ? getTrackingUrl(carrier, guia, country) || "" : "";
  const firstName = String(o.nombre || "").trim().split(/\s+/)[0] || "";
  return tpl
    .replaceAll("{nombre}", firstName)
    .replaceAll("{producto}", String(o.producto || "tu pedido"))
    .replaceAll("{transportadora}", carrier || "la transportadora")
    .replaceAll("{guia}", guia || "—")
    .replaceAll("{ciudad}", String(o.ciudad || ""))
    .replaceAll("{total}", fmtMoney(o.valor))
    .replaceAll("{link}", link || "(te comparto el link apenas esté disponible)")
    .replaceAll("{agente}", agente)
    .trim();
}

interface NotifyCfg {
  enabled?: boolean;
  buckets?: Partial<Record<Bucket, boolean>>;
  templates?: Partial<Record<Bucket, string>>;
  followup?: boolean;          // recordatorio por silencio (default ON si enabled)
  followupTemplate?: string;   // plantilla custom opcional ({nombre}, {agente})
}

async function processStore(
  sbAdmin: SupabaseClient,
  cfg: { store_id: string; enabled: boolean; agent_name: string | null; notify: NotifyCfg },
  state: { sent: number; seeded: number; scanned: number },
): Promise<void> {
  const notify = cfg.notify || {};
  if (!notify.enabled) return;
  const storeId = String(cfg.store_id);

  let channel;
  try {
    channel = await loadWaChannel(sbAdmin, storeId);
  } catch {
    return; // tienda sin canal WhatsApp configurado
  }

  const agente = (cfg.agent_name && String(cfg.agent_name).trim()) || "Sara";
  const storeRes = await sbAdmin.from("stores").select("country_code").eq("id", storeId).maybeSingle();
  const country = String(storeRes.data?.country_code || "CO");

  const sinceIso = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();
  const { data: orders } = await sbAdmin
    .from("orders")
    .select("external_id, nombre, phone, producto, estado, guia, transportadora, ciudad, valor, last_movement_at")
    .eq("store_id", storeId)
    .gte("last_movement_at", sinceIso)
    .not("phone", "is", null)
    .order("last_movement_at", { ascending: false })
    .limit(ORDERS_PER_STORE);

  for (const o of (orders || []) as OrderRow[]) {
    state.scanned++;
    const extId = o.external_id ? String(o.external_id) : "";
    const phone = o.phone ? String(o.phone) : "";
    if (!extId || !phone) continue;
    const bucket = bucketOf(String(o.estado || "")); // puede ser null (pre-guía)

    const { data: prev } = await sbAdmin
      .from("wa_order_notifications")
      .select("id, last_bucket")
      .eq("store_id", storeId)
      .eq("external_id", extId)
      .maybeSingle();

    // Baseline silencioso: PRIMERA vez que vemos el pedido → registrar sin avisar
    // (no blastea el histórico). Sembramos también los pendientes (bucket null →
    // "none") para que la PRIMERA transición real (p.ej. → guia_generada) cuente
    // como cambio y SÍ dispare el aviso en pedidos nuevos.
    if (!prev) {
      await sbAdmin.from("wa_order_notifications").insert({
        store_id: storeId,
        external_id: extId,
        customer_phone: phone,
        last_bucket: bucket ?? "none",
        last_estado: String(o.estado || ""),
      });
      state.seeded++;
      continue;
    }

    if (!bucket) continue;                     // sigue pre-guía, nada que avisar
    if (prev.last_bucket === bucket) continue; // sin cambio de bucket

    const bucketOn = notify.buckets?.[bucket] !== false; // default ON si no está
    let didSend = false;
    if (bucketOn && state.sent < MAX_SENDS_PER_RUN) {
      const tpl = (notify.templates?.[bucket] && String(notify.templates[bucket]).trim()) || DEFAULT_TEMPLATES[bucket];
      const body = render(tpl, o, agente, country);
      try {
        const conv = await upsertConversation(sbAdmin, {
          storeId,
          channelId: channel.channelId,
          phone,
          name: o.nombre ? String(o.nombre) : null,
        });
        // Si un humano TOMÓ/APAGÓ el hilo (ai_state='handed_off'), el bot NO manda
        // proactivos NI se re-activa solo: lo maneja la persona. El apagado humano
        // manda (requisito: "solo la operadora lo puede apagar"). Igual avanzamos
        // el bucket abajo, así no reintenta en cada corrida.
        if (conv.aiState !== "handed_off") {
          const res = await sendAndRecord(sbAdmin, channel, {
            conversationId: conv.id,
            to: phone,
            body,
            sender: "system",
          });
          // Que el bot pueda RESPONDER si el cliente contesta (amigo siempre disponible).
          await sbAdmin.from("wa_conversations")
            .update({ ai_enabled: true, ai_state: "auto" })
            .eq("id", conv.id);
          didSend = res.ok;
          if (res.ok) state.sent++;
        }
      } catch (e) {
        console.error("[wa-status-notifier] send failed", extId, e instanceof Error ? e.message : e);
      }
    }

    const patch: Record<string, unknown> = {
      last_bucket: bucket,
      last_estado: String(o.estado || ""),
      customer_phone: phone,
      updated_at: new Date().toISOString(),
    };
    if (didSend) patch.notified_at = new Date().toISOString();
    await sbAdmin.from("wa_order_notifications").update(patch).eq("id", prev.id);
  }

  // 2º pase: recordatorio a clientes que quedaron CALLADOS (mismo cron/horario/cap).
  await processSilenceFollowups(sbAdmin, cfg, state, channel, agente);
}

/** Recordatorio suave a quien el bot le escribió y NO respondió en ~8h (y la
 *  conversación no es más vieja que 72h). UNA vez por episodio de silencio. Respeta:
 *  apagado humano (ai_state='auto' obligatorio), opt-out (handed_off), horario (ya
 *  gateado en el handler), tope MAX_SENDS_PER_RUN, y NO pisa a un operador humano
 *  (el último saliente debe ser del bot, no de una persona). */
async function processSilenceFollowups(
  sbAdmin: SupabaseClient,
  cfg: { store_id: string; agent_name: string | null; notify: NotifyCfg },
  state: { sent: number; seeded: number; scanned: number },
  channel: Awaited<ReturnType<typeof loadWaChannel>>,
  agente: string,
): Promise<void> {
  const notify = cfg.notify || {};
  if (notify.followup === false) return; // sub-switch opcional (default ON si avisos ON)
  if (state.sent >= MAX_SENDS_PER_RUN) return;
  const storeId = String(cfg.store_id);
  const now = Date.now();
  const silentBefore = new Date(now - FOLLOWUP_SILENCE_HOURS * 3_600_000).toISOString();
  const notOlderThan = new Date(now - FOLLOWUP_MAX_AGE_HOURS * 3_600_000).toISOString();

  // Candidatos: hilos con IA en auto, último mensaje SALIENTE, callados 8–72h.
  // El filtro "ya seguido este episodio" (last_followup_at >= last_message_at) se
  // hace en código (PostgREST no compara dos columnas). Si la columna aún no existe
  // (migración sin aplicar), data viene null y el pase no hace nada (degrada solo).
  const { data: convs } = await sbAdmin
    .from("wa_conversations")
    .select("id, customer_phone, customer_name, linked_external_id, last_message_at, last_followup_at")
    .eq("store_id", storeId)
    .eq("ai_state", "auto")
    .eq("ai_enabled", true)
    .eq("last_direction", "out")
    .lt("last_message_at", silentBefore)
    .gt("last_message_at", notOlderThan)
    .order("last_message_at", { ascending: false })
    .limit(FOLLOWUP_CANDIDATES);

  for (const c of (convs || []) as Array<Record<string, unknown>>) {
    if (state.sent >= MAX_SENDS_PER_RUN) break;
    const lastMsgAt = c.last_message_at ? Date.parse(String(c.last_message_at)) : 0;
    const lastFup = c.last_followup_at ? Date.parse(String(c.last_followup_at)) : 0;
    if (lastFup && lastFup >= lastMsgAt) continue; // ya seguimos este episodio
    const phone = c.customer_phone ? String(c.customer_phone) : "";
    const convId = String(c.id);
    if (!phone) continue;

    // El último saliente debe ser del BOT (ai/system), no de un operador humano que
    // esté atendiendo el hilo → no lo pisamos.
    const { data: lastMsg } = await sbAdmin
      .from("wa_messages")
      .select("direction, sender")
      .eq("conversation_id", convId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!lastMsg || lastMsg.direction !== "out") continue;
    if (lastMsg.sender !== "ai" && lastMsg.sender !== "system") continue;

    // Si hay pedido vinculado y ya está en estado terminal, no tiene sentido seguir
    // (marcamos last_followup_at para no re-evaluarlo en cada corrida).
    let nombre = c.customer_name ? String(c.customer_name) : "";
    if (c.linked_external_id) {
      const { data: ord } = await sbAdmin
        .from("orders")
        .select("estado, nombre")
        .eq("store_id", storeId)
        .eq("external_id", String(c.linked_external_id))
        .maybeSingle();
      const est = E(String(ord?.estado || ""));
      if (est && (ESTADOS_TERMINALES.has(est) || est.includes("DEVOLUC"))) {
        await sbAdmin.from("wa_conversations").update({ last_followup_at: new Date().toISOString() }).eq("id", convId);
        continue;
      }
      if (!nombre && ord?.nombre) nombre = String(ord.nombre);
    }

    const firstName = nombre.trim().split(/\s+/)[0] || "";
    let body: string;
    if (notify.followupTemplate && String(notify.followupTemplate).trim()) {
      body = String(notify.followupTemplate)
        .replaceAll("{nombre}", firstName)
        .replaceAll("{agente}", agente)
        .trim();
    } else {
      const hola = firstName ? `Hola ${firstName}` : "¡Hola!";
      body = `${hola} 💛 ¿Pudiste ver lo de tu pedido? Acá sigo para ayudarte con lo que necesites 😊`;
    }

    try {
      const res = await sendAndRecord(sbAdmin, channel, {
        conversationId: convId,
        to: phone,
        body,
        sender: "system",
      });
      if (res.ok) state.sent++;
    } catch (e) {
      console.error("[wa-status-notifier] followup send failed", convId, e instanceof Error ? e.message : e);
    }
    // Marcamos el episodio como seguido pase lo que pase (evita reintentos en loop).
    await sbAdmin.from("wa_conversations").update({ last_followup_at: new Date().toISOString() }).eq("id", convId);
  }
}

Deno.serve(async (req) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // Cast type-only (createClient esm.sh @2.49.1 vs tipo SupabaseClient @2 difieren
  // en aridad de genéricos). Sin efecto runtime. Alinea las firmas de los helpers.
  const sbAdmin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  ) as unknown as SupabaseClient;

  // Auth: x-cron-secret contra app_settings.cron_shared_secret (igual que dropi-cron).
  const provided = req.headers.get("x-cron-secret") || "";
  const { data: secretRow } = await sbAdmin.from("app_settings").select("value").eq("key", "cron_shared_secret").maybeSingle();
  const expected = secretRow?.value ? String(secretRow.value) : "";
  if (!expected || provided !== expected) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  // Ventana horaria: los avisos PROACTIVOS solo salen 8am–9pm (Bogotá). Fuera de
  // eso, el cron corre pero no manda nada (las respuestas reactivas siguen 24/7).
  if (!withinSendHours()) {
    return new Response(JSON.stringify({ ok: true, skipped: "fuera de horario (8am-9pm Bogota)" }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const state = { sent: 0, seeded: 0, scanned: 0 };
  try {
    const { data: cfgs } = await sbAdmin
      .from("wa_bot_config")
      .select("store_id, enabled, agent_name, notify")
      .neq("enabled", false);
    for (const cfg of (cfgs || []) as Array<{ store_id: string; enabled: boolean; agent_name: string | null; notify: NotifyCfg }>) {
      if (state.sent >= MAX_SENDS_PER_RUN) break;
      await processStore(sbAdmin, cfg, state);
    }
    return new Response(JSON.stringify({ ok: true, ...state }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[wa-status-notifier] error:", err);
    return new Response(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err), ...state }), {
      status: 200, // 200 para no romper el cron
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});

// importchat-responder — el DISPARADOR: cuando el cliente pregunta por su
// pedido (o manda su número) y nadie le contesta, Guardian le responde el
// estado REAL desde `orders`. Y cuando el bot promete "lo verifico y le
// confirmo por aquí" y se calla, Guardian cumple la promesa.
//
// ── El caso que lo motivó (Ecuador, 4-sep-2026) ────────────────────────────
// 21:39 el bot pide el número · 22:05 el cliente manda "0960915765" · 22:06 el
// bot: "un momentito que lo verifico con el equipo y le confirmo por aquí 🙏"
// … y NADA hasta las 10:54 del día siguiente. Trece horas de silencio sobre
// una pregunta que Guardian podía contestar en el acto: el pedido estaba en
// `orders`, confirmado, sin guía todavía. La respuesta honesta era "está en
// preparación; en cuanto salga a ruta le comparto la guía".
//
// ── Dos disparadores, un solo cerebro ──────────────────────────────────────
//   A. CONSULTA: el ÚLTIMO mensaje del chat es del cliente, pregunta por su
//      envío (`esConsultaEstado`) o es solo un número (`esNumeroSuelto`), y
//      lleva ≥ 3 min sin respuesta → el bot de ImporChat tuvo su turno y no
//      contestó. Guardian contesta.
//   B. PROMESA: el último mensaje es del NEGOCIO y es una promesa de verificar
//      (`esPromesaPendiente`) que lleva ≥ 30 min sin cumplirse → Guardian la
//      cumple, pero SOLO si al releer el hilo el mensaje anterior del cliente
//      era una consulta o un número (no se cuela en cualquier conversación).
//
// El texto sale de `componerEstadoPedido` — el mismo que la asesora ya usa con
// el botón "Responder estado del pedido". ⛔ NUNCA inventa: sin dato o caso
// delicado (cancelado, desconocido) → `derivarAHumano` y NO se manda nada.
//
// ── Candados ───────────────────────────────────────────────────────────────
//   · Interruptor por tienda: `store_importchat_config.auto_estado` (default
//     false). Con `dry_run:true` se ve qué mandaría SIN mandar, aun apagado.
//   · Un pedido, no dos: `elegirPedidoParaResponder` descarta reemplazados,
//     cancelados y entregados viejos; si quedan dos vivos, NO responde.
//   · Una vez por mensaje: `importchat_auto_respuestas` UNIQUE (tienda, chat,
//     instante del mensaje que disparó). Y máximo una respuesta automática por
//     chat cada 6 h.
//   · Ventana de 24 h de Meta decidida con el hilo recién leído (igual que
//     importchat-send). Fuera de ventana no se emite.
//   · Antes de emitir se relee el hilo: si mientras tanto alguien (bot o
//     asesora) ya contestó, se abstiene.
//   · Tope de 15 envíos por corrida y presupuesto de reloj: una corrida que se
//     pasa de rosca NO puede regar la cuenta.
//   · Cada decisión queda escrita (enviado u omitido, con el motivo) — el dueño
//     puede auditar cada mensaje automático que salió.
//
// Auth: x-cron-secret (cron cada 3 min) o Bearer de un miembro con store_id
// (para el dry_run desde Guardian). Body: { store_id?, dry_run? }.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { respuestaPing } from "../_shared/versionEdge.ts";
import { ensureFreshImporchatToken, decodeJwtExp, IMPORCHAT_BASE_DEFAULT } from "../_shared/imporchatSession.ts";
import { traerUltimosMensajes, type UltimoMensajeChat } from "../_shared/imporchatListar.ts";
import { usarSocket } from "../_shared/imporchatSocket.ts";
import { enviarVerificado } from "../_shared/imporchatEnviar.ts";
import {
  esConsultaEstado,
  esNumeroSuelto,
  esPromesaPendiente,
  elegirPedidoParaResponder,
  componerEstadoPedido,
} from "../_shared/estadoPedidoRespuesta.ts";
import { linkRastreoConGuia } from "../_shared/rastreo.ts";
import type { MensajeConversacion } from "../_shared/conversacion.ts";

/** ⛔ Subirla en el MISMO commit que cambie algo, o el ping miente. */
const VERSION = "importchat-responder 2026-09-04.2 lee-ultimo_texto-del-listado";
const SOURCE = "importchat-responder";
const AUTOR = "Guardian · respuesta automática";

/** Presupuesto de pared por debajo del límite del edge: SIEMPRE alcanza a cerrar sync_logs. */
const BUDGET_MS = 100_000;
/** El bot de ImporChat contesta en segundos: si a los 3 min no lo hizo, no va a hacerlo. */
const ESPERA_BOT_MS = 3 * 60_000;
/** Una promesa de "lo verifico" tiene 30 min para cumplirse antes de que Guardian la cumpla. */
const ESPERA_PROMESA_MS = 30 * 60_000;
/** Más viejo que esto ya no es una pregunta abierta: es historia. */
const MAX_ANTIGUEDAD_MS = 36 * 60 * 60_000;
/** Cuánto atrás se buscan pedidos con chat para cruzar (los que están en la ventana de Seguimiento). */
const DIAS_PEDIDOS = 45;
const ENFRIAMIENTO_MS = 6 * 60 * 60_000;
const MAX_ENVIOS_POR_CORRIDA = 15;

type Disparador = "consulta" | "numero" | "promesa";

interface PedidoConChat {
  external_id: string; phone: string | null; nombre: string | null; estado: string | null;
  guia: string | null; transportadora: string | null; importchat_chat_id: string;
  chat_entrante_at: string | null; chat_leido_at: string | null;
  last_movement_at: string | null; created_at: string | null;
}

/** Sobre el último mensaje del chat: ¿hay algo que Guardian deba contestar? */
export function clasificarUltimo(u: UltimoMensajeChat, ahoraMs: number): Disparador | null {
  const edad = ahoraMs - u.at.getTime();
  if (edad > MAX_ANTIGUEDAD_MS) return null;
  const tipo = (u.tipo || "text").toLowerCase();
  if (u.rol === "Cliente") {
    // Solo texto: una nota de voz no se puede leer acá (y no se adivina).
    if (tipo !== "text" && tipo !== "chat" && tipo !== "texto") return null;
    if (edad < ESPERA_BOT_MS) return null;
    if (esNumeroSuelto(u.texto)) return "numero";
    if (esConsultaEstado(u.texto)) return "consulta";
    return null;
  }
  if (u.rol === "Propietario") {
    if (edad < ESPERA_PROMESA_MS) return null;
    return esPromesaPendiente(u.texto) ? "promesa" : null;
  }
  return null;
}

/**
 * Con el hilo fresco en la mano, ¿sigue teniendo sentido mandar? Devuelve el
 * motivo para abstenerse, o `null` para seguir.
 *   - Si el último mensaje ya no es el que disparó (alguien contestó, o el
 *     cliente siguió escribiendo), se abstiene: la situación cambió.
 *   - En PROMESA, el mensaje del cliente inmediatamente anterior a la promesa
 *     tiene que ser una consulta o un número; si no, no era una promesa sobre
 *     su envío.
 */
export function vetoConHilo(hilo: MensajeConversacion[], disparador: Disparador, disparadorMs: number): string | null {
  if (!hilo.length) return "hilo vacío al releer";
  const ultimo = hilo[hilo.length - 1];
  if (ultimo.fechaMs != null && Math.abs(ultimo.fechaMs - disparadorMs) > 90_000) {
    return `el chat siguió después del disparador (${ultimo.de} a las ${new Date(ultimo.fechaMs).toISOString()})`;
  }
  if (disparador === "promesa") {
    // El cliente que habló antes de la promesa.
    let i = hilo.length - 1;
    while (i >= 0 && hilo[i].de !== "cliente") i--;
    if (i < 0) return "la promesa no responde a ningún mensaje del cliente";
    const t = hilo[i].texto || "";
    if (!esNumeroSuelto(t) && !esConsultaEstado(t)) return "la promesa no era sobre el envío";
    if (hilo[i].fechaMs != null && disparadorMs - (hilo[i].fechaMs as number) > 6 * 60 * 60_000) {
      return "el cliente preguntó hace más de 6 h";
    }
  }
  return null;
}

Deno.serve(async (req) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  { const pg = respuestaPing(req, VERSION, cors); if (pg) return pg; }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  const t0 = Date.now();
  const vencimiento = t0 + BUDGET_MS;
  let storeEnCurso: string | null = null;
  let trazaId: string | null = null;
  // Misma disciplina que importchat-sync: fila 'running' apenas arranca; si la
  // función muere, esa fila es la última señal de vida. store_id se OMITE si no
  // hay tienda en curso (la columna es NOT NULL con DEFAULT).
  const filaLog = (status: string, msg: string, n: number) => {
    const fila: Record<string, unknown> = { source: SOURCE, status, error_message: msg || null, synced_count: n };
    if (storeEnCurso) fila.store_id = storeEnCurso;
    return fila;
  };
  const traza = async (fase: string, n = 0) => {
    try {
      if (trazaId == null) {
        const { data, error } = await sb.from("sync_logs").insert(filaLog("running", fase, n)).select("id").maybeSingle();
        if (error) console.error(`[${SOURCE}] sync_logs rechazó la traza: ${error.message}`);
        trazaId = (data as { id?: string } | null)?.id ?? null;
      } else {
        const { error } = await sb.from("sync_logs")
          .update({ error_message: fase, synced_count: n, ...(storeEnCurso ? { store_id: storeEnCurso } : {}) })
          .eq("id", trazaId);
        if (error) console.error(`[${SOURCE}] no se pudo actualizar la traza: ${error.message}`);
      }
    } catch (e) { console.error(`[${SOURCE}] traza:`, e); }
  };
  const cerrar = async (status: string, msg: string, n: number) => {
    try {
      if (trazaId != null) {
        const { error } = await sb.from("sync_logs")
          .update({ status, error_message: msg || null, synced_count: n, ...(storeEnCurso ? { store_id: storeEnCurso } : {}) })
          .eq("id", trazaId);
        if (error) console.error(`[${SOURCE}] no se pudo cerrar la traza: ${error.message}`);
        return;
      }
      const { error } = await sb.from("sync_logs").insert(filaLog(status, msg, n));
      if (error) console.error(`[${SOURCE}] sync_logs rechazó la fila: ${error.message}`);
    } catch (e) { console.error(`[${SOURCE}] cerrar:`, e); }
  };

  try {
    const body = await req.json().catch(() => ({}));
    const dryRun = body?.dry_run === true;
    const storeIdPedido = body?.store_id ? String(body.store_id) : null;

    // ── Auth: cron (todas las tiendas) o miembro con store_id ──────────────
    const cronSecret = req.headers.get("x-cron-secret");
    if (cronSecret) {
      const { data: secretRow } = await sb.from("app_settings").select("value").eq("key", "cron_shared_secret").maybeSingle();
      const esperado = String(secretRow?.value || "");
      if (!esperado || cronSecret !== esperado) return json({ ok: false, error: "cron secret inválido" }, 401);
    } else {
      const auth = req.headers.get("Authorization") ?? "";
      const { data: u } = await sb.auth.getUser(auth.replace("Bearer ", ""));
      if (!u?.user) return json({ ok: false, error: "no autenticado" }, 401);
      if (storeIdPedido) {
        const { data: m } = await sb.from("store_members").select("role")
          .eq("store_id", storeIdPedido).eq("user_id", u.user.id).maybeSingle();
        if (!m) return json({ ok: false, error: "no sos miembro de esa tienda" }, 403);
      } else {
        const { data: rol } = await sb.from("user_roles").select("role")
          .eq("user_id", u.user.id).eq("role", "admin").maybeSingle();
        if (!rol) return json({ ok: false, error: "Especificá store_id: solo un admin puede correr todas las tiendas." }, 403);
      }
    }

    if (!dryRun) await traza("arrancó");

    // ── Tiendas: ImporChat habilitado y el interruptor prendido (salvo dry_run) ──
    let q = sb.from("store_importchat_config")
      .select("store_id, id_configuracion, api_base, session_token, token_expira_at, habilitado, auto_estado")
      .eq("habilitado", true);
    if (storeIdPedido) q = q.eq("store_id", storeIdPedido);
    if (!dryRun) q = q.eq("auto_estado", true);
    const { data: configs, error: cfgErr } = await q;
    if (cfgErr) {
      if (/auto_estado/i.test(cfgErr.message)) {
        await cerrar("error", "Falta aplicar la migración 20260904120000 (auto_estado)", 0);
        return json({ ok: false, error: "Falta aplicar la migración 20260904120000_importchat_responder.sql" }, 503);
      }
      throw new Error(cfgErr.message);
    }
    if (!configs?.length) {
      if (!dryRun) await cerrar("success", "ninguna tienda con el respondedor prendido", 0);
      return json({ ok: true, tiendas: 0, mensaje: dryRun ? "sin tiendas con ImporChat" : "ninguna tienda tiene auto_estado=true" });
    }

    const resumen: Array<Record<string, unknown>> = [];
    const previews: Array<Record<string, unknown>> = [];
    let enviadosTotal = 0;
    let huboError = false;

    for (const cfg of configs) {
      if (Date.now() > vencimiento - 15_000) { resumen.push({ store_id: cfg.store_id, ok: false, error: "sin reloj" }); break; }
      const storeId = String(cfg.store_id);
      storeEnCurso = storeId;
      const idConf = Number(cfg.id_configuracion);
      const base = String(cfg.api_base || IMPORCHAT_BASE_DEFAULT);
      let token = String(cfg.session_token || "");
      if (!token) { resumen.push({ store_id: storeId, ok: false, error: "sin token" }); continue; }

      try {
        token = await ensureFreshImporchatToken(sb, {
          storeId, base, sessionToken: token,
          tokenExpiraAt: cfg.token_expira_at ? String(cfg.token_expira_at) : null,
        });
        const expSeg = decodeJwtExp(token);
        if (expSeg && expSeg * 1000 < Date.now()) {
          resumen.push({ store_id: storeId, ok: false, error: "token de ImporChat vencido" });
          continue;
        }
        const { data: store } = await sb.from("stores").select("country_code").eq("id", storeId).maybeSingle();
        const cc = String(store?.country_code || "EC");

        // ── Pedidos con conversación (ventana de Seguimiento) ────────────────
        const desde = new Date(Date.now() - DIAS_PEDIDOS * 86400_000).toISOString();
        const { data: pedidos, error: pedErr } = await sb.from("orders")
          .select("external_id, phone, nombre, estado, guia, transportadora, importchat_chat_id, chat_entrante_at, chat_leido_at, last_movement_at, created_at")
          .eq("store_id", storeId)
          .not("importchat_chat_id", "is", null)
          .gte("created_at", desde)
          .limit(5000);
        if (pedErr) throw new Error(`orders: ${pedErr.message}`);
        const porChat = new Map<string, PedidoConChat[]>();
        for (const p of (pedidos ?? []) as PedidoConChat[]) {
          const k = String(p.importchat_chat_id);
          const arr = porChat.get(k);
          if (arr) arr.push(p); else porChat.set(k, [p]);
        }
        if (porChat.size === 0) { resumen.push({ store_id: storeId, ok: true, chats: 0, enviados: 0 }); continue; }

        // ── El último mensaje de cada chat (listado liviano) ─────────────────
        const listado = await traerUltimosMensajes(base, token, idConf, cc, vencimiento - 20_000, new Set(porChat.keys()));
        if (!listado) {
          resumen.push({ store_id: storeId, ok: false, error: "ImporChat no devolvió el listado de chats" });
          huboError = true;
          continue;
        }

        // ── Lo ya decidido: idempotencia + enfriamiento ──────────────────────
        const { data: previas } = await sb.from("importchat_auto_respuestas")
          .select("chat_id, disparador_at, resultado, created_at")
          .eq("store_id", storeId)
          .gte("created_at", new Date(Date.now() - MAX_ANTIGUEDAD_MS).toISOString());
        const yaDecidido = new Set<string>();
        const ultimoEnvioPorChat = new Map<string, number>();
        for (const r of previas ?? []) {
          yaDecidido.add(`${r.chat_id}|${new Date(String(r.disparador_at)).toISOString()}`);
          if (r.resultado === "enviado") {
            const ms = Date.parse(String(r.created_at));
            ultimoEnvioPorChat.set(String(r.chat_id), Math.max(ultimoEnvioPorChat.get(String(r.chat_id)) ?? 0, ms));
          }
        }

        // ── Candidatos ───────────────────────────────────────────────────────
        const ahora = Date.now();
        const candidatos: Array<{ chatId: string; u: UltimoMensajeChat; disparador: Disparador }> = [];
        for (const [chatId, u] of listado.porChat) {
          if (!porChat.has(chatId)) continue;
          const d = clasificarUltimo(u, ahora);
          if (!d) continue;
          if (yaDecidido.has(`${chatId}|${u.at.toISOString()}`)) continue;
          const ult = ultimoEnvioPorChat.get(chatId);
          if (ult && ahora - ult < ENFRIAMIENTO_MS) continue;
          candidatos.push({ chatId, u, disparador: d });
        }
        // Los más viejos primero: llevan más tiempo esperando.
        candidatos.sort((a, b) => a.u.at.getTime() - b.u.at.getTime());

        let enviados = 0, omitidos = 0;
        const decidir = async (fila: Record<string, unknown>) => {
          if (dryRun) return;
          const { error } = await sb.from("importchat_auto_respuestas").insert({ store_id: storeId, ...fila });
          if (error) console.error(`[${SOURCE}] no se pudo anotar la decisión (${fila.chat_id}): ${error.message}`);
        };

        for (const c of candidatos) {
          if (enviadosTotal + enviados >= MAX_ENVIOS_POR_CORRIDA) break;
          if (Date.now() > vencimiento - 25_000) break;
          const base_fila = {
            chat_id: c.chatId, disparador: c.disparador, disparador_at: c.u.at.toISOString(),
            mensaje_cliente: c.disparador === "promesa" ? null : c.u.texto.slice(0, 300),
          };
          const { pedido, motivo } = elegirPedidoParaResponder(
            porChat.get(c.chatId)!.map((p) => ({
              ...p,
              movidoMs: p.last_movement_at ? Date.parse(p.last_movement_at) : (p.created_at ? Date.parse(p.created_at) : null),
            })),
            ahora,
          );
          if (!pedido) {
            omitidos++;
            await decidir({ ...base_fila, resultado: "omitido", motivo: `pedido ${motivo}` });
            continue;
          }
          const r = componerEstadoPedido({
            nombre: pedido.nombre, estado: pedido.estado, guia: pedido.guia,
            transportadora: pedido.transportadora, pais: cc,
            trackingUrl: linkRastreoConGuia(pedido.transportadora, pedido.guia, cc),
          });
          if (r.derivarAHumano || !r.texto) {
            omitidos++;
            await decidir({ ...base_fila, external_id: pedido.external_id, phone: pedido.phone, fase: r.fase, resultado: "omitido", motivo: `derivar a humano (${r.fase})` });
            continue;
          }
          if (dryRun) {
            previews.push({ store_id: storeId, chat_id: c.chatId, external_id: pedido.external_id, disparador: c.disparador, fase: r.fase, mensaje_cliente: c.u.texto.slice(0, 120), enviaria: r.texto });
            continue;
          }

          // ── Enviar, verificando ────────────────────────────────────────────
          const env = await usarSocket((socket) => enviarVerificado(socket, {
            cred: { token, idConf }, chatId: c.chatId, telefono: String(pedido.phone || ""),
            mensaje: r.texto, autor: AUTOR,
            entranteAtDb: pedido.chat_entrante_at ? Date.parse(pedido.chat_entrante_at) : null,
            leidoDb: !!pedido.chat_leido_at,
            antesDeEmitir: (hilo) => vetoConHilo(hilo, c.disparador, c.u.at.getTime()),
          })).catch((e) => ({ ok: false, confirmado: false, detalle: e instanceof Error ? e.message : String(e), mensajes: [], hiloPrevio: null, ventanaCerrada: undefined }));

          if (!env.ok) {
            omitidos++;
            await decidir({ ...base_fila, external_id: pedido.external_id, phone: pedido.phone, fase: r.fase, resultado: "omitido", motivo: env.ventanaCerrada ? `ventana ${env.ventanaCerrada}` : env.detalle, texto: r.texto });
            continue;
          }
          enviados++;
          await decidir({ ...base_fila, external_id: pedido.external_id, phone: pedido.phone, fase: r.fase, resultado: "enviado", texto: r.texto });
          // Que la pantalla reaccione ya (el sync lo reescribe después con el dato de ImporChat).
          await sb.from("orders").update({ chat_saliente_at: new Date().toISOString(), chat_saliente_tipo: "directo" })
            .eq("store_id", storeId).eq("external_id", pedido.external_id);
        }
        enviadosTotal += enviados;
        resumen.push({ store_id: storeId, ok: true, chats: porChat.size, candidatos: candidatos.length, enviados, omitidos, listado_parcial: listado.parcial });
        if (!dryRun) await traza(`tienda ${storeId}: ${enviados} enviados · ${omitidos} omitidos`, enviadosTotal);
      } catch (e) {
        huboError = true;
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[${SOURCE}] ${storeId}:`, msg);
        resumen.push({ store_id: storeId, ok: false, error: msg });
      }
    }
    storeEnCurso = null;

    if (!dryRun) {
      const detalle = resumen.map((r) => r.ok ? `${r.store_id}: ${r.enviados ?? 0} enviados/${r.omitidos ?? 0} omitidos` : `${r.store_id}: ${r.error}`).join(" · ");
      await cerrar(huboError ? "warn" : "success", detalle, enviadosTotal);
    }
    return json({ ok: true, version: VERSION, dry_run: dryRun, tiendas: configs.length, enviados: enviadosTotal, resumen, ...(dryRun ? { previews } : {}), ms: Date.now() - t0 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[${SOURCE}]`, msg);
    await cerrar("error", msg, 0);
    return json({ ok: false, error: msg }, 500);
  }
});

// importchat-send — responderle al cliente por WhatsApp SIN salir de Guardian.
//
// Pedido del dueño (24-ago-2026): "que desde Guardian puedan enviar mensajes;
// la idea es unificar ImporChat como lo hicimos con Dropi". Hasta hoy la
// asesora tenía que abrir otra pestaña, buscar el chat y escribir ahí — y
// desde Guardian no quedaba constancia de nada.
//
// ── Cómo envía ─────────────────────────────────────────────────────────────
// ImporChat NO tiene un endpoint REST para texto libre: su panel manda los
// mensajes por un socket (socket.io, `https://chat.imporfactory.app`, path
// `/socket.io`, transporte websocket) con el evento `SEND_MESSAGE`. Verificado
// el 24-ago-2026 conectándose desde fuera del navegador: el socket acepta la
// conexión y responde comandos.
//
// ── Tres reglas que NO se negocian ─────────────────────────────────────────
// 1. **Ventana de 24 h** (`_shared/ventanaWhatsapp.ts`): Meta solo entrega
//    texto libre dentro de las 24 h del último mensaje DEL CLIENTE. Fuera de
//    ella el mensaje no llega y NADIE se entera — la asesora queda convencida
//    de que avisó. Se bloquea acá, en el servidor, no solo en el botón.
// 2. **Se VERIFICA que salió**: tras emitir se relee el chat y se busca el
//    mensaje. Si no aparece, se responde "no se pudo confirmar" y NO se marca
//    nada como enviado. Un "listo" sin confirmar es peor que un error.
// 3. **Queda el AUTOR**: viaja `nombre_encargado` con el nombre de quien
//    escribió desde Guardian, así ImporChat lo registra como responsable y se
//    puede distinguir de un mensaje del bot.
//
// Auth: SOLO Bearer de un miembro de la tienda. Enviar un WhatsApp a un
// cliente es una acción humana: acá NO hay camino de cron a propósito.
// Body: { store_id, external_id, mensaje, dry_run? }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { ventanaWhatsapp, MOTIVO_VENTANA } from "../_shared/ventanaWhatsapp.ts";
// La plomería del socket vive en `_shared` desde que `importchat-chat` también
// la necesita. Es el mismo molde que `_shared/dropiWebQuote.ts`.
import { usarSocket, emitirMensaje, leerChat, type CredencialIC } from "../_shared/imporchatSocket.ts";
import { normalizarConversacion, type MensajeConversacion } from "../_shared/conversacion.ts";

const MAX_LARGO = 1000;
/** Cuánto se espera a que el mensaje aparezca en el chat al releerlo. */
const ESPERA_VERIFICACION_MS = 3500;

/**
 * Conecta, emite el mensaje y RELEE el chat para confirmar que salió.
 *
 * La verificación se hace sobre los mensajes CRUDOS, con exactamente el mismo
 * criterio de siempre — normalizar antes de comparar cambiaría, aunque sea en
 * un borde, la regla que decide si a la asesora se le dice "enviado". El hilo
 * normalizado se devuelve APARTE, como agregado, para que la pantalla pueda
 * mostrar la conversación sin pedirla de nuevo.
 */
async function enviarPorSocket(opts: {
  cred: CredencialIC; chatId: string; telefono: string;
  mensaje: string; autor: string;
}): Promise<{ ok: boolean; confirmado: boolean; detalle: string; mensajes: MensajeConversacion[] }> {
  try {
    return await usarSocket(async (socket) => {
      emitirMensaje(socket, opts.cred, {
        chatId: opts.chatId, telefono: opts.telefono,
        mensaje: opts.mensaje, autor: opts.autor,
      });

      // Verificación: releer el chat y buscar NUESTRO texto entre los salientes.
      await new Promise((r) => setTimeout(r, ESPERA_VERIFICACION_MS));
      const crudos = await leerChat(socket, opts.cred, opts.chatId);
      // No poder releer NO es "no llegó": es no saber. Y no saber se trata
      // como fallo, porque marcar un pedido como avisado sin confirmarlo es
      // peor que pedirle a la asesora que reintente.
      if (crudos === null) {
        return { ok: false, confirmado: false, detalle: "ImporChat no contestó al releer el chat", mensajes: [] };
      }

      const desde = Date.now() - 5 * 60_000;
      const confirmado = crudos.some((m) =>
        m.rol_mensaje === 1 &&
        String(m.texto_mensaje ?? "").trim() === opts.mensaje.trim() &&
        (!m.created_at || Date.parse(m.created_at) >= desde));

      const mensajes = normalizarConversacion(crudos);
      return confirmado
        ? { ok: true, confirmado: true, detalle: "enviado y confirmado en el chat", mensajes }
        // Enviado sin confirmar NO es un éxito: puede haberse perdido. El
        // llamador NO marca el pedido como avisado con esto.
        : { ok: false, confirmado: false, detalle: "se emitió pero no apareció en el chat al releerlo", mensajes };
    });
  } catch (e) {
    return { ok: false, confirmado: false, detalle: e instanceof Error ? e.message : String(e), mensajes: [] };
  }
}

Deno.serve(async (req) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const sb = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  try {
    const body = await req.json().catch(() => ({}));
    const storeId = String(body?.store_id || "");
    const externalId = String(body?.external_id || "");
    const mensaje = String(body?.mensaje || "").trim();
    const dryRun = body?.dry_run === true;

    if (!storeId || !externalId || !mensaje) {
      return json({ ok: false, error: "Faltan store_id, external_id o mensaje" }, 400);
    }
    if (mensaje.length > MAX_LARGO) {
      return json({ ok: false, error: `El mensaje no puede pasar de ${MAX_LARGO} caracteres` }, 400);
    }

    // ── Auth: miembro de la tienda, sin atajo de cron ──────────────────────
    const auth = req.headers.get("Authorization") ?? "";
    const { data: u } = await sb.auth.getUser(auth.replace("Bearer ", ""));
    if (!u?.user) return json({ ok: false, error: "no autenticado" }, 401);
    const { data: miembro } = await sb.from("store_members")
      .select("role").eq("store_id", storeId).eq("user_id", u.user.id).maybeSingle();
    if (!miembro) return json({ ok: false, error: "no sos miembro de esa tienda" }, 403);

    // ── El pedido y su conversación ───────────────────────────────────────
    const { data: pedido, error: pedErr } = await sb.from("orders")
      .select("id, phone, nombre, importchat_chat_id, chat_entrante_at, chat_leido_at")
      .eq("store_id", storeId).eq("external_id", externalId).maybeSingle();
    if (pedErr) {
      // Si la migración del chat_id no corrió, se dice CUÁL falta.
      if (/importchat_chat_id/i.test(pedErr.message)) {
        return json({ ok: false, error: "Falta aplicar la migración 20260825010000 (importchat_chat_id)" }, 503);
      }
      throw new Error(pedErr.message);
    }
    if (!pedido) return json({ ok: false, error: "No encontré ese pedido en esta tienda" }, 404);
    if (!pedido.importchat_chat_id) {
      return json({
        ok: false,
        error: "Este pedido todavía no tiene conversación leída de ImporChat. Esperá al próximo sync (cada 30 min).",
      }, 409);
    }

    // ── La ventana de 24 h, decidida en el SERVIDOR ────────────────────────
    const v = ventanaWhatsapp(
      pedido.chat_entrante_at ? Date.parse(pedido.chat_entrante_at) : null,
      !!pedido.chat_leido_at,
    );
    if (v.estado !== "abierta") {
      return json({ ok: false, error: MOTIVO_VENTANA[v.estado], ventana: v.estado }, 409);
    }

    // ── Credenciales de la tienda ─────────────────────────────────────────
    const { data: cfg } = await sb.from("store_importchat_config")
      .select("id_configuracion, session_token, token_expira_at, habilitado")
      .eq("store_id", storeId).maybeSingle();
    if (!cfg?.habilitado || !cfg?.session_token) {
      return json({ ok: false, error: "Esta tienda no tiene ImporChat configurado" }, 409);
    }
    if (cfg.token_expira_at && new Date(cfg.token_expira_at).getTime() < Date.now()) {
      return json({ ok: false, error: `La credencial de ImporChat venció el ${cfg.token_expira_at}. Hay que renovarla.` }, 409);
    }

    // Nombre de quien escribe: queda registrado en ImporChat como responsable.
    const { data: perfil } = await sb.from("profiles")
      .select("full_name").eq("id", u.user.id).maybeSingle();
    const autor = String(perfil?.full_name || u.user.email || "Guardian");

    if (dryRun) {
      return json({
        ok: true, dry_run: true, enviaria_a: pedido.phone,
        chat_id: pedido.importchat_chat_id, autor, ventana: v.estado,
        restante_horas: v.restanteMs == null ? null : Math.round(v.restanteMs / 3600_000),
      });
    }

    const r = await enviarPorSocket({
      cred: { token: String(cfg.session_token), idConf: Number(cfg.id_configuracion) },
      chatId: String(pedido.importchat_chat_id),
      telefono: String(pedido.phone || ""),
      mensaje, autor,
    });
    if (!r.ok) return json({ ok: false, error: `No se pudo confirmar el envío: ${r.detalle}` }, 502);

    // Recién con el envío CONFIRMADO se marca el pedido. El sync de las 30 min
    // lo va a reescribir con el dato de ImporChat; esto es para que la pantalla
    // reaccione ya.
    await sb.from("orders").update({
      chat_saliente_at: new Date().toISOString(),
      chat_saliente_tipo: "directo",
    }).eq("store_id", storeId).eq("external_id", externalId);

    // Y queda registrado en Guardian con el prefijo de LA PANTALLA donde se
    // escribió, no siempre `SEG:`.
    //
    // No es cosmético: `SEG:%` cuenta como gestión de Seguimiento en
    // `operator_productivity_stats` y en SegCounterBar. Escribirle a un cliente
    // desde Confirmar es un INTENTO DE CONTACTO —la gestión ahí es confirmar o
    // cancelar—, así que va con `WHATSAPP:`, el prefijo que la casa ya usa para
    // eso (ver `useRecordGestion`). Sin esto, el trabajo de Confirmar le
    // sumaría acciones de Seguimiento a la asesora.
    //
    // Default `SEG` a propósito: es lo que hacía antes, así que un cliente
    // viejo que no mande `modulo` se comporta igual.
    if (pedido.phone) {
      const ahora = new Date();
      const modulo = body?.modulo === "WHATSAPP" ? "WHATSAPP" : "SEG";
      await sb.from("touchpoints").insert({
        phone: pedido.phone,
        action: `${modulo}: Escribí por WhatsApp`,
        operator_id: u.user.id,
        store_id: storeId,
        action_date: new Date(ahora.getTime() - 5 * 3600_000).toISOString().slice(0, 10),
        action_time: ahora.toISOString().slice(11, 16),
      });
    }

    // El hilo actualizado viaja de vuelta: la pantalla lo pinta al instante,
    // sin una segunda vuelta a ImporChat.
    return json({ ok: true, confirmado: true, autor, enviado_a: pedido.phone, mensajes: r.mensajes });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[importchat-send]", msg);
    return json({ ok: false, error: msg }, 500);
  }
});

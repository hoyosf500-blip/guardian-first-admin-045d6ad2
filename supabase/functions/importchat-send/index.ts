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
import { io } from "https://esm.sh/socket.io-client@4.7.5";
import { getCorsHeaders } from "../_shared/cors.ts";
import { ventanaWhatsapp, MOTIVO_VENTANA } from "../_shared/ventanaWhatsapp.ts";

const SOCKET_URL = "https://chat.imporfactory.app";
const MAX_LARGO = 1000;
/** Cuánto se espera a que el mensaje aparezca en el chat al releerlo. */
const ESPERA_VERIFICACION_MS = 3500;
const TIMEOUT_SOCKET_MS = 15_000;

interface MensajeIC {
  id?: number;
  rol_mensaje?: number;
  texto_mensaje?: string | null;
  created_at?: string;
  responsable?: string | null;
}

/** Conecta, emite el mensaje y RELEE el chat para confirmar que salió. */
async function enviarPorSocket(opts: {
  token: string; idConf: number; chatId: string; telefono: string;
  mensaje: string; autor: string;
}): Promise<{ ok: boolean; confirmado: boolean; detalle: string }> {
  const socket = io(SOCKET_URL, {
    transports: ["websocket"], reconnection: false, timeout: TIMEOUT_SOCKET_MS,
  });
  const cerrar = () => { try { socket.close(); } catch { /* ya cerrado */ } };

  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("el socket no conectó en 15 s")), TIMEOUT_SOCKET_MS);
      socket.on("connect", () => { clearTimeout(t); resolve(); });
      socket.on("connect_error", (e: Error) => { clearTimeout(t); reject(new Error(`socket: ${e.message}`)); });
    });

    // Mismo payload que emite el panel (leído de su bundle). `client_tmp_id`
    // es el id optimista que usa su UI; se manda uno propio y reconocible.
    socket.emit("SEND_MESSAGE", {
      id_configuracion: opts.idConf,
      chatId: Number(opts.chatId) || opts.chatId,
      source: "wa",
      page_id: null,
      external_id: null,
      to: opts.telefono,
      mensaje: opts.mensaje,
      tipo_mensaje: "text",
      attachment_url: null,
      ruta_archivo: null,
      nombre_encargado: opts.autor,
      client_tmp_id: `guardian-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      jwt_token: opts.token,
    });

    // Verificación: releer el chat y buscar NUESTRO texto entre los salientes.
    await new Promise((r) => setTimeout(r, ESPERA_VERIFICACION_MS));
    const confirmado = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 8000);
      socket.once("CHATS_BOX_RESPONSE", (data: unknown) => {
        clearTimeout(t);
        const chat = Array.isArray(data) ? data[0] as { mensajes?: MensajeIC[] } : null;
        const msgs = chat?.mensajes ?? [];
        const desde = Date.now() - 5 * 60_000;
        resolve(msgs.some((m) =>
          m.rol_mensaje === 1 &&
          String(m.texto_mensaje ?? "").trim() === opts.mensaje.trim() &&
          (!m.created_at || Date.parse(m.created_at) >= desde)));
      });
      socket.emit("GET_CHATS_BOX", {
        chatId: Number(opts.chatId) || opts.chatId,
        id_configuracion: opts.idConf,
        jwt_token: opts.token,
      });
    });

    cerrar();
    return confirmado
      ? { ok: true, confirmado: true, detalle: "enviado y confirmado en el chat" }
      // Enviado sin confirmar NO es un éxito: puede haberse perdido. El
      // llamador NO marca el pedido como avisado con esto.
      : { ok: false, confirmado: false, detalle: "se emitió pero no apareció en el chat al releerlo" };
  } catch (e) {
    cerrar();
    return { ok: false, confirmado: false, detalle: e instanceof Error ? e.message : String(e) };
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
      token: String(cfg.session_token),
      idConf: Number(cfg.id_configuracion),
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

    // Y queda como GESTIÓN en Guardian, con el mismo formato que usa el resto
    // de la pantalla (`SEG: ...`) para que los contadores lo reconozcan.
    if (pedido.phone) {
      const ahora = new Date();
      await sb.from("touchpoints").insert({
        phone: pedido.phone,
        action: "SEG: Escribí por WhatsApp",
        operator_id: u.user.id,
        store_id: storeId,
        action_date: new Date(ahora.getTime() - 5 * 3600_000).toISOString().slice(0, 10),
        action_time: ahora.toISOString().slice(11, 16),
      });
    }

    return json({ ok: true, confirmado: true, autor, enviado_a: pedido.phone });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[importchat-send]", msg);
    return json({ ok: false, error: msg }, 500);
  }
});

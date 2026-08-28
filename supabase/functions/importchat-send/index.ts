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
import { normalizarConversacion, ultimoEntranteMs, type MensajeConversacion } from "../_shared/conversacion.ts";
import { ensureFreshImporchatToken, decodeJwtExp, IMPORCHAT_BASE_DEFAULT } from "../_shared/imporchatSession.ts";
import { fechaHoraLocal } from "../_shared/horaLocal.ts";

const MAX_LARGO = 1000;
/** Reintentos de RELECTURA tras emitir (ms de espera antes de cada uno). Con una
 *  sola espera fija, si ImporChat tardaba en persistir daba falso negativo → la
 *  asesora reintentaba → DOBLE WhatsApp al cliente (finding #2). Con reintentos
 *  se confirma apenas aparece, y el caso normal es MÁS rápido que la espera vieja. */
const RELECTURA_MS = [1500, 2000, 3000];

/** Cuántos salientes con EXACTAMENTE este texto hay en el hilo crudo. */
function contarMismoTexto(
  crudos: Array<{ rol_mensaje?: number; texto_mensaje?: unknown }>,
  texto: string,
): number {
  const t = texto.trim();
  return crudos.filter(
    (m) => m.rol_mensaje === 1 && String(m.texto_mensaje ?? "").trim() === t,
  ).length;
}

/**
 * Conecta, emite el mensaje y RELEE el chat para confirmar que salió.
 *
 * ⛔ Confirma por CONTEO, no por "existe un mensaje con este texto" (finding #1):
 * lee el hilo ANTES de emitir y cuenta cuántas copias exactas de este texto ya
 * hay; después de emitir, confirma SOLO si apareció una copia NUEVA. Así una
 * respuesta enlatada idéntica mandada antes, o un saludo del bot igual, NO se
 * confunde con "mi mensaje salió" — el falso "enviado" que la regla de la casa
 * prohíbe. NO se compara por hora: el `created_at` del socket puede venir en
 * local sin zona y el filtro temporal daba falsos positivos y negativos.
 *
 * El hilo normalizado se devuelve APARTE para que la pantalla no lo pida de nuevo.
 */
async function enviarPorSocket(opts: {
  cred: CredencialIC; chatId: string; telefono: string;
  mensaje: string; autor: string;
  // Fallback de la ventana para cuando NO se pudo releer el hilo (raro): la marca
  // de la base. Con el hilo fresco en la mano NO se usa.
  entranteAtDb: number | null; leidoDb: boolean;
}): Promise<{ ok: boolean; confirmado: boolean; detalle: string; mensajes: MensajeConversacion[]; ventanaCerrada?: string }> {
  try {
    return await usarSocket(async (socket) => {
      // Baseline: cuántas copias de este texto ya había. Si no se pudo leer antes
      // (raro), no hay baseline y se cae a "aparece al menos una" — el único caso
      // con riesgo de falso positivo, pero mejor que bloquear siempre.
      const antes = await leerChat(socket, opts.cred, opts.chatId);
      const conBaseline = antes !== null;
      const antesN = conBaseline ? contarMismoTexto(antes, opts.mensaje) : 0;

      // ⛔ VENTANA DE 24h decidida acá, con el hilo RECIÉN LEÍDO — no con la
      // columna del sync (hasta 30 min vieja). Antes se gateaba arriba con la
      // columna: si el cliente respondía EN VIVO tras el último sync, la columna
      // decía "hace 25h" → 409 y se bloqueaba una respuesta perfectamente
      // entregable. El hilo fresco trae SIEMPRE el último entrante, así que la
      // ventana solo puede ABRIRSE respecto de la columna, nunca cerrarse de
      // más. Sin baseline (no se pudo releer) se cae a la marca de la base.
      const ultimoEnt = conBaseline ? ultimoEntranteMs(normalizarConversacion(antes)) : opts.entranteAtDb;
      const leido = conBaseline ? true : opts.leidoDb;
      const vFresca = ventanaWhatsapp(ultimoEnt, leido);
      if (vFresca.estado !== "abierta") {
        return {
          ok: false, confirmado: false, ventanaCerrada: vFresca.estado,
          detalle: MOTIVO_VENTANA[vFresca.estado], mensajes: [],
        };
      }

      emitirMensaje(socket, opts.cred, {
        chatId: opts.chatId, telefono: opts.telefono,
        mensaje: opts.mensaje, autor: opts.autor,
      });

      // Releer con reintentos hasta ver la copia nueva (o agotar los intentos).
      let crudos: Awaited<ReturnType<typeof leerChat>> = null;
      for (const espera of RELECTURA_MS) {
        await new Promise((r) => setTimeout(r, espera));
        crudos = await leerChat(socket, opts.cred, opts.chatId);
        if (crudos !== null && contarMismoTexto(crudos, opts.mensaje) > antesN) break;
      }
      // No poder releer NO es "no llegó": es no saber, y no saber se trata como
      // fallo (marcar un pedido como avisado sin confirmar es peor que reintentar).
      if (crudos === null) {
        return { ok: false, confirmado: false, detalle: "ImporChat no contestó al releer el chat", mensajes: [] };
      }

      const despuesN = contarMismoTexto(crudos, opts.mensaje);
      const confirmado = conBaseline ? despuesN > antesN : despuesN > 0;

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

    // ── La ventana de 24 h ─────────────────────────────────────────────────
    // `v` (columna de la base) es solo para el PREVIEW del dry_run. La decisión
    // REAL de si se puede enviar la toma `enviarPorSocket` con el hilo recién
    // leído (ver la nota ahí): la columna del sync puede tener 30 min y bloquear
    // una respuesta al cliente que acaba de escribir. NO se rechaza acá.
    const v = ventanaWhatsapp(
      pedido.chat_entrante_at ? Date.parse(pedido.chat_entrante_at) : null,
      !!pedido.chat_leido_at,
    );

    // ── Credenciales de la tienda ─────────────────────────────────────────
    const { data: cfg } = await sb.from("store_importchat_config")
      .select("id_configuracion, session_token, token_expira_at, habilitado, api_base")
      .eq("store_id", storeId).maybeSingle();
    if (!cfg?.habilitado || !cfg?.session_token) {
      return json({ ok: false, error: "Esta tienda no tiene ImporChat configurado" }, 409);
    }
    // finding #11: self-heal barato de la llave (antes solo el cron la renovaba;
    // si el cron se caía cerca del vencimiento se apagaba el WhatsApp interactivo).
    // En el camino feliz NO toca red — devuelve la llave que ya había.
    const token = await ensureFreshImporchatToken(sb, {
      storeId,
      base: String(cfg.api_base || IMPORCHAT_BASE_DEFAULT),
      sessionToken: String(cfg.session_token),
      tokenExpiraAt: cfg.token_expira_at ? String(cfg.token_expira_at) : null,
    });
    const expSeg = decodeJwtExp(token);
    if (expSeg && expSeg * 1000 < Date.now()) {
      return json({ ok: false, error: "La credencial de ImporChat venció y no se pudo renovar. Hay que renovarla." }, 409);
    }
    // País de la tienda → fecha/hora LOCAL del touchpoint (finding #9).
    const { data: tienda } = await sb.from("stores")
      .select("country_code").eq("id", storeId).maybeSingle();
    const cc = String(tienda?.country_code || "CO");

    // Nombre de quien escribe: queda registrado en ImporChat como responsable,
    // y es lo que después distingue un mensaje de la asesora de uno del bot.
    //
    // ⛔ Medido en producción el 25-ago-2026: esto pedía `full_name` filtrando
    // por `id`, y las DOS cosas estaban mal — la tabla tiene `display_name` y
    // se busca por `user_id`. El SELECT devolvía 42703 (columna inexistente),
    // el `?.` se tragaba el error y el autor caía al **correo personal** de
    // quien escribía. O sea: en ImporChat el responsable habría quedado como
    // "estefano@gmail.com" en vez de "Estefano Moreno" — justo lo contrario de
    // lo que este campo existe para lograr, y con el correo de la asesora
    // guardado en el panel de un tercero.
    //
    // El correo queda como último recurso a propósito (un nombre vacío sería
    // peor: no se sabría quién escribió), pero ya no es el caso normal.
    const { data: perfil } = await sb.from("profiles")
      .select("display_name").eq("user_id", u.user.id).maybeSingle();
    const autor = String(perfil?.display_name || u.user.email || "Guardian");

    if (dryRun) {
      return json({
        ok: true, dry_run: true, enviaria_a: pedido.phone,
        chat_id: pedido.importchat_chat_id, autor, ventana: v.estado,
        restante_horas: v.restanteMs == null ? null : Math.round(v.restanteMs / 3600_000),
      });
    }

    const r = await enviarPorSocket({
      cred: { token, idConf: Number(cfg.id_configuracion) },
      chatId: String(pedido.importchat_chat_id),
      telefono: String(pedido.phone || ""),
      mensaje, autor,
      entranteAtDb: pedido.chat_entrante_at ? Date.parse(pedido.chat_entrante_at) : null,
      leidoDb: !!pedido.chat_leido_at,
    });
    // La ventana la decidió el hilo fresco: si está cerrada, es un 409 (hay que
    // mandar plantilla), no un 502 de "no se pudo confirmar".
    if (r.ventanaCerrada) {
      return json({ ok: false, error: r.detalle, ventana: r.ventanaCerrada }, 409);
    }
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
      const { fecha, hora } = fechaHoraLocal(cc);
      const modulo = body?.modulo === "WHATSAPP" ? "WHATSAPP" : "SEG";
      // QUÉ se hizo, no solo que se escribió. El botón de acción principal
      // manda "Avisé: en oficina" / "Envié la guía" —los mismos textos de la
      // botonera— para que la bitácora diga cuál de las seis gestiones fue.
      // Sin `accion` queda el texto de siempre: un cliente viejo se comporta
      // igual. Se acota para que nadie meta un párrafo en la bitácora.
      const accion = String(body?.accion ?? "").trim().slice(0, 60) || "Escribí por WhatsApp";
      await sb.from("touchpoints").insert({
        phone: pedido.phone,
        action: `${modulo}: ${accion}`,
        operator_id: u.user.id,
        store_id: storeId,
        action_date: fecha,
        action_time: hora,
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

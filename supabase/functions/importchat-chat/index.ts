// importchat-chat — leer la conversación de WhatsApp de un pedido.
//
// Pedido del dueño: "unificar ImporChat como lo hicimos con Dropi". Con Dropi
// la vara es que la asesora NUNCA abre Dropi. Con ImporChat se podía escribir
// pero no LEER: para ver qué había dicho el cliente había que irse a otra
// pestaña, o sea que se escribía a ciegas.
//
// El dato ya estaba y se tiraba: `importchat-send` pedía la conversación entera
// solo para verificar que su mensaje había salido, y se quedaba con un
// true/false. Acá se devuelve el hilo, con el `responsable` de cada mensaje —
// que es lo que por fin contesta "¿lo escribió el bot o la asesora?" mensaje
// por mensaje.
//
// Auth: SOLO Bearer de un miembro de la tienda. Leer la conversación privada de
// un cliente es un acto humano; acá NO hay camino de cron, igual que en `send`.
// Body: { store_id, external_id }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { usarSocket, leerChat } from "../_shared/imporchatSocket.ts";
import { normalizarConversacion, ultimoEntranteMs, ultimoSaliente } from "../_shared/conversacion.ts";
import { ventanaWhatsapp } from "../_shared/ventanaWhatsapp.ts";
import { ensureFreshImporchatToken, decodeJwtExp, IMPORCHAT_BASE_DEFAULT } from "../_shared/imporchatSession.ts";

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
    if (!storeId || !externalId) {
      return json({ ok: false, error: "Faltan store_id o external_id" }, 400);
    }

    // ── Auth: miembro de la tienda, sin atajo de cron ──────────────────────
    const auth = req.headers.get("Authorization") ?? "";
    const { data: u } = await sb.auth.getUser(auth.replace("Bearer ", ""));
    if (!u?.user) return json({ ok: false, error: "no autenticado" }, 401);
    const { data: miembro } = await sb.from("store_members")
      .select("role").eq("store_id", storeId).eq("user_id", u.user.id).maybeSingle();
    if (!miembro) return json({ ok: false, error: "no sos miembro de esa tienda" }, 403);

    // ── Credenciales de la tienda ─────────────────────────────────────────
    // ⚠️ Va ANTES del pedido a propósito. Al revés, una tienda que no usa
    // ImporChat (los otros dueños, que usan otras IA) recibía "todavía no tiene
    // conversación leída, esperá al próximo sync" — un mensaje que promete algo
    // que nunca va a pasar, porque para esa tienda no hay ningún sync.
    // Verificado en producción el 25-ago-2026 contra un pedido de Colombia.
    // Además así ni se consulta la tabla de pedidos para quien no puede usar
    // la función.
    const { data: cfg } = await sb.from("store_importchat_config")
      .select("id_configuracion, session_token, token_expira_at, habilitado, api_base")
      .eq("store_id", storeId).maybeSingle();
    if (!cfg?.habilitado || !cfg?.session_token) {
      return json({ ok: false, sin_config: true, error: "Esta tienda no tiene ImporChat configurado" }, 409);
    }
    // finding #11: self-heal barato de la llave (no solo el cron). Camino feliz sin red.
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

    // ── El pedido y su conversación ───────────────────────────────────────
    const { data: pedido, error: pedErr } = await sb.from("orders")
      .select("id, phone, nombre, importchat_chat_id")
      .eq("store_id", storeId).eq("external_id", externalId).maybeSingle();
    if (pedErr) {
      if (/importchat_chat_id/i.test(pedErr.message)) {
        return json({ ok: false, error: "Falta aplicar la migración 20260825010000 (importchat_chat_id)" }, 503);
      }
      throw new Error(pedErr.message);
    }
    if (!pedido) return json({ ok: false, error: "No encontré ese pedido en esta tienda" }, 404);
    if (!pedido.importchat_chat_id) {
      return json({
        ok: false, sin_chat: true,
        error: "Este pedido todavía no tiene conversación leída de ImporChat. Esperá al próximo sync.",
      }, 409);
    }

    const cred = { token, idConf: Number(cfg.id_configuracion) };
    const crudos = await usarSocket((s) => leerChat(s, cred, String(pedido.importchat_chat_id)));

    // ⛔ `null` (no contestó) y `[]` (chat vacío) NO son lo mismo. Devolver una
    // lista vacía cuando en realidad no se pudo leer haría que la pantalla
    // afirmara "no hay conversación" sobre un chat que quizá está lleno.
    if (crudos === null) {
      return json({ ok: false, error: "ImporChat no contestó a tiempo. Probá de nuevo." }, 504);
    }

    const mensajes = normalizarConversacion(crudos);
    const entranteMs = ultimoEntranteMs(mensajes);
    // La ventana se recalcula con lo RECIÉN leído, no con la columna del sync
    // (que puede tener media hora). Misma función que usan el botón y `send`.
    const v = ventanaWhatsapp(entranteMs, true);

    // ── Efecto lateral barato: dejar el pedido fresco ─────────────────────
    // Abrir un chat actualiza la actividad sin esperar al cron.
    // ⛔ NO se toca `chat_leido_at`: es la marca que usa `importchat-sync` para
    // su atajo de reanudación. Escribirla acá haría que el sync saltee este
    // pedido durante 6 h y sus otras columnas (riesgo, mudo, botón) —que esta
    // función NO calcula— se quedarían viejas sin que nadie se entere.
    const saliente = ultimoSaliente(mensajes);
    // ⛔ `chat_entrante_at` se escribe SOLO si de verdad vimos un mensaje del
    // cliente en esta lectura — NUNCA se pisa con null. Un historial truncado o
    // vacío (el socket a veces no trae el último entrante) daría entranteMs=null
    // y borraría una medición buena; después `importchat-send` gatea la ventana
    // de 24 h con esa columna y bloquearía un envío legítimo (finding #6). Mismo
    // criterio "un null no borra un dato medido" que el saliente de acá abajo.
    const parche: Record<string, unknown> = {};
    if (entranteMs) parche.chat_entrante_at = new Date(entranteMs).toISOString();
    if (saliente) {
      parche.chat_saliente_at = new Date(saliente.fechaMs).toISOString();
      parche.chat_saliente_tipo = saliente.tipo;
    }
    // Que no se pueda refrescar el pedido no invalida el hilo que ya leímos:
    // se avisa por consola y se devuelve la conversación igual.
    if (Object.keys(parche).length > 0) {
      const { error: upErr } = await sb.from("orders").update(parche)
        .eq("store_id", storeId).eq("external_id", externalId);
      if (upErr) console.error("[importchat-chat] no se pudo refrescar el pedido:", upErr.message);
    }

    return json({
      ok: true,
      mensajes,
      ventana: { estado: v.estado, restanteMs: v.restanteMs },
      ultimo_entrante_ms: entranteMs,
      chat_id: String(pedido.importchat_chat_id),
      cliente: { nombre: pedido.nombre ?? null, telefono: pedido.phone ?? null },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[importchat-chat]", msg);
    return json({ ok: false, error: msg }, 500);
  }
});

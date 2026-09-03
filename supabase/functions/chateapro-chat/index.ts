// chateapro-chat — leer la conversación de WhatsApp de un pedido de Colombia.
//
// Gemelo de `importchat-chat`, pero contra Chatea Pro (chateapro.app, whitelabel
// de UChat). Devuelve EXACTAMENTE la misma forma —`{ok, mensajes, ventana}` /
// `{sin_config}` / `{sin_chat}`— para que `useConversacion` y las pantallas que
// ya existen funcionen sin cambiarles nada por dentro.
//
// ── La diferencia con ImporChat ────────────────────────────────────────────
// ImporChat necesita socket.io y un `importchat_chat_id` que el cron va
// guardando en cada pedido. Chatea Pro es REST y no hace falta ningún sync
// previo: el cliente se encuentra por TELÉFONO (`GET /subscribers?phone=`) y de
// ahí sale el `user_ns`. O sea que esto funciona desde el primer día, sin
// esperar a que un cron haya pasado por el pedido.
//
// Auth: SOLO Bearer de un miembro de la tienda. Leer la conversación privada de
// un cliente es un acto humano; acá NO hay camino de cron.
// Body: { store_id, external_id }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { respuestaPing } from "../_shared/versionEdge.ts";
import { ventanaWhatsapp } from "../_shared/ventanaWhatsapp.ts";
import {
  cargarConfigChateapro,
  buscarSuscriptorPorTelefono,
  leerHilo,
  ChateaproError,
} from "../_shared/chateaproApi.ts";

const VERSION = "chateapro-chat 2026-09-03.1 abrir-el-chat-refresca-el-pedido";

Deno.serve(async (req) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  { const p = respuestaPing(req, VERSION, cors); if (p) return p; }

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

    // ── Auth: miembro de la tienda ────────────────────────────────────────
    const auth = req.headers.get("Authorization") ?? "";
    const { data: u } = await sb.auth.getUser(auth.replace("Bearer ", ""));
    if (!u?.user) return json({ ok: false, error: "no autenticado" }, 401);
    const { data: miembro } = await sb.from("store_members")
      .select("role").eq("store_id", storeId).eq("user_id", u.user.id).maybeSingle();
    if (!miembro) return json({ ok: false, error: "no sos miembro de esa tienda" }, 403);

    // ── Credenciales ANTES del pedido ─────────────────────────────────────
    // Misma lección que en ImporChat: al revés, una tienda sin Chatea Pro
    // recibía un mensaje que prometía algo que nunca iba a pasar.
    const cfg = await cargarConfigChateapro(sb, storeId);
    if (!cfg) {
      return json({ ok: false, sin_config: true, error: "Esta tienda no tiene Chatea Pro configurado" }, 409);
    }

    const { data: pedido, error: pedErr } = await sb.from("orders")
      .select("phone, nombre")
      .eq("store_id", storeId).eq("external_id", externalId).maybeSingle();
    if (pedErr) throw new Error(pedErr.message);
    if (!pedido) return json({ ok: false, error: "No encontré ese pedido en esta tienda" }, 404);
    if (!pedido.phone) {
      return json({ ok: false, sin_chat: true, error: "Este pedido no tiene teléfono, no hay por dónde buscar la conversación." }, 409);
    }

    // El país decide el indicativo con el que Chatea Pro pudo haber guardado el
    // teléfono (`+57…` cuando el contacto lo creó la API).
    const { data: tiendaPais } = await sb.from("stores")
      .select("country_code").eq("id", storeId).maybeSingle();
    const cc = String(tiendaPais?.country_code || "CO");
    const sus = await buscarSuscriptorPorTelefono(cfg, String(pedido.phone), cc);
    if (!sus) {
      // ⛔ Esto NO es un error: significa que ese teléfono todavía nunca
      // escribió por WhatsApp. Se dice tal cual, porque "no se encontró" y
      // "falló la lectura" llevan a la asesora a acciones distintas.
      return json({
        ok: false, sin_chat: true,
        error: "Este cliente todavía no tiene conversación en Chatea Pro (nunca escribió).",
      }, 409);
    }

    const hilo = await leerHilo(cfg, sus.user_ns);

    // `leido = true`: acabamos de leer el hilo de verdad, no es un dato viejo
    // de un sync. La ventana se calcula con el último mensaje DEL CLIENTE.
    const ventana = ventanaWhatsapp(hilo.ultimoEntranteMs, true);

    // ── Efecto lateral barato: dejar el pedido fresco ─────────────────────
    // ⛔ Faltaba, y en Ecuador está desde el principio (3-sep-2026).
    //
    // Acabamos de leer la conversación de verdad. Sin escribirla, la tarjeta
    // del tablero sigue mostrando lo que dejó el sync —hasta 10 minutos viejo—
    // aunque la asesora tenga el hilo abierto delante. Y lo caro no es el
    // retraso: si el cliente escribió recién, la columna vieja dice "vencida" y
    // la pantalla ofrece PLANTILLA, que se paga, sobre una ventana que estaba
    // abierta y admitía un mensaje gratis.
    //
    // ⛔ NO se toca `chat_leido_at`. Es la cola de la fase 5 de `chateapro-sync`
    // (rescate por teléfono) y su marca de "esto ya lo miré": escribirla acá
    // sacaría al pedido de esa cola sin haber calculado las columnas que esta
    // función NO calcula (riesgo, mudo, botón de confirmar).
    //
    // ⛔ Nunca se pisa con null: un hilo truncado daría `ultimoEntranteMs` nulo
    // y borraría una medición buena, y después `chateapro-send` bloquearía un
    // envío legítimo con esa columna vacía. Un null no borra un dato medido.
    const salientes = hilo.mensajes.filter((m) => m.de === "negocio" && m.fechaMs != null);
    const ultimoSaliente = salientes.length ? salientes[salientes.length - 1] : null;
    const parche: Record<string, unknown> = {};
    if (hilo.ultimoEntranteMs) {
      parche.chat_entrante_at = new Date(hilo.ultimoEntranteMs).toISOString();
    }
    if (ultimoSaliente?.fechaMs) {
      parche.chat_saliente_at = new Date(ultimoSaliente.fechaMs).toISOString();
      parche.chat_saliente_tipo = ultimoSaliente.plantilla ? "plantilla" : "directo";
    }
    // Que no se pueda refrescar el pedido no invalida el hilo que ya leímos: se
    // avisa por consola y la conversación se devuelve igual.
    if (Object.keys(parche).length > 0) {
      const { error: upErr } = await sb.from("orders").update(parche)
        .eq("store_id", storeId).eq("external_id", externalId);
      if (upErr) console.error("[chateapro-chat] no se pudo refrescar el pedido:", upErr.message);
    }

    return json({
      ok: true,
      mensajes: hilo.mensajes,
      ventana,
      // Para que el envío no tenga que volver a buscar por teléfono.
      user_ns: sus.user_ns,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof ChateaproError && e.status === 401) {
      return json({ ok: false, error: "La API key de Chatea Pro no es válida o venció. Hay que renovarla." }, 409);
    }
    console.error("chateapro-chat:", msg);
    return json({ ok: false, error: msg }, 500);
  }
});

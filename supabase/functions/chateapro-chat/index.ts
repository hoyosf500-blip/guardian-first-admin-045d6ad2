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

const VERSION = "chateapro-chat 2026-09-02.1 alta";

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

    const sus = await buscarSuscriptorPorTelefono(cfg, String(pedido.phone));
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

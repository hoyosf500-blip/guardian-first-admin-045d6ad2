// chateapro-send — responderle al cliente de Colombia SIN salir de Guardian.
//
// Gemelo de `importchat-send` contra Chatea Pro. Devuelve la misma forma
// (`{ok, mensajes}`) para que `useEnviarWhatsapp` no cambie por dentro.
//
// ── Las tres reglas que NO se negocian (las mismas de ImporChat) ───────────
// 1. **Ventana de 24 h**: Meta solo entrega texto libre dentro de las 24 h del
//    último mensaje DEL CLIENTE. Fuera de ella el mensaje no llega y NADIE se
//    entera — la asesora queda convencida de que avisó. Se bloquea acá, en el
//    servidor, no solo en el botón.
// 2. **Se VERIFICA que salió**: después de enviar se relee el hilo y se busca
//    el mensaje. Si no aparece, se responde "no se pudo confirmar" y no se
//    marca nada como enviado. Un "listo" sin confirmar es peor que un error.
// 3. **Queda el AUTOR**: va como `send_as_agent`, así Chatea Pro lo registra
//    como asesor y no como bot.
//
// Body: { store_id, external_id, mensaje, modulo?, accion? }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { respuestaPing } from "../_shared/versionEdge.ts";
import { ventanaWhatsapp } from "../_shared/ventanaWhatsapp.ts";
import { fechaHoraLocal } from "../_shared/horaLocal.ts";
import {
  cargarConfigChateapro,
  buscarSuscriptorPorTelefono,
  leerHilo,
  enviarTexto,
  ChateaproError,
} from "../_shared/chateaproApi.ts";

const VERSION = "chateapro-send 2026-09-02.2 medido-contra-la-api";

/** ¿El texto que mandamos aparece en el hilo releído? Comparación floja a
 *  propósito: Chatea Pro puede recortar espacios o normalizar saltos de línea,
 *  y un "no se pudo confirmar" falso hace que la asesora escriba dos veces. */
function apareceEnHilo(mensajes: { de: string; texto: string }[], texto: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const buscado = norm(texto);
  return mensajes.some((m) => m.de === "negocio" && norm(m.texto).includes(buscado.slice(0, 120)));
}

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
    const mensaje = String(body?.mensaje || "").trim();
    if (!storeId || !externalId || !mensaje) {
      return json({ ok: false, error: "Faltan store_id, external_id o mensaje" }, 400);
    }

    const auth = req.headers.get("Authorization") ?? "";
    const { data: u } = await sb.auth.getUser(auth.replace("Bearer ", ""));
    if (!u?.user) return json({ ok: false, error: "no autenticado" }, 401);
    const { data: miembro } = await sb.from("store_members")
      .select("role").eq("store_id", storeId).eq("user_id", u.user.id).maybeSingle();
    if (!miembro) return json({ ok: false, error: "no sos miembro de esa tienda" }, 403);

    const cfg = await cargarConfigChateapro(sb, storeId);
    if (!cfg) {
      return json({ ok: false, sin_config: true, error: "Esta tienda no tiene Chatea Pro configurado" }, 409);
    }

    const { data: pedido, error: pedErr } = await sb.from("orders")
      .select("phone, nombre").eq("store_id", storeId).eq("external_id", externalId).maybeSingle();
    if (pedErr) throw new Error(pedErr.message);
    if (!pedido?.phone) {
      return json({ ok: false, error: "Ese pedido no tiene teléfono: no hay a quién escribirle." }, 409);
    }

    const sus = await buscarSuscriptorPorTelefono(cfg, String(pedido.phone));
    if (!sus) {
      return json({
        ok: false, sin_chat: true,
        error: "Este cliente nunca escribió por WhatsApp, así que no hay conversación abierta. Solo se le puede mandar una plantilla.",
      }, 409);
    }

    // ── Regla 1: la ventana ───────────────────────────────────────────────
    const antes = await leerHilo(cfg, sus.user_ns);
    const ventana = ventanaWhatsapp(antes.ultimoEntranteMs, true);
    if (ventana.estado !== "abierta") {
      const motivo = ventana.estado === "nunca_escribio"
        ? "Este cliente nunca escribió, así que WhatsApp no entrega texto libre."
        : "Pasaron más de 24 horas desde el último mensaje del cliente: WhatsApp NO entrega texto libre.";
      return json({
        ok: false, ventana_vencida: true,
        error: `${motivo} Mandale una plantilla.`,
        ventana,
      }, 409);
    }

    // ── Enviar ────────────────────────────────────────────────────────────
    await enviarTexto(cfg, sus.user_ns, mensaje, true);

    // ── Regla 2: verificar que salió ──────────────────────────────────────
    const despues = await leerHilo(cfg, sus.user_ns);
    if (!apareceEnHilo(despues.mensajes, mensaje)) {
      return json({
        ok: false,
        error: "Chatea Pro aceptó el envío pero el mensaje no aparece en la conversación. NO lo des por enviado: revisalo en Chatea Pro.",
        mensajes: despues.mensajes,
      }, 502);
    }

    // ── Queda en el pedido y en la bitácora ───────────────────────────────
    await sb.from("orders").update({
      chat_saliente_at: new Date().toISOString(),
      chat_saliente_tipo: "directo",
    }).eq("store_id", storeId).eq("external_id", externalId);

    // Mismo prefijo que ImporChat: `SEG:` cuenta como gestión de Seguimiento y
    // `WHATSAPP:` como intento de contacto desde Confirmar. Si esto se
    // desalinea, el trabajo de una pantalla le suma puntos a la otra.
    const { data: tienda } = await sb.from("stores")
      .select("country_code").eq("id", storeId).maybeSingle();
    const { fecha, hora } = fechaHoraLocal(String(tienda?.country_code || "CO"));
    const modulo = body?.modulo === "WHATSAPP" ? "WHATSAPP" : "SEG";
    const accion = String(body?.accion ?? "").trim().slice(0, 60) || "Escribí por WhatsApp";
    await sb.from("touchpoints").insert({
      phone: pedido.phone,
      action: `${modulo}: ${accion}`,
      operator_id: u.user.id,
      store_id: storeId,
      action_date: fecha,
      action_time: hora,
    });

    return json({ ok: true, confirmado: true, enviado_a: pedido.phone, mensajes: despues.mensajes });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof ChateaproError && e.status === 401) {
      return json({ ok: false, error: "La API key de Chatea Pro no es válida o venció. Hay que renovarla." }, 409);
    }
    console.error("[chateapro-send]", msg);
    return json({ ok: false, error: msg }, 500);
  }
});

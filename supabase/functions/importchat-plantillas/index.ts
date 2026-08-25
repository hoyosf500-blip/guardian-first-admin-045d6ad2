// importchat-plantillas — escribirle al cliente cuando ya pasaron las 24 h.
//
// Pedido del dueño (25-ago-2026), mirando un pedido detenido en agencia:
// "mira por qué no puedo escribir, y si ya se pasaron las 24 horas, enviar
// plantilla creada, que salga la opción".
//
// ── El hueco que tapa ──────────────────────────────────────────────────────
// `importchat-send` manda texto libre, y Meta solo lo entrega dentro de las
// 24 h del último mensaje DEL CLIENTE (ver `ventanaWhatsapp.ts`). Pasada esa
// ventana Guardian decía "llamalo por teléfono" y ahí se terminaba — cuando en
// realidad SÍ hay camino: una plantilla aprobada por Meta. La cuenta tiene 31
// aprobadas y ninguna se estaba usando desde acá.
//
// ── Cómo manda ─────────────────────────────────────────────────────────────
// A diferencia del texto libre (socket), las plantillas SÍ tienen REST. Rutas
// verificadas el 25-ago-2026 leyendo el propio panel de ImporChat:
//   POST /whatsapp_managment/obtenerTemplatesWhatsapp {id_configuracion,limit}
//   POST /whatsapp_managment/enviar_template_masivo   {id_configuracion, body,
//                                                      id_cliente_chat_center}
// Se llama "masivo" pero acepta UN destinatario: es la misma llamada que hace
// el panel cuando la asesora manda una plantilla desde un chat. Va por el
// servidor de ImporChat (no directo a Meta) a propósito: así el mensaje queda
// DENTRO de la conversación de siempre y no parte el hilo.
//
// `id_cliente_chat_center` es el mismo id que Guardian ya guarda en
// `orders.importchat_chat_id` — confirmado en el código del panel, que usa
// `selectedChat.id` tanto para `GET_CHATS_BOX` como para enviar.
//
// ── Reglas que NO se negocian ──────────────────────────────────────────────
// 1. **Los huecos van completos.** Son POSICIONALES (`{{1}}`, `{{2}}`): un
//    parámetro de menos corre todos los demás y al cliente le llega otra cosa.
//    Se revalida ACÁ, no solo en el botón.
// 2. **Lo que Guardian no puede armar, no se manda.** Las plantillas con video,
//    imagen o botón-con-enlace se rechazan con el motivo, en vez de mandar algo
//    que Meta rebota o que llega roto.
// 3. **Solo se marca el pedido si ImporChat confirmó** (`success:true`). Un
//    "listo" sin confirmar haría que la asesora tache el pedido de su lista.
//
// Auth: SOLO Bearer de un miembro de la tienda. Sin camino de cron, igual que
// `importchat-send`: mandarle un WhatsApp a un cliente es un acto humano.
// Body: { store_id, accion: 'listar'|'enviar', external_id?, nombre?, valores? }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { getWhatsAppPhone } from "../_shared/telefonoWhatsapp.ts";
import {
  parsearPlantillas, construirPayloadMeta, faltantes, ordenarParaFase,
  type PlantillaMeta,
} from "../_shared/plantillasMeta.ts";

const BASE_IC = "https://chat.imporfactory.app/api/v1";
const TIMEOUT_MS = 25_000;

async function postIC(ruta: string, token: string, cuerpo: unknown): Promise<{ ok: boolean; datos: Record<string, unknown> | null; detalle: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${BASE_IC}/${ruta}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(cuerpo),
      signal: ctrl.signal,
    });
    const texto = await r.text();
    let datos: Record<string, unknown> | null = null;
    try { datos = JSON.parse(texto); } catch { /* no era JSON */ }
    if (!r.ok) {
      // 401 acá es la credencial de 7 días vencida, que es el fallo más común
      // y el que más confunde: se dice con todas las letras.
      const motivo = r.status === 401
        ? "La credencial de ImporChat venció (dura 7 días). Hay que renovarla en la configuración."
        : String(datos?.message || texto.slice(0, 200) || `HTTP ${r.status}`);
      return { ok: false, datos, detalle: motivo };
    }
    return { ok: true, datos, detalle: "" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, datos: null, detalle: msg.includes("abort") ? "ImporChat no contestó a tiempo" : msg };
  } finally {
    clearTimeout(t);
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
    const accion = String(body?.accion || "listar");
    if (!storeId) return json({ ok: false, error: "Falta store_id" }, 400);
    if (accion !== "listar" && accion !== "enviar") {
      return json({ ok: false, error: "accion tiene que ser 'listar' o 'enviar'" }, 400);
    }

    // ── Auth: miembro de la tienda, sin atajo de cron ──────────────────────
    const auth = req.headers.get("Authorization") ?? "";
    const { data: u } = await sb.auth.getUser(auth.replace("Bearer ", ""));
    if (!u?.user) return json({ ok: false, error: "no autenticado" }, 401);
    const { data: miembro } = await sb.from("store_members")
      .select("role").eq("store_id", storeId).eq("user_id", u.user.id).maybeSingle();
    if (!miembro) return json({ ok: false, error: "no sos miembro de esa tienda" }, 403);

    // ── Credenciales de la tienda ─────────────────────────────────────────
    // Se piden ANTES que el pedido: una tienda sin ImporChat tiene que oír
    // "no está configurado", no "esperá al próximo sync" — ese fue justamente
    // el mensaje engañoso que se corrigió en `importchat-chat` (3526e56).
    const { data: cfg } = await sb.from("store_importchat_config")
      .select("id_configuracion, session_token, token_expira_at, habilitado")
      .eq("store_id", storeId).maybeSingle();
    if (!cfg?.habilitado || !cfg?.session_token) {
      return json({ ok: false, sin_config: true, error: "Esta tienda no tiene ImporChat configurado" }, 409);
    }
    if (cfg.token_expira_at && new Date(cfg.token_expira_at).getTime() < Date.now()) {
      return json({ ok: false, error: `La credencial de ImporChat venció el ${cfg.token_expira_at}. Hay que renovarla.` }, 409);
    }
    const token = String(cfg.session_token);
    const idConf = String(cfg.id_configuracion);

    // ── Las plantillas aprobadas (las dos acciones las necesitan) ──────────
    const lista = await postIC("whatsapp_managment/obtenerTemplatesWhatsapp", token, {
      id_configuracion: idConf, limit: 100,
    });
    if (!lista.ok) return json({ ok: false, error: `No se pudieron leer las plantillas: ${lista.detalle}` }, 502);
    const plantillas = parsearPlantillas(lista.datos?.data);
    if (plantillas.length === 0) {
      // Cero plantillas es un dato raro pero posible (cuenta nueva). Se dice,
      // no se disfraza de error.
      return json({ ok: true, plantillas: [], aviso: "La cuenta no tiene plantillas aprobadas por Meta." });
    }

    if (accion === "listar") {
      const fase = body?.fase ? String(body.fase) : null;
      return json({ ok: true, plantillas: ordenarParaFase(plantillas, fase) });
    }

    // ── Enviar ────────────────────────────────────────────────────────────
    const externalId = String(body?.external_id || "");
    const nombrePlantilla = String(body?.nombre || "");
    if (!externalId || !nombrePlantilla) {
      return json({ ok: false, error: "Faltan external_id o nombre de la plantilla" }, 400);
    }

    const elegida: PlantillaMeta | undefined = plantillas.find((p) => p.nombre === nombrePlantilla);
    if (!elegida) {
      return json({ ok: false, error: `Meta ya no tiene aprobada la plantilla "${nombrePlantilla}"` }, 409);
    }
    if (elegida.noSoportada) {
      return json({ ok: false, error: elegida.noSoportada }, 409);
    }

    // Los valores llegan como {"1":"Ana","2":"Servientrega"}.
    const crudos = (body?.valores ?? {}) as Record<string, unknown>;
    const valores: Record<number, string> = {};
    for (const [k, v] of Object.entries(crudos)) {
      const n = Number(k);
      if (Number.isFinite(n) && n > 0) valores[n] = String(v ?? "").trim();
    }
    const huecos = faltantes(elegida, valores);
    if (huecos.length > 0) {
      return json({
        ok: false,
        error: `Faltan datos de la plantilla (${huecos.join(", ")}). Los huecos son posicionales: si va uno vacío, al cliente le llega el mensaje corrido.`,
        faltantes: huecos,
      }, 400);
    }

    const { data: pedido, error: pedErr } = await sb.from("orders")
      .select("id, phone, importchat_chat_id")
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
        ok: false,
        error: "Este pedido todavía no tiene conversación en ImporChat. Esperá al próximo sync (cada 30 min).",
      }, 409);
    }
    if (!pedido.phone) return json({ ok: false, error: "Ese pedido no tiene teléfono" }, 409);

    // El destinatario lo arma el SERVIDOR con el país de la tienda, usando la
    // misma función que los links de la pantalla — no se confía en el cliente
    // para decidir a qué número sale un WhatsApp.
    const { data: tienda } = await sb.from("stores")
      .select("country_code").eq("id", storeId).maybeSingle();
    const destino = getWhatsAppPhone(String(pedido.phone), tienda?.country_code ?? "CO");

    const payload = construirPayloadMeta(elegida, valores, destino);
    if (body?.dry_run === true) {
      return json({ ok: true, dry_run: true, enviaria_a: destino, payload, chat_id: pedido.importchat_chat_id });
    }

    const envio = await postIC("whatsapp_managment/enviar_template_masivo", token, {
      id_configuracion: idConf,
      body: payload,
      id_cliente_chat_center: String(pedido.importchat_chat_id),
      header_default_asset: null,
    });
    if (!envio.ok) return json({ ok: false, error: `Meta rechazó el envío: ${envio.detalle}` }, 502);
    if (envio.datos?.success !== true) {
      // Respondió 200 pero sin confirmar: NO se marca nada. Un "listo" sin
      // confirmación es peor que un error — la asesora tacharía el pedido.
      return json({
        ok: false,
        error: String(envio.datos?.message || "ImporChat no confirmó el envío"),
      }, 502);
    }

    // Recién con el envío CONFIRMADO se marca el pedido. `plantilla` (no
    // `directo`) es el mismo vocabulario que ya usa `chat_saliente_tipo`.
    await sb.from("orders").update({
      chat_saliente_at: new Date().toISOString(),
      chat_saliente_tipo: "plantilla",
    }).eq("store_id", storeId).eq("external_id", externalId);

    const ahora = new Date();
    await sb.from("touchpoints").insert({
      phone: pedido.phone,
      action: `SEG: Mandé la plantilla ${elegida.nombre}`,
      operator_id: u.user.id,
      store_id: storeId,
      action_date: new Date(ahora.getTime() - 5 * 3600_000).toISOString().slice(0, 10),
      action_time: ahora.toISOString().slice(11, 16),
    });

    return json({
      ok: true,
      confirmado: true,
      enviado_a: destino,
      plantilla: elegida.nombre,
      wamid: envio.datos?.wamid ?? null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[importchat-plantillas]", msg);
    return json({ ok: false, error: msg }, 500);
  }
});

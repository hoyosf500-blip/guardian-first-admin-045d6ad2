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
import { ensureFreshImporchatToken, decodeJwtExp, IMPORCHAT_BASE_DEFAULT } from "../_shared/imporchatSession.ts";
import { fechaHoraLocal } from "../_shared/horaLocal.ts";
import { respuestaPing } from "../_shared/versionEdge.ts";
import { enviarPlantillaVerificada } from "../_shared/imporchatPlantillaVerificada.ts";

/**
 * ⛔ MARCA DE LA VERSIÓN DESPLEGADA. Subirla en el MISMO commit que cambie algo,
 * o el ping miente.
 *
 * Las tres funciones de ImporChat eran las únicas del repo que NO podían
 * contestar "¿qué código estás corriendo?" — verificado el 2-sep-2026: al
 * pedirles `?ping=1` devolvían el error de validación de siempre. Lovable no
 * redespliega edge functions al publicar, y sin esto la única forma de saber si
 * un deploy llegó era adivinar comparando comportamientos. Ese agujero ya costó
 * dos rondas enteras en agosto (ver `lovable_despliega_codigo_viejo`).
 */
const VERSION = "importchat-plantillas 2026-09-04.1 no-se-canta-sin-verla";

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
    const idConf = String(cfg.id_configuracion);

    // ── Las plantillas aprobadas (las dos acciones las necesitan) ──────────
    const lista = await postIC("whatsapp_managment/obtenerTemplatesWhatsapp", token, {
      id_configuracion: idConf, limit: 100,
    });
    if (!lista.ok) return json({ ok: false, error: `No se pudieron leer las plantillas: ${lista.detalle}` }, 502);
    // finding #3: "no hay plantillas" (cero real) ≠ "no se pudo medir". Si `data`
    // no es un array (200 con envoltorio inesperado, o body no-JSON), NO afirmar
    // que la cuenta no tiene plantillas — sería un cero falso que le esconde a la
    // asesora la única salida fuera de las 24 h teniendo 31 aprobadas.
    if (!Array.isArray(lista.datos?.data)) {
      return json({ ok: false, error: "ImporChat devolvió las plantillas en un formato inesperado. Reintentá; si sigue, avisá." }, 502);
    }
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

    // ── IDEMPOTENCIA + CONFIRMACIÓN (reescrito el 4-sep-2026) ───────────────
    //
    // Lo que había: se clamaba una fila antes del POST y, si el POST fallaba, se
    // BORRABA. Medido del 25-ago al 4-sep en Ecuador: 14 plantillas anotadas
    // como enviadas y **9 clientes sin recibir nada** — ImporChat contestaba
    // `success:true`, Guardian escribía el touchpoint, pintaba la tarjeta como
    // gestionada, y el mensaje nunca entraba al hilo. Al reintentar, el candado
    // decía "ya se le mandó hoy" sobre un envío que no existió.
    //
    // Ahora el candado significa **"se VIO en el chat"**, no "se intentó":
    //   · la fila se sigue clamando ANTES del POST (es lo único que gana la
    //     carrera de dos clics simultáneos), pero NUNCA SE BORRA: cambia de
    //     `estado`. Borrar destruía la prueba — de los 9 perdidos no quedó
    //     rastro salvo un touchpoint que miente.
    //   · solo `confirmado` bloquea un reenvío. Una fila no confirmada documenta.
    const { fecha: diaLocal } = fechaHoraLocal(tienda?.country_code);
    const ahoraIso = new Date().toISOString();
    /** Un `enviando` más viejo que esto tiene dueño muerto: la plataforma mata
     *  una edge function a los ~150 s. No hay que adivinar. */
    const RECLAMO_MS = 180_000;
    let filaId: string | null = null;

    {
      const ins = await sb.from("importchat_envios").insert({
        store_id: storeId, external_id: externalId, plantilla: elegida.nombre, dia: diaLocal,
        estado: "enviando", intento_at: ahoraIso, operador_id: u.user.id,
        canal: "importchat", chat_id: String(pedido.importchat_chat_id),
      }).select("id").maybeSingle();

      if (!ins.error) {
        filaId = (ins.data as { id?: string } | null)?.id ?? null;
      } else {
        const code = (ins.error as { code?: string }).code;
        const falta = code === "42703" || /column .* does not exist/i.test(ins.error.message || "");
        if (falta) {
          // ⛔ FALLA CERRADO. Antes acá había un `console.warn` y se seguía "sin
          // idempotencia": una degradación silenciosa es exactamente la familia
          // de la que salió este bug. Mejor no mandar y decirlo.
          return json({ ok: false, error: "Falta aplicar la migración 20260904220000 (importchat_envios sin las columnas de confirmación). No se mandó nada." }, 503);
        }
        if (code !== "23505" && !/duplicate key|unique/i.test(ins.error.message || "")) {
          throw new Error(ins.error.message);
        }
        // Ya hay fila de hoy para esta plantilla y este pedido. Se lee para
        // decidir: ¿se confirmó de verdad, hay una en curso, o quedó colgada?
        const { data: previa, error: leerErr } = await sb.from("importchat_envios")
          .select("id, estado, intento_at, confirmado_at")
          .eq("store_id", storeId).eq("external_id", externalId)
          .eq("plantilla", elegida.nombre).eq("dia", diaLocal)
          .maybeSingle();
        if (leerErr) throw new Error(leerErr.message);

        const fila = previa as { id: string; estado: string; intento_at: string; confirmado_at: string | null } | null;
        if (fila?.estado === "confirmado") {
          // Ahora sí es verdad: se vio en el chat.
          return json({
            ok: true, ya_enviado: true, confirmado: true,
            enviado_at: fila.confirmado_at, enviado_a: destino, plantilla: elegida.nombre,
          });
        }
        const enCurso = fila?.estado === "enviando"
          && Date.now() - Date.parse(fila.intento_at) < RECLAMO_MS;
        if (enCurso) {
          return json({
            ok: false, en_curso: true,
            error: "Se está mandando ahora mismo. Esperá unos segundos y mirá el chat.",
          }, 409);
        }
        // Colgada, fallida o no confirmada: se toma posesión ATÓMICAMENTE. El
        // predicado se re-evalúa contra la versión nueva, así que si dos toman a
        // la vez, una sola se lleva la fila.
        const limite = new Date(Date.now() - RECLAMO_MS).toISOString();
        const { data: tomada, error: tomaErr } = await sb.from("importchat_envios")
          .update({
            estado: "enviando", intento_at: ahoraIso, operador_id: u.user.id,
            confirmado_at: null, mensaje_id: null, senal: null, respuesta: null,
            chat_id: String(pedido.importchat_chat_id),
          })
          .eq("id", fila?.id ?? "")
          .neq("estado", "confirmado")
          .or(`estado.neq.enviando,intento_at.lt.${limite}`)
          .select("id");
        // ⛔ El error SE MIRA. El `liberarClaim()` viejo hacía el DELETE sin
        // mirarlo: si fallaba, el candado quedaba puesto todo el día sobre nada.
        if (tomaErr) throw new Error(tomaErr.message);
        if (!tomada?.length) {
          return json({
            ok: false, en_curso: true,
            error: "Otra pestaña o una compañera la está mandando en este momento.",
          }, 409);
        }
        filaId = fila?.id ?? null;
      }
    }

    // Manda y RELEE el chat: solo se da por enviada si se la ve ahí.
    const verificado = await enviarPlantillaVerificada({
      cred: { token, idConf: Number(idConf) },
      chatId: String(pedido.importchat_chat_id),
      cuerpoPlantilla: elegida.cuerpo,
      nombrePlantilla: elegida.nombre,
      enviar: () => postIC("whatsapp_managment/enviar_template_masivo", token, {
        id_configuracion: idConf,
        body: payload,
        id_cliente_chat_center: String(pedido.importchat_chat_id),
        header_default_asset: null,
      }),
    });

    /** Deja escrito qué pasó. La fila no se borra nunca: es la prueba. */
    const cerrarFila = async (campos: Record<string, unknown>) => {
      if (!filaId) return;
      const { error } = await sb.from("importchat_envios").update(campos).eq("id", filaId);
      // Si esto falla la fila queda `enviando` y se auto-cura a los 3 minutos,
      // en vez de bloquear el reenvío todo el día. Estrictamente mejor que el
      // DELETE de antes, que al fallar dejaba el candado puesto para siempre.
      if (error) console.warn(`[importchat-plantillas] no pude cerrar la fila ${filaId}: ${error.message}`);
    };

    if (verificado.estado !== "confirmado") {
      await cerrarFila({
        estado: verificado.estado === "sin_lectura" ? "fallido" : verificado.estado,
        respuesta: "respuesta" in verificado ? verificado.respuesta : null,
      });
      // ⛔ NI touchpoint NI `chat_saliente_at`: no se anota una gestión que no
      // ocurrió. Eso es lo que hacía que la tarjeta quedara pintada y la
      // productividad contara el trabajo mientras el cliente no tenía nada.
      return json({
        ok: false,
        confirmado: false,
        sin_confirmar: verificado.estado === "no_confirmado",
        sin_lectura: verificado.estado === "sin_lectura",
        error: verificado.motivo,
      }, 502);
    }

    await cerrarFila({
      estado: "confirmado", confirmado_at: new Date().toISOString(),
      mensaje_id: verificado.mensajeId, senal: verificado.senal, respuesta: verificado.respuesta,
    });

    // Recién con el envío CONFIRMADO se marca el pedido. `plantilla` (no
    // `directo`) es el mismo vocabulario que ya usa `chat_saliente_tipo`.
    const { error: updErr } = await sb.from("orders").update({
      chat_saliente_at: new Date().toISOString(),
      chat_saliente_tipo: "plantilla",
    }).eq("store_id", storeId).eq("external_id", externalId);
    if (updErr) console.warn(`[importchat-plantillas] no se pudo marcar chat_saliente: ${updErr.message}`);

    // El prefijo sigue a la PANTALLA: `SEG:%` cuenta como gestión de
    // Seguimiento, y escribirle desde Confirmar es un intento de contacto.
    // Ver el comentario largo en `importchat-send`.
    // Hora LOCAL de la tienda (finding #9): antes -5h fijo para la fecha y la
    // hora en UTC. `tienda` ya se leyó arriba para el destinatario.
    const { fecha: tpFecha, hora: tpHora } = fechaHoraLocal(tienda?.country_code);
    const modulo = body?.modulo === "WHATSAPP" ? "WHATSAPP" : "SEG";
    // Igual que en `importchat-send`: si el cliente dice QUÉ gestión es
    // ("Avisé: en oficina"), la bitácora lo dice. Sin `gestion` queda el nombre
    // crudo de la plantilla, que es lo que hacía antes.
    const gestion = String(body?.gestion ?? "").trim().slice(0, 60)
      || `Mandé la plantilla ${elegida.nombre}`;
    const { error: tpErr } = await sb.from("touchpoints").insert({
      phone: pedido.phone,
      action: `${modulo}: ${gestion}`,
      operator_id: u.user.id,
      store_id: storeId,
      action_date: tpFecha,
      action_time: tpHora,
    });
    // Si el touchpoint falla, el WhatsApp YA salió: no se revierte, pero queda
    // rastro (sin esto el pedido podía reaparecer "sin tocar" en otra cola).
    if (tpErr) console.warn(`[importchat-plantillas] envío OK pero no se registró el touchpoint: ${tpErr.message}`);

    return json({
      ok: true,
      confirmado: true,
      enviado_a: destino,
      plantilla: elegida.nombre,
      senal: verificado.senal,
      mensaje_id: verificado.mensajeId,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[importchat-plantillas]", msg);
    return json({ ok: false, error: msg }, 500);
  }
});

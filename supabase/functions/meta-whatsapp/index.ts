// meta-whatsapp — enviar por WhatsApp DIRECTO a Meta, sin ImporChat.
//
// El dueño consiguió el System User token de Meta de su socio (BSP). Con eso
// Guardian le habla directo a `graph.facebook.com/{ver}/{phone_number_id}/…`:
// texto, media (foto/audio/video/PDF) y TODAS las plantillas, y SIN la ventana
// de 24 h para las plantillas. Ver la memoria `imporchat_limitaciones_y_arquitectura`.
//
// ── Cuatro acciones ────────────────────────────────────────────────────────
//   verificar → read-only: confirma que el token/número/WABA sirven y dice qué
//               se desbloqueó. NUNCA devuelve el token. Es el "revisá" del dueño.
//   texto     → mensaje libre. Requiere ventana de 24 h abierta (regla de Meta).
//   plantilla → plantilla aprobada. NO tiene ventana: se puede mandar siempre.
//   media     → foto/audio/video/PDF por URL pública. Requiere ventana abierta.
//
// ── Por qué solo Ecuador (por ahora) ───────────────────────────────────────
// El número ("Compra Por", phone_number_id 977158145481199) es de la tienda de
// Ecuador. Mandar desde ese número a un cliente de OTRO país sería cruzar
// países — prohibido en esta operación (CLAUDE.md, REGLA #1). Así que la
// función se NIEGA si la tienda no es EC. Cuando llegue el token de Colombia,
// las credenciales pasan a ser por tienda y se levanta esta guarda.
//
// ── Reutiliza lo probado ───────────────────────────────────────────────────
// El payload de plantilla y el parseo de plantillas son EXACTAMENTE los de
// ImporChat (ImporChat los sacaba de Meta y los reenviaba): se reusa
// `plantillasMeta.*` tal cual. El teléfono lo arma `getWhatsAppPhone` con el
// país de la tienda. La ventana de 24 h la decide `ventanaWhatsapp`, la misma
// que el botón. Una sola definición para cada cosa.
//
// Auth: SOLO Bearer de un miembro de la tienda. Sin camino de cron: mandarle un
// WhatsApp a un cliente es un acto humano.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { getWhatsAppPhone } from "../_shared/telefonoWhatsapp.ts";
import { ventanaWhatsapp, MOTIVO_VENTANA } from "../_shared/ventanaWhatsapp.ts";
import {
  parsearPlantillas, construirPayloadMeta, faltantes, type PlantillaMeta,
} from "../_shared/plantillasMeta.ts";
import {
  enviarMensajeMeta, leerNumeroMeta, leerPlantillasMeta,
  payloadTexto, payloadMedia, TIPOS_MEDIA, type TipoMedia,
} from "../_shared/metaWhatsapp.ts";

type Accion = "verificar" | "listar" | "prueba" | "texto" | "plantilla" | "media";
const ACCIONES: Accion[] = ["verificar", "listar", "prueba", "texto", "plantilla", "media"];

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
    const accion = String(body?.accion || "verificar") as Accion;
    if (!storeId) return json({ ok: false, error: "Falta store_id" }, 400);
    if (!ACCIONES.includes(accion)) {
      return json({ ok: false, error: `accion tiene que ser una de: ${ACCIONES.join(", ")}` }, 400);
    }

    // ── Auth: miembro de la tienda, sin atajo de cron ──────────────────────
    const auth = req.headers.get("Authorization") ?? "";
    const { data: u } = await sb.auth.getUser(auth.replace("Bearer ", ""));
    if (!u?.user) return json({ ok: false, error: "no autenticado" }, 401);
    const { data: miembro } = await sb.from("store_members")
      .select("role").eq("store_id", storeId).eq("user_id", u.user.id).maybeSingle();
    if (!miembro) return json({ ok: false, error: "no sos miembro de esa tienda" }, 403);

    // ── Guarda de país: el número es de Ecuador, no se cruza ────────────────
    const { data: tienda } = await sb.from("stores")
      .select("country_code").eq("id", storeId).maybeSingle();
    const pais = String(tienda?.country_code || "CO").toUpperCase();
    if (pais !== "EC") {
      return json({
        ok: false,
        error: "El envío directo por Meta está configurado solo para Ecuador por ahora. Colombia usa su propio número (falta su token).",
      }, 409);
    }

    // ── Los secretos de Meta (globales, del número de EC) ──────────────────
    const token = String(Deno.env.get("META_WA_TOKEN") || "");
    const phoneNumberId = String(Deno.env.get("META_WA_PHONE_NUMBER_ID") || "");
    const wabaId = String(Deno.env.get("META_WA_WABA_ID") || "");
    const version = Deno.env.get("META_WA_API_VERSION") || null;
    const faltanSecretos = [
      !token && "META_WA_TOKEN",
      !phoneNumberId && "META_WA_PHONE_NUMBER_ID",
      !wabaId && "META_WA_WABA_ID",
    ].filter(Boolean) as string[];
    if (faltanSecretos.length > 0) {
      return json({
        ok: false,
        error: `Faltan secretos en Supabase: ${faltanSecretos.join(", ")}. Cargalos en Edge Functions → Secrets.`,
      }, 409);
    }

    // ════════════════════════════════════════════════════════════════════════
    // VERIFICAR — read-only. Confirma el token y dice qué se desbloqueó.
    // ════════════════════════════════════════════════════════════════════════
    if (accion === "verificar") {
      const numero = await leerNumeroMeta({ version, token, phoneNumberId });
      if (!numero.ok) {
        return json({ ok: false, error: `El token no pudo leer el número: ${numero.detalle}` }, 502);
      }
      const tpl = await leerPlantillasMeta({ version, token, wabaId });
      if (!tpl.ok) {
        return json({ ok: false, error: `El token leyó el número pero no las plantillas: ${tpl.detalle}` }, 502);
      }
      const aprobadas = parsearPlantillas(tpl.datos?.data);
      const enviables = aprobadas.filter((p) => !p.noSoportada);
      const d = numero.datos ?? {};
      return json({
        ok: true,
        numero: {
          nombre: String(d.verified_name || "—"),
          telefono: String(d.display_phone_number || "—"),
          calidad: String(d.quality_rating || "—"),
        },
        plantillas: {
          aprobadas: aprobadas.length,
          listas_para_enviar: enviables.length,
          con_media_o_boton: aprobadas.length - enviables.length,
          crudas_de_meta: Array.isArray(tpl.datos?.data) ? (tpl.datos!.data as unknown[]).length : 0,
        },
        // Lo que ANTES no podíamos y ahora sí.
        desbloqueado: {
          texto_directo_a_meta: true,
          media_foto_audio_video_pdf: true,
          todas_las_plantillas: true,
          plantillas_sin_ventana_24h: true,
          sin_depender_llave_7dias_importchat: true,
        },
      });
    }

    // ════════════════════════════════════════════════════════════════════════
    // LISTAR — las plantillas aprobadas con sus huecos (read-only, para elegir).
    // ════════════════════════════════════════════════════════════════════════
    if (accion === "listar") {
      const tpl = await leerPlantillasMeta({ version, token, wabaId });
      if (!tpl.ok) return json({ ok: false, error: `No se pudieron leer las plantillas: ${tpl.detalle}` }, 502);
      const aprobadas = parsearPlantillas(tpl.datos?.data);
      return json({
        ok: true,
        plantillas: aprobadas.map((p) => ({
          nombre: p.nombre,
          categoria: p.categoria,
          cuerpo: p.cuerpo,
          variables: p.variables,
          no_soportada: p.noSoportada,
          lista: !p.noSoportada,
        })),
      });
    }

    // ════════════════════════════════════════════════════════════════════════
    // PRUEBA — mandar a un número CRUDO (no a un pedido), para probar en vivo.
    // Solo dueño/supervisor: manda a cualquier número, no es para operar. No
    // escribe nada en la base (no hay pedido detrás). modo: plantilla|texto|media.
    // ════════════════════════════════════════════════════════════════════════
    if (accion === "prueba") {
      if (miembro.role !== "owner" && miembro.role !== "supervisor") {
        return json({ ok: false, error: "Solo el dueño o un supervisor puede mandar una prueba" }, 403);
      }
      const telRaw = String(body?.telefono || "").replace(/\D/g, "");
      if (telRaw.length < 8) return json({ ok: false, error: "Pasá un teléfono válido (con código de país) en 'telefono'" }, 400);
      const modo = String(body?.modo || "plantilla");

      let payload: Record<string, unknown>;
      if (modo === "texto") {
        const mensaje = String(body?.mensaje || "").trim();
        if (!mensaje) return json({ ok: false, error: "Falta 'mensaje'" }, 400);
        payload = payloadTexto(telRaw, mensaje);
      } else if (modo === "media") {
        const tipo = String(body?.tipo || "") as TipoMedia;
        const link = String(body?.link || "").trim();
        if (!TIPOS_MEDIA.includes(tipo)) return json({ ok: false, error: `tipo tiene que ser uno de: ${TIPOS_MEDIA.join(", ")}` }, 400);
        if (!/^https:\/\//i.test(link)) return json({ ok: false, error: "El link tiene que ser una URL https pública" }, 400);
        payload = payloadMedia(telRaw, tipo, link, {
          caption: body?.caption ? String(body.caption) : null,
          filename: body?.filename ? String(body.filename) : null,
        });
      } else {
        const nombre = String(body?.nombre || "");
        if (!nombre) return json({ ok: false, error: "Falta 'nombre' de la plantilla" }, 400);
        const tpl = await leerPlantillasMeta({ version, token, wabaId });
        if (!tpl.ok) return json({ ok: false, error: tpl.detalle }, 502);
        const aprobadas = parsearPlantillas(tpl.datos?.data);
        const elegida: PlantillaMeta | undefined = aprobadas.find((p) => p.nombre === nombre);
        if (!elegida) return json({ ok: false, error: `No existe la plantilla "${nombre}"`, disponibles: aprobadas.map((p) => p.nombre) }, 409);
        if (elegida.noSoportada) return json({ ok: false, error: elegida.noSoportada }, 409);
        const crudos = (body?.valores ?? {}) as Record<string, unknown>;
        const valores: Record<number, string> = {};
        for (const [k, v] of Object.entries(crudos)) {
          const n = Number(k);
          if (Number.isFinite(n) && n > 0) valores[n] = String(v ?? "").trim();
        }
        const huecos = faltantes(elegida, valores);
        if (huecos.length > 0) {
          return json({ ok: false, error: `Faltan valores: ${huecos.join(", ")}`, faltantes: huecos, variables: elegida.variables }, 400);
        }
        payload = construirPayloadMeta(elegida, valores, telRaw);
      }

      if (body?.dry_run === true) return json({ ok: true, dry_run: true, enviaria_a: telRaw, payload });
      const envio = await enviarMensajeMeta({ version, token, phoneNumberId, payload });
      if (!envio.ok) return json({ ok: false, error: `Meta rechazó el envío: ${envio.detalle}` }, 502);
      return json({ ok: true, prueba: true, enviado_a: telRaw, wamid: envio.wamid });
    }

    // ── De acá para abajo, todo envío necesita el pedido y su teléfono ──────
    const externalId = String(body?.external_id || "");
    if (!externalId) return json({ ok: false, error: "Falta external_id" }, 400);

    const { data: pedido, error: pedErr } = await sb.from("orders")
      .select("id, phone, nombre, chat_entrante_at, chat_leido_at")
      .eq("store_id", storeId).eq("external_id", externalId).maybeSingle();
    if (pedErr) throw new Error(pedErr.message);
    if (!pedido) return json({ ok: false, error: "No encontré ese pedido en esta tienda" }, 404);
    if (!pedido.phone) return json({ ok: false, error: "Ese pedido no tiene teléfono" }, 409);
    const destino = getWhatsAppPhone(String(pedido.phone), pais);

    // La ventana solo aplica a texto y media (mensajes de sesión). Las
    // plantillas NO la necesitan — ése es medio punto de tenerlas.
    const necesitaVentana = accion === "texto" || accion === "media";
    if (necesitaVentana) {
      const v = ventanaWhatsapp(
        pedido.chat_entrante_at ? Date.parse(pedido.chat_entrante_at) : null,
        !!pedido.chat_leido_at,
      );
      if (v.estado !== "abierta") {
        return json({
          ok: false,
          error: `${MOTIVO_VENTANA[v.estado]} Si ya pasaron las 24 h, mandá una plantilla aprobada.`,
          ventana: v.estado,
        }, 409);
      }
    }

    // ── Armar el payload según la acción ────────────────────────────────────
    let payload: Record<string, unknown>;
    let tipoSaliente: "directo" | "plantilla" = "directo";
    let descripcionTouchpoint = "";

    if (accion === "texto") {
      const mensaje = String(body?.mensaje || "").trim();
      if (!mensaje) return json({ ok: false, error: "Falta el mensaje" }, 400);
      if (mensaje.length > 1000) return json({ ok: false, error: "El mensaje no puede pasar de 1000 caracteres" }, 400);
      payload = payloadTexto(destino, mensaje);
      descripcionTouchpoint = "Escribí por WhatsApp";
    } else if (accion === "media") {
      const tipo = String(body?.tipo || "") as TipoMedia;
      const link = String(body?.link || "").trim();
      if (!TIPOS_MEDIA.includes(tipo)) {
        return json({ ok: false, error: `tipo tiene que ser uno de: ${TIPOS_MEDIA.join(", ")}` }, 400);
      }
      if (!/^https:\/\//i.test(link)) {
        return json({ ok: false, error: "El link del archivo tiene que ser una URL https pública (Meta lo descarga)" }, 400);
      }
      payload = payloadMedia(destino, tipo, link, {
        caption: body?.caption ? String(body.caption) : null,
        filename: body?.filename ? String(body.filename) : null,
      });
      descripcionTouchpoint = `Mandé un ${tipo === "image" ? "imagen" : tipo === "audio" ? "audio" : tipo === "video" ? "video" : "archivo"} por WhatsApp`;
    } else {
      // plantilla
      const nombre = String(body?.nombre || "");
      if (!nombre) return json({ ok: false, error: "Falta el nombre de la plantilla" }, 400);
      const tpl = await leerPlantillasMeta({ version, token, wabaId });
      if (!tpl.ok) return json({ ok: false, error: `No se pudieron leer las plantillas: ${tpl.detalle}` }, 502);
      const aprobadas = parsearPlantillas(tpl.datos?.data);
      const elegida: PlantillaMeta | undefined = aprobadas.find((p) => p.nombre === nombre);
      if (!elegida) return json({ ok: false, error: `Meta ya no tiene aprobada la plantilla "${nombre}"` }, 409);
      if (elegida.noSoportada) return json({ ok: false, error: elegida.noSoportada }, 409);

      const crudos = (body?.valores ?? {}) as Record<string, unknown>;
      const valores: Record<number, string> = {};
      for (const [k, val] of Object.entries(crudos)) {
        const n = Number(k);
        if (Number.isFinite(n) && n > 0) valores[n] = String(val ?? "").trim();
      }
      const huecos = faltantes(elegida, valores);
      if (huecos.length > 0) {
        return json({
          ok: false,
          error: `Faltan datos de la plantilla (${huecos.join(", ")}). Los huecos son posicionales: si va uno vacío, al cliente le llega el mensaje corrido.`,
          faltantes: huecos,
        }, 400);
      }
      payload = construirPayloadMeta(elegida, valores, destino);
      tipoSaliente = "plantilla";
      descripcionTouchpoint = `Mandé la plantilla ${elegida.nombre}`;
    }

    if (body?.dry_run === true) {
      return json({ ok: true, dry_run: true, enviaria_a: destino, payload });
    }

    // ── Enviar a Meta ───────────────────────────────────────────────────────
    const envio = await enviarMensajeMeta({ version, token, phoneNumberId, payload });
    if (!envio.ok) return json({ ok: false, error: `Meta rechazó el envío: ${envio.detalle}` }, 502);

    // Marcar el pedido para que la pantalla reaccione ya (el sync lo reescribe).
    await sb.from("orders").update({
      chat_saliente_at: new Date().toISOString(),
      chat_saliente_tipo: tipoSaliente,
    }).eq("store_id", storeId).eq("external_id", externalId);

    // Touchpoint con el prefijo de LA PANTALLA (mismo criterio que
    // importchat-send: SEG cuenta como gestión de Seguimiento; WHATSAPP es un
    // intento de contacto desde Confirmar).
    const ahora = new Date();
    const modulo = body?.modulo === "WHATSAPP" ? "WHATSAPP" : "SEG";
    await sb.from("touchpoints").insert({
      phone: pedido.phone,
      action: `${modulo}: ${descripcionTouchpoint}`,
      operator_id: u.user.id,
      store_id: storeId,
      action_date: new Date(ahora.getTime() - 5 * 3600_000).toISOString().slice(0, 10),
      action_time: ahora.toISOString().slice(11, 16),
    });

    return json({ ok: true, confirmado: true, enviado_a: destino, wamid: envio.wamid, via: "meta" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[meta-whatsapp]", msg);
    return json({ ok: false, error: msg }, 500);
  }
});

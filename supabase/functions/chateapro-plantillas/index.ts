// chateapro-plantillas — escribirle al cliente de Colombia cuando ya pasaron
// las 24 h.
//
// Gemelo de `importchat-plantillas` contra Chatea Pro, con la misma forma de
// respuesta (`{ok, plantillas}` / `{ok, faltantes, ya_enviado}`) para que
// `usePlantillasMeta` y `useEnviarPlantilla` no cambien por dentro.
//
// Body: { store_id, accion: 'listar' }
//       { store_id, accion: 'enviar', external_id, nombre, valores, modulo?, gestion? }
//
// ── Dos diferencias con ImporChat, medidas en la spec ─────────────────────
// 1. Las plantillas llegan en el formato de Meta (`components`), que es
//    exactamente lo que `parsearPlantillas` ya sabe leer. Se reusa esa función
//    en vez de escribir un segundo parser: dos definiciones del mismo hecho es
//    la trampa que este repo ya pagó.
// 2. El envío NO usa el payload de Meta sino el de Chatea Pro:
//    `{namespace, name, lang, params:{ "BODY_{{1}}": … }}`.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { respuestaPing } from "../_shared/versionEdge.ts";
import { fechaHoraLocal } from "../_shared/horaLocal.ts";
import { parsearPlantillas, faltantes, type PlantillaMeta } from "../_shared/plantillasMeta.ts";
import {
  cargarConfigChateapro,
  buscarSuscriptorPorTelefono,
  listarPlantillas,
  enviarPlantilla,
  enviarPlantillaPorTelefono,
  idWhatsapp,
  ChateaproError,
} from "../_shared/chateaproApi.ts";

const VERSION = "chateapro-plantillas 2026-09-03.1 mensajes-que-mandan-a-donde-es";

/** Lo que `/whatsapp-template/list` devuelve de verdad (medido 2-sep-2026). */
interface PlantillaCruda {
  name?: string;
  namespace?: string;
  language?: string;
  status?: string;
  /** El panel guarda acá el payload completo que usa para mandarla. */
  default_values?: { namespace?: string; lang?: string; params?: Record<string, string> } | null;
}

/**
 * Los parámetros del envío.
 *
 * ⛔ NO se arman desde cero. Medido el 2-sep-2026: `default_values.params` trae
 * también los botones (`QUICK_REPLY_1: "f209801s2909037"`) y los enlaces
 * (`URL_1`), que apuntan a subflujos internos de Chatea Pro. Mandando solo los
 * `BODY_{{n}}` la plantilla sale con los botones rotos — y el botón
 * "CONFIRMAR PEDIDO" es justamente la señal que más predice si un pedido se
 * cancela (ver `senalConfirmacion`). Se parte de lo que el panel ya usa y solo
 * se pisan los huecos del cuerpo con lo que escribió la asesora.
 */
function paramsChateapro(
  p: PlantillaMeta,
  cruda: PlantillaCruda | undefined,
  valores: Record<number, string>,
): Record<string, string> {
  const params: Record<string, string> = { ...(cruda?.default_values?.params ?? {}) };
  for (const v of p.variables) {
    params[`BODY_{{${v.indice}}}`] = String(valores?.[v.indice] ?? "").trim();
  }
  return params;
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

    const crudas = (await listarPlantillas(cfg)) as unknown as PlantillaCruda[];
    // `status` SÍ viene ("APPROVED"), verificado el 2-sep-2026: `parsearPlantillas`
    // filtra las pendientes y rechazadas sin ayuda de nadie.
    const plantillas = parsearPlantillas(crudas);

    if (accion === "listar") {
      // ⛔ Una lista vacia NO se devuelve muda (paridad con ImporChat). El
      // selector con cero filas y sin texto se lee como "Guardian esta roto";
      // el motivo real —Meta todavia no aprobo ninguna— es otra accion.
      if (plantillas.length === 0) {
        return json({ ok: true, plantillas: [], aviso: "La cuenta no tiene plantillas aprobadas por Meta." });
      }
      return json({ ok: true, plantillas });
    }

    // ── Enviar ────────────────────────────────────────────────────────────
    const externalId = String(body?.external_id || "");
    const nombre = String(body?.nombre || "");
    const valores = (body?.valores ?? {}) as Record<number, string>;
    if (!externalId || !nombre) return json({ ok: false, error: "Faltan external_id o nombre" }, 400);

    const elegida = plantillas.find((p) => p.nombre === nombre);
    if (!elegida) return json({ ok: false, error: `No encontré la plantilla "${nombre}" en esta cuenta` }, 404);
    // ⛔ El servidor repite la comprobacion que hace la pantalla (paridad con
    // ImporChat). Una plantilla con imagen de cabecera o con un boton de enlace
    // propio NO se puede armar desde Guardian: el payload sale sin la cabecera
    // y el mensaje llega roto. La pantalla ya las marca, pero la unica defensa
    // que no depende de que la pantalla este bien es esta.
    if (elegida.noSoportada) return json({ ok: false, error: elegida.noSoportada }, 409);

    // ⛔ Un hueco vacío NO se manda: Meta lo rechaza o, peor, llega un mensaje
    // con un espacio en blanco donde iba el nombre del cliente.
    const huecos = faltantes(elegida, valores);
    if (huecos.length > 0) {
      return json({ ok: false, faltantes: huecos, error: "Faltan datos para completar la plantilla" }, 400);
    }

    const { data: pedido, error: pedErr } = await sb.from("orders")
      .select("phone, nombre").eq("store_id", storeId).eq("external_id", externalId).maybeSingle();
    if (pedErr) throw new Error(pedErr.message);
    // ⛔ Dos causas distintas, dos mensajes distintos (paridad con
    // `chateapro-chat` y con ImporChat). Antes, un pedido que no existia en
    // esta tienda respondia "Ese pedido no tiene telefono": la asesora se iba a
    // buscar un telefono que si estaba, en vez de mirar en que tienda esta.
    if (!pedido) return json({ ok: false, error: "No encontré ese pedido en esta tienda" }, 404);
    if (!pedido.phone) return json({ ok: false, error: "Ese pedido no tiene teléfono" }, 409);

    // ⛔ Un cliente que compró y NUNCA escribió por WhatsApp no existe como
    // contacto en Chatea Pro. Antes eso terminaba acá con "no existe como
    // contacto" — y son justo los que hay que rescatar. Ahora, si no está, la
    // plantilla se manda igual por teléfono y Chatea Pro lo crea al vuelo.
    // El país decide el indicativo con el que Chatea Pro pudo haber guardado el
    // teléfono (`+57…` cuando el contacto lo creó la API).
    const { data: tiendaPais } = await sb.from("stores")
      .select("country_code").eq("id", storeId).maybeSingle();
    const cc = String(tiendaPais?.country_code || "CO");
    const sus = await buscarSuscriptorPorTelefono(cfg, String(pedido.phone), cc);

    // ── Candado de un envío por día ───────────────────────────────────────
    // Se reusa `importchat_envios`: el nombre quedó del primer canal, pero la
    // tabla es genérica (store_id + external_id + plantilla + día) y la regla
    // es la misma sin importar por dónde salga el mensaje. Una segunda tabla
    // con el mismo propósito es una segunda verdad esperando desalinearse.
    // ⛔ El dia lo pone el pais de la TIENDA, no un "CO" clavado. El
    // `country_code` ya se leyo arriba para el indicativo y se ignoraba para el
    // reloj; `chateapro-send` ya lo hacia bien. Con dos criterios en la misma
    // familia de funciones, el candado de "un envio por dia" y la bitacora
    // podrian caer en dias distintos.
    const { fecha } = fechaHoraLocal(cc);
    const { error: claimErr } = await sb.from("importchat_envios").insert({
      store_id: storeId, external_id: externalId, plantilla: nombre, dia: fecha,
    });
    if (claimErr) {
      if (/duplicate key|unique/i.test(claimErr.message)) {
        // `ok: true` + `ya_enviado` — la operación terminó bien pero NO salió
        // ningún mensaje nuevo. La pantalla usa esta bandera para no cantar un
        // envío que no ocurrió.
        return json({ ok: true, ya_enviado: true, plantilla: nombre });
      }
      if (/relation .* does not exist/i.test(claimErr.message)) {
        console.warn("[chateapro-plantillas] sin tabla importchat_envios — envío SIN idempotencia");
      } else {
        throw new Error(claimErr.message);
      }
    }

    const cruda = crudas.find((t) => t.name === nombre);
    const contenido = {
      // El `namespace` es obligatorio y viene en la propia plantilla.
      namespace: cruda?.namespace ?? cruda?.default_values?.namespace ?? "",
      name: elegida.nombre,
      lang: cruda?.default_values?.lang ?? elegida.idioma ?? "es",
      params: paramsChateapro(elegida, cruda, valores),
    };
    try {
      if (sus) {
        // Contacto existente: va por `user_ns` para que quede en el hilo de siempre.
        await enviarPlantilla(cfg, sus.user_ns, contenido);
      } else {
        await enviarPlantillaPorTelefono(
          cfg,
          idWhatsapp(String(pedido.phone), cc),
          contenido,
          String(pedido.nombre || "").trim() || undefined,
        );
      }
    } catch (e) {
      // Si el envío falla hay que SOLTAR el candado: si no, el reintento de la
      // asesora choca con "ya se mandó hoy" sobre un mensaje que nunca salió.
      await sb.from("importchat_envios").delete()
        .eq("store_id", storeId).eq("external_id", externalId).eq("plantilla", nombre).eq("dia", fecha);
      throw e;
    }

    // ⛔ `supabase-js` NO lanza cuando la base rechaza: sin mirar `error`, un
    // update fallido devuelve `ok: true` y nadie se entera nunca. Es el mismo
    // modo de falla que dejaba las corridas del sync sin una sola fila de log.
    const { error: updErr } = await sb.from("orders").update({
      chat_saliente_at: new Date().toISOString(),
      chat_saliente_tipo: "plantilla",
    }).eq("store_id", storeId).eq("external_id", externalId);
    if (updErr) console.error(`[chateapro-plantillas] no se pudo marcar chat_saliente: ${updErr.message}`);

    const { hora } = fechaHoraLocal(cc);
    const modulo = body?.modulo === "WHATSAPP" ? "WHATSAPP" : "SEG";
    const gestion = String(body?.gestion ?? "").trim().slice(0, 60) || `Mandé la plantilla ${nombre}`;
    // Mismo criterio: la gestion que no queda registrada no le baja el numero a
    // nadie y la asesora la vuelve a hacer. Si falla, que quede dicho.
    const { error: tpErr } = await sb.from("touchpoints").insert({
      phone: pedido.phone,
      action: `${modulo}: ${gestion}`,
      operator_id: u.user.id,
      store_id: storeId,
      action_date: fecha,
      action_time: hora,
    });
    if (tpErr) console.error(`[chateapro-plantillas] no se pudo registrar la gestion: ${tpErr.message}`);

    return json({
      ok: true, enviado_a: pedido.phone, plantilla: nombre,
      // Para que la pantalla pueda decir "se le creó el contacto" en vez de
      // dejar al operador con la duda de si salió por el hilo de siempre.
      contacto_nuevo: !sus,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof ChateaproError && e.status === 401) {
      return json({ ok: false, error: "La API key de Chatea Pro no es válida o venció. Hay que renovarla." }, 409);
    }
    console.error("[chateapro-plantillas]", msg);
    return json({ ok: false, error: msg }, 500);
  }
});

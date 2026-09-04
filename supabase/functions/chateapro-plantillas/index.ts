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
import { enviarPlantillaVerificadaCp } from "../_shared/chateaproPlantillaVerificada.ts";
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

const VERSION = "chateapro-plantillas 2026-09-04.1 no-se-canta-sin-verla";

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
    const ahoraIso = new Date().toISOString();
    /** Un `enviando` mas viejo que esto tiene dueno muerto: la plataforma mata
     *  una edge function a los ~150 s. No hay que adivinar. */
    const RECLAMO_MS = 180_000;
    let filaId: string | null = null;

    {
      const ins = await sb.from("importchat_envios").insert({
        store_id: storeId, external_id: externalId, plantilla: nombre, dia: fecha,
        estado: "enviando", intento_at: ahoraIso, operador_id: u.user.id,
        canal: "chateapro", chat_id: sus?.user_ns ?? null,
      }).select("id").maybeSingle();

      if (!ins.error) {
        filaId = (ins.data as { id?: string } | null)?.id ?? null;
      } else {
        const code = (ins.error as { code?: string }).code;
        const falta = code === "42703" || /column .* does not exist/i.test(ins.error.message || "");
        if (falta) {
          // ⛔ FALLA CERRADO, igual que Ecuador. El `console.warn` + "envio SIN
          // idempotencia" que habia aca era una degradacion SILENCIOSA: la
          // familia exacta de la que salio este bug.
          return json({ ok: false, error: "Falta aplicar la migración 20260904220000 (importchat_envios sin las columnas de confirmación). No se mandó nada." }, 503);
        }
        if (code !== "23505" && !/duplicate key|unique/i.test(ins.error.message || "")) {
          throw new Error(ins.error.message);
        }
        const { data: previa, error: leerErr } = await sb.from("importchat_envios")
          .select("id, estado, intento_at, confirmado_at")
          .eq("store_id", storeId).eq("external_id", externalId)
          .eq("plantilla", nombre).eq("dia", fecha)
          .maybeSingle();
        if (leerErr) throw new Error(leerErr.message);

        const fila = previa as { id: string; estado: string; intento_at: string; confirmado_at: string | null } | null;
        if (fila?.estado === "confirmado") {
          // Ahora si es verdad: se vio en el chat.
          return json({
            ok: true, ya_enviado: true, confirmado: true,
            enviado_at: fila.confirmado_at, plantilla: nombre,
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
        // Colgada, fallida o no confirmada: se toma posesion ATOMICAMENTE. El
        // predicado se re-evalua contra la version nueva, asi que si dos toman
        // a la vez, una sola se lleva la fila.
        const limite = new Date(Date.now() - RECLAMO_MS).toISOString();
        const { data: tomada, error: tomaErr } = await sb.from("importchat_envios")
          .update({
            estado: "enviando", intento_at: ahoraIso, operador_id: u.user.id,
            confirmado_at: null, mensaje_id: null, senal: null, respuesta: null,
            chat_id: sus?.user_ns ?? null,
          })
          .eq("id", fila?.id ?? "")
          .neq("estado", "confirmado")
          .or(`estado.neq.enviando,intento_at.lt.${limite}`)
          .select("id");
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

    const cruda = crudas.find((t) => t.name === nombre);
    const contenido = {
      // El `namespace` es obligatorio y viene en la propia plantilla.
      namespace: cruda?.namespace ?? cruda?.default_values?.namespace ?? "",
      name: elegida.nombre,
      lang: cruda?.default_values?.lang ?? elegida.idioma ?? "es",
      params: paramsChateapro(elegida, cruda, valores),
    };
    // ⛔ ACA VIVIA EL `delete()` DEL CANDADO. Se fue a proposito (4-sep-2026):
    // borrarlo destruia la unica prueba de que el envio ocurrio. En Ecuador, de
    // 9 plantillas que nunca llegaron al cliente no quedo NI UN rastro salvo un
    // touchpoint que mentia. Ahora la fila no se borra jamas: cambia de
    // `estado`, y solo `confirmado` bloquea un reenvio. Una fila no confirmada
    // documenta, no traba — asi que el reintento de la asesora sigue pasando,
    // que era lo que el delete venia a resolver.
    const verificado = await enviarPlantillaVerificadaCp({
      cfg,
      userNs: sus?.user_ns ?? null,
      cuerpoPlantilla: elegida.cuerpo,
      nombrePlantilla: nombre,
      enviar: async () => {
        try {
          if (sus) {
            // Contacto existente: va por `user_ns` para que quede en el hilo de siempre.
            const r = await enviarPlantilla(cfg, sus.user_ns, contenido);
            return { ok: true, datos: (r ?? null) as Record<string, unknown> | null, detalle: "" };
          }
          const r = await enviarPlantillaPorTelefono(
            cfg,
            idWhatsapp(String(pedido.phone), cc),
            contenido,
            String(pedido.nombre || "").trim() || undefined,
          );
          return { ok: true, datos: (r ?? null) as Record<string, unknown> | null, detalle: "" };
        } catch (e) {
          return { ok: false, datos: null, detalle: e instanceof Error ? e.message : String(e) };
        }
      },
    });

    /** Deja escrito que paso. La fila no se borra nunca: es la prueba. */
    const cerrarFila = async (campos: Record<string, unknown>) => {
      if (!filaId) return;
      const { error } = await sb.from("importchat_envios").update(campos).eq("id", filaId);
      // Si esto falla la fila queda `enviando` y se auto-cura a los 3 minutos,
      // en vez de bloquear el reenvio todo el dia.
      if (error) console.warn(`[chateapro-plantillas] no pude cerrar la fila ${filaId}: ${error.message}`);
    };

    if (verificado.estado !== "confirmado") {
      await cerrarFila({
        estado: verificado.estado === "sin_lectura" ? "fallido" : verificado.estado,
        respuesta: "respuesta" in verificado ? verificado.respuesta : null,
      });
      // ⛔ NI touchpoint NI `chat_saliente_at`: no se anota una gestion que no
      // ocurrio. Eso es lo que dejaba la tarjeta pintada y la productividad
      // contando el trabajo mientras el cliente no tenia nada.
      return json({
        ok: false,
        confirmado: false,
        sin_confirmar: verificado.estado === "no_confirmado",
        sin_lectura: verificado.estado === "sin_lectura",
        contacto_nuevo: !sus,
        error: verificado.motivo,
      }, 502);
    }

    await cerrarFila({
      estado: "confirmado", confirmado_at: new Date().toISOString(),
      mensaje_id: verificado.mensajeId, senal: verificado.senal, respuesta: verificado.respuesta,
    });

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
      ok: true,
      confirmado: true,
      enviado_a: pedido.phone, plantilla: nombre,
      senal: verificado.senal,
      mensaje_id: verificado.mensajeId,
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

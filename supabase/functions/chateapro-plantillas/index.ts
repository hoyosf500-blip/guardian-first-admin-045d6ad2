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
  ChateaproError,
} from "../_shared/chateaproApi.ts";

const VERSION = "chateapro-plantillas 2026-09-02.3 motivo-sin-nombrar-canal";

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
      return json({ ok: true, plantillas });
    }

    // ── Enviar ────────────────────────────────────────────────────────────
    const externalId = String(body?.external_id || "");
    const nombre = String(body?.nombre || "");
    const valores = (body?.valores ?? {}) as Record<number, string>;
    if (!externalId || !nombre) return json({ ok: false, error: "Faltan external_id o nombre" }, 400);

    const elegida = plantillas.find((p) => p.nombre === nombre);
    if (!elegida) return json({ ok: false, error: `No encontré la plantilla "${nombre}" en esta cuenta` }, 404);

    // ⛔ Un hueco vacío NO se manda: Meta lo rechaza o, peor, llega un mensaje
    // con un espacio en blanco donde iba el nombre del cliente.
    const huecos = faltantes(elegida, valores);
    if (huecos.length > 0) {
      return json({ ok: false, faltantes: huecos, error: "Faltan datos para completar la plantilla" }, 400);
    }

    const { data: pedido } = await sb.from("orders")
      .select("phone, nombre").eq("store_id", storeId).eq("external_id", externalId).maybeSingle();
    if (!pedido?.phone) return json({ ok: false, error: "Ese pedido no tiene teléfono" }, 409);

    const sus = await buscarSuscriptorPorTelefono(cfg, String(pedido.phone));
    if (!sus) {
      return json({
        ok: false, sin_chat: true,
        error: "Ese teléfono todavía no existe como contacto en Chatea Pro.",
      }, 409);
    }

    // ── Candado de un envío por día ───────────────────────────────────────
    // Se reusa `importchat_envios`: el nombre quedó del primer canal, pero la
    // tabla es genérica (store_id + external_id + plantilla + día) y la regla
    // es la misma sin importar por dónde salga el mensaje. Una segunda tabla
    // con el mismo propósito es una segunda verdad esperando desalinearse.
    const { fecha } = fechaHoraLocal("CO");
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
    try {
      await enviarPlantilla(cfg, sus.user_ns, {
        // El `namespace` es obligatorio y viene en la propia plantilla.
        namespace: cruda?.namespace ?? cruda?.default_values?.namespace ?? "",
        name: elegida.nombre,
        lang: cruda?.default_values?.lang ?? elegida.idioma ?? "es",
        params: paramsChateapro(elegida, cruda, valores),
      });
    } catch (e) {
      // Si el envío falla hay que SOLTAR el candado: si no, el reintento de la
      // asesora choca con "ya se mandó hoy" sobre un mensaje que nunca salió.
      await sb.from("importchat_envios").delete()
        .eq("store_id", storeId).eq("external_id", externalId).eq("plantilla", nombre).eq("dia", fecha);
      throw e;
    }

    await sb.from("orders").update({
      chat_saliente_at: new Date().toISOString(),
      chat_saliente_tipo: "plantilla",
    }).eq("store_id", storeId).eq("external_id", externalId);

    const { hora } = fechaHoraLocal("CO");
    const modulo = body?.modulo === "WHATSAPP" ? "WHATSAPP" : "SEG";
    const gestion = String(body?.gestion ?? "").trim().slice(0, 60) || `Mandé la plantilla ${nombre}`;
    await sb.from("touchpoints").insert({
      phone: pedido.phone,
      action: `${modulo}: ${gestion}`,
      operator_id: u.user.id,
      store_id: storeId,
      action_date: fecha,
      action_time: hora,
    });

    return json({ ok: true, enviado_a: pedido.phone, plantilla: nombre });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof ChateaproError && e.status === 401) {
      return json({ ok: false, error: "La API key de Chatea Pro no es válida o venció. Hay que renovarla." }, 409);
    }
    console.error("[chateapro-plantillas]", msg);
    return json({ ok: false, error: msg }, 500);
  }
});

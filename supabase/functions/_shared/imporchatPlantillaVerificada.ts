import { usarSocket, leerChat, type CredencialIC } from "./imporchatSocket.ts";
import {
  anclaDePlantilla, idsSalientes, plantillaAparecio,
  type MensajeCrudo, type SenalPlantilla,
} from "./plantillaEnHilo.ts";

/**
 * Manda una plantilla y NO la da por enviada hasta verla en la conversación.
 *
 * ⛔ Por qué (medido el 4-sep-2026, Ecuador): del 25-ago al 4-sep hubo 14
 * plantillas anotadas como enviadas y 9 clientes que no recibieron nada.
 * ImporChat contestaba `success:true` y el mensaje no entraba al hilo. Guardian
 * escribía el touchpoint y pintaba la tarjeta como gestionada igual.
 *
 * El `success:true` de `enviar_template_masivo` confirma que RECIBIERON EL
 * PEDIDO, no que ENTREGARON EL MENSAJE. Este es el mismo molde que
 * `importchat-send` usa para el texto libre desde siempre — y por eso el texto
 * libre sí funcionaba.
 *
 * Archivo aparte (no una función más en `imporchatEnviar.ts`) a propósito: ese
 * lo importa `importchat-responder`, y tocarlo metería otra edge function en la
 * discusión de "¿hay que redesplegarla?".
 */

/** Esperas antes de cada relectura. Corta apenas aparece, así que el caso normal
 *  es la primera. Con una sola espera fija, si ImporChat tardaba en persistir
 *  daba falso negativo → la asesora reintentaba → DOBLE WhatsApp al cliente. */
const RELECTURA_MS = [1500, 2500, 4000, 6000, 8000];
/** Techo duro de la fase de confirmación. La plataforma mata la función a los
 *  ~150 s y antes de esto ya se gastaron la lista de plantillas y el POST. */
const PRESUPUESTO_CONFIRMAR_MS = 45_000;
/** Lectura individual: no puede comerse el presupuesto entero. */
const ESPERA_LECTURA_MS = 8_000;

export type ResultadoPlantilla =
  | { estado: "confirmado"; mensajeId: string | null; senal: SenalPlantilla; respuesta: Record<string, unknown> | null }
  | { estado: "no_confirmado"; motivo: string; respuesta: Record<string, unknown> | null }
  | { estado: "fallido"; motivo: string; respuesta: Record<string, unknown> | null }
  | { estado: "sin_lectura"; motivo: string };

/** Solo estas claves de la respuesta de ImporChat se guardan. El payload que se
 *  ENVÍA no se guarda nunca: ahí van nombre, dirección y teléfono del cliente. */
function respuestaSegura(datos: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!datos) return null;
  const out: Record<string, unknown> = {};
  for (const k of ["success", "status", "message", "wamid", "error", "code"]) {
    if (k in datos) out[k] = typeof datos[k] === "string" ? String(datos[k]).slice(0, 300) : datos[k];
  }
  return Object.keys(out).length > 0 ? out : null;
}

export async function enviarPlantillaVerificada(opts: {
  cred: CredencialIC;
  chatId: string;
  /** El cuerpo con `{{n}}` — de ahí sale el ancla. */
  cuerpoPlantilla: string;
  nombrePlantilla: string;
  /** Hace el POST real. Se inyecta para no duplicar `postIC` acá. */
  enviar: () => Promise<{ ok: boolean; datos: Record<string, unknown> | null; detalle: string }>;
}): Promise<ResultadoPlantilla> {
  const ancla = anclaDePlantilla(opts.cuerpoPlantilla);

  try {
    return await usarSocket(async (socket) => {
      // ── BASELINE ───────────────────────────────────────────────────────────
      // Sin baseline no se puede distinguir MI plantilla de una que el bot mandó
      // ayer con el mismo cuerpo. O sea: se podría volver a mentir. Por eso, si
      // no se puede leer, NO SE MANDA — y se dice.
      let antes = idsSalientes(await leerChat(socket, opts.cred, opts.chatId, ESPERA_LECTURA_MS));
      if (antes === null) {
        antes = idsSalientes(await leerChat(socket, opts.cred, opts.chatId, ESPERA_LECTURA_MS));
      }
      if (antes === null) {
        return {
          estado: "sin_lectura",
          motivo: "No pude leer el chat para comprobar el envío, así que no mandé nada.",
        };
      }

      // ── ENVÍO ──────────────────────────────────────────────────────────────
      const envio = await opts.enviar();
      const resp = respuestaSegura(envio.datos);
      if (!envio.ok) {
        return { estado: "fallido", motivo: `Meta rechazó el envío: ${envio.detalle}`, respuesta: resp };
      }
      if (envio.datos?.success !== true) {
        return {
          estado: "fallido",
          motivo: String(envio.datos?.message || "ImporChat no confirmó el envío"),
          respuesta: resp,
        };
      }

      // ── CONFIRMACIÓN ───────────────────────────────────────────────────────
      const fin = Date.now() + PRESUPUESTO_CONFIRMAR_MS;
      let ultima: ReturnType<typeof plantillaAparecio> | null = null;
      for (const espera of RELECTURA_MS) {
        if (Date.now() + espera > fin) break;
        await new Promise((r) => setTimeout(r, espera));
        const restante = fin - Date.now();
        if (restante < 1500) break;
        const crudos = await leerChat(
          socket, opts.cred, opts.chatId, Math.min(ESPERA_LECTURA_MS, restante),
        ) as MensajeCrudo[] | null;
        ultima = plantillaAparecio(antes, crudos, { ancla, nombre: opts.nombrePlantilla });
        if (ultima.visto) {
          return { estado: "confirmado", mensajeId: ultima.mensajeId, senal: ultima.senal!, respuesta: resp };
        }
      }

      // ImporChat aceptó y el mensaje no apareció. NO es lo mismo que "falló":
      // se registra distinto para poder contarlo y, si es mucho, reclamárselo.
      const motivo = ultima?.motivo === "sin_hilo" || ultima?.motivo === "sin_ids"
        ? "ImporChat aceptó el envío pero no pude releer el chat para comprobarlo."
        : "ImporChat aceptó el envío pero el mensaje NO aparece en la conversación.";
      return { estado: "no_confirmado", motivo, respuesta: resp };
    });
  } catch (e) {
    return {
      estado: "sin_lectura",
      motivo: e instanceof Error ? e.message : String(e),
    };
  }
}

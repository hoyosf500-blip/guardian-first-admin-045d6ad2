import { usarSocket, leerChat, type CredencialIC } from "./imporchatSocket.ts";
import {
  anclaDePlantilla, idsSalientes, plantillaAparecio,
  type MensajeCrudo, type SenalPlantilla,
} from "./plantillaEnHilo.ts";
import { wamidDe } from "./imporchatRegistrarMensaje.ts";

/**
 * Manda una plantilla, la DEJA ESCRITA en la conversación, y no la da por
 * enviada hasta tener el recibo de Meta.
 *
 * ── Primera versión (4-sep-2026, mañana): confirmar releyendo el chat ───────
 * Se midió que del 25-ago al 4-sep había 14 apuntes de "Mandé la plantilla X" y
 * 9 clientes sin ningún mensaje saliente. Se concluyó que ImporChat aceptaba y
 * no entregaba, y se hizo que Guardian releyera el hilo antes de cantar el
 * envío.
 *
 * ⛔ ── La corrección (esa misma noche): la premisa era FALSA ────────────────
 * Las plantillas SÍ llegaban al cliente. Ariana Cárdenas (#6856013) contestó
 * apretando "Perfecto", el único botón "Perfecto" de las 46 plantillas de la
 * cuenta: tuvo el mensaje. Lo que faltaba era la SEGUNDA llamada que hace el
 * panel de ImporChat, `clientes_chat_center/agregarMensajeEnviado`, que es la
 * que deja el mensaje en la conversación. Guardian solo hacía la primera.
 *
 * O sea que "releer el hilo" era buscar algo que nadie estaba escribiendo:
 * jamás iba a confirmar, y con el arreglo puesto le habría dicho a la asesora
 * "no salió, mandala de nuevo" sobre mensajes que el cliente YA TENÍA — que es
 * peor que el bug original, porque termina en dos WhatsApp al mismo cliente.
 *
 * ── Lo que confirma un envío ahora ─────────────────────────────────────────
 * El **wamid**. Es el id que devuelve Meta cuando acepta el mensaje
 * (`message_status:"accepted"`), y es lo que mira el propio panel. Un
 * `success:true` SIN wamid sigue siendo sospechoso y se trata como fallo: esa
 * era exactamente la señal que engañaba antes.
 *
 * La relectura del hilo se conserva, pero cambió de papel: ya no decide si el
 * mensaje salió, sino si quedó BIEN REGISTRADO. Y si no se puede leer el chat,
 * **el envío sigue adelante**: antes eso lo cancelaba, y cancelar un aviso al
 * cliente porque un socket no abrió es un precio que no vale la pena pagar
 * cuando el recibo de Meta ya nos dice la verdad.
 */

/** Esperas antes de cada relectura. Corta apenas aparece. Es más corta que la
 *  primera versión porque ahora el mensaje lo escribimos nosotros: si va a
 *  aparecer, aparece rápido. */
const RELECTURA_MS = [1200, 2000, 3500, 5000];
/** Techo duro de la fase de comprobación. Ya no bloquea nada: vencido, el
 *  envío igual se da por bueno si hay wamid. */
const PRESUPUESTO_CONFIRMAR_MS = 15_000;
/** Lectura individual: no puede comerse el presupuesto entero. */
const ESPERA_LECTURA_MS = 6_000;

export type ResultadoPlantilla =
  | {
    estado: "confirmado";
    /** El recibo de Meta. Es lo que prueba que salió. */
    wamid: string;
    /** ¿Quedó escrita en la conversación de ImporChat? */
    registrado: boolean;
    /** ¿Se la llegó a ver releyendo el hilo? Informativo. */
    visto: boolean;
    mensajeId: string | null;
    senal: SenalPlantilla | null;
    respuesta: Record<string, unknown> | null;
  }
  | { estado: "fallido"; motivo: string; respuesta: Record<string, unknown> | null };

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
  /** Deja el mensaje en la conversación. Recibe el recibo de Meta. */
  registrar: (wamid: string) => Promise<{ ok: boolean; detalle: string }>;
}): Promise<ResultadoPlantilla> {
  const ancla = anclaDePlantilla(opts.cuerpoPlantilla);

  // ⛔ Candado anti doble envío. El POST vive dentro del bloque del socket, y
  // si algo de ese bloque explota DESPUÉS de mandar, el camino de respaldo no
  // puede volver a mandar: serían dos WhatsApp al mismo cliente.
  let yaMande = false;
  /** Lo que devolvió el envío. Si el socket muere DESPUÉS de mandar, esto es lo
   *  que se contesta: el mensaje salió y decir "falló" haría que se reenvíe. */
  let resultadoDelEnvio: ResultadoPlantilla | null = null;

  /** Manda y registra. Nunca manda dos veces. */
  const mandarYRegistrar = async (): Promise<ResultadoPlantilla> => {
    yaMande = true;
    const envio = await opts.enviar();
    const resp = respuestaSegura(envio.datos);
    if (!envio.ok) {
      return (resultadoDelEnvio = {
        estado: "fallido", motivo: `ImporChat rechazó el envío: ${envio.detalle}`, respuesta: resp,
      });
    }
    if (envio.datos?.success !== true) {
      return (resultadoDelEnvio = {
        estado: "fallido",
        motivo: String(envio.datos?.message || "ImporChat no confirmó el envío"),
        respuesta: resp,
      });
    }
    const wamid = wamidDe(envio.datos);
    if (!wamid) {
      // Esta es la señal que engañaba: aceptaron el pedido y Meta no dio recibo.
      return (resultadoDelEnvio = {
        estado: "fallido",
        motivo: "ImporChat aceptó el pedido pero Meta no devolvió el recibo del mensaje (sin wamid).",
        respuesta: resp,
      });
    }

    let registrado = false;
    try {
      const reg = await opts.registrar(wamid);
      registrado = reg.ok;
      if (!reg.ok) console.warn(`[plantilla] Meta OK, no quedó en el chat: ${reg.detalle}`);
    } catch (e) {
      console.warn(`[plantilla] Meta OK, no quedó en el chat: ${e instanceof Error ? e.message : String(e)}`);
    }

    return (resultadoDelEnvio = {
      estado: "confirmado",
      wamid, registrado, visto: false, mensajeId: null, senal: null, respuesta: resp,
    });
  };

  try {
    return await usarSocket(async (socket) => {
      // El baseline sirve para distinguir MI mensaje de uno viejo con el mismo
      // cuerpo. Si no se puede leer ya NO se cancela el envío: se manda igual y
      // se dice que no se pudo comprobar el registro.
      const antes = idsSalientes(await leerChat(socket, opts.cred, opts.chatId, ESPERA_LECTURA_MS));

      const resultado = await mandarYRegistrar();
      if (resultado.estado !== "confirmado") return resultado;
      if (antes === null) return resultado;

      const fin = Date.now() + PRESUPUESTO_CONFIRMAR_MS;
      for (const espera of RELECTURA_MS) {
        if (Date.now() + espera > fin) break;
        await new Promise((r) => setTimeout(r, espera));
        const restante = fin - Date.now();
        if (restante < 1200) break;
        const crudos = await leerChat(
          socket, opts.cred, opts.chatId, Math.min(ESPERA_LECTURA_MS, restante),
        ) as MensajeCrudo[] | null;
        const visto = plantillaAparecio(antes, crudos, { ancla, nombre: opts.nombrePlantilla });
        if (visto.visto) {
          return { ...resultado, visto: true, mensajeId: visto.mensajeId, senal: visto.senal ?? null };
        }
      }
      return resultado;
    });
  } catch (e) {
    // El socket no abrió (o murió). Con el recibo de Meta ya no hace falta para
    // decir la verdad, así que se manda igual — salvo que ya se haya mandado.
    if (yaMande) {
      // El mensaje salió: lo que se cortó fue la comprobación, que ya no decide
      // nada. Devolver "fallido" acá sería mandar a reenviar algo entregado.
      if (resultadoDelEnvio) return resultadoDelEnvio;
      return {
        estado: "fallido",
        motivo: `Se mandó y no se pudo saber cómo terminó: ${e instanceof Error ? e.message : String(e)}`,
        respuesta: null,
      };
    }
    return await mandarYRegistrar();
  }
}

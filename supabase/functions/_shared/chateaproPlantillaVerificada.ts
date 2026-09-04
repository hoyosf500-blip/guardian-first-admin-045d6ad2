import { leerHilo, type ChateaproConfig, type MensajeConversacion } from "./chateaproApi.ts";
import {
  anclaDePlantilla, idsSalientes, plantillaAparecio,
  type MensajeCrudo, type SenalPlantilla,
} from "./plantillaEnHilo.ts";

/**
 * Colombia: manda la plantilla y NO la da por enviada hasta verla en el chat.
 *
 * Es la contraparte de `imporchatPlantillaVerificada.ts`. Misma regla, misma
 * lógica pura (`plantillaEnHilo.ts`) — una sola definición de "apareció", o los
 * dos países dirían cosas distintas sobre el mismo hecho.
 *
 * ── Por qué acá también, si Colombia no falló ──────────────────────────────
 * Del 20-ago al 4-sep-2026 Colombia lleva 17 plantillas y 17 entregadas: cero
 * fallas. En Ecuador, con el MISMO diseño de candado, 9 de 14 nunca salieron.
 * Eso es justo lo que descarta que la culpa sea del diseño… y también lo que
 * hace peligroso dejar Colombia como está: el día que Chatea Pro tenga el mal
 * día que tuvo ImporChat, Guardian anotaría 17 de 17 igual. El arreglo no es
 * para el bug que hubo, es para el que todavía no se vio.
 *
 * ── Dos cosas en las que Colombia es DISTINTA, y no de la forma que yo suponía ─
 *
 * 1. Es MÁS FÁCIL, no más difícil. El plan de esta tanda decía que acá "no hay
 *    con qué releer". Falso: Chatea Pro es REST puro (`GET
 *    /subscriber/chat-messages`), sin socket, sin XLSX. Y devuelve el NOMBRE de
 *    la plantilla en cada mensaje del hilo, así que la confirmación es exacta
 *    en vez de por ancla de texto. Por eso `plantillaEnHilo.ts` ganó la señal
 *    `"plantilla"`, que es la más fuerte de todas.
 *
 * 2. El contacto nuevo SÍ es un caso real. Si el cliente todavía no existe como
 *    contacto, se lo crea al vuelo — y entonces no hay `user_ns` con el cual
 *    leer ANTES de mandar. Ahí ⛔ NO se inventa un baseline vacío: parece
 *    inofensivo ("un contacto nuevo no tiene mensajes") pero el buscador de
 *    Chatea Pro no busca por subcadena y ya se midió que devuelve 0 resultados
 *    con el formato equivocado. O sea que "no lo encontré" puede significar "no
 *    existe" o "lo busqué mal", y con baseline vacío el segundo caso confirma
 *    como MÍO un mensaje de ayer. Eso es exactamente la mentira que esta tanda
 *    vino a matar. Se manda, y se deja dicho que no se pudo comprobar.
 */

/** Igual que en Ecuador: cortar apenas aparece, así el caso normal es la
 *  primera. Con una sola espera fija, si Chatea Pro tarda en persistir da falso
 *  negativo → la asesora reintenta → DOBLE WhatsApp al cliente. */
const RELECTURA_MS = [1200, 2000, 3500, 5000, 8000];
/** Techo duro de la fase de confirmación. La plataforma mata la función a los
 *  ~150 s y antes de esto ya se gastaron la lista de plantillas y el POST.
 *  Menos que en Ecuador porque acá cada lectura es un GET, no un socket. */
const PRESUPUESTO_CONFIRMAR_MS = 30_000;

export type ResultadoPlantillaCp =
  | { estado: "confirmado"; mensajeId: string | null; senal: SenalPlantilla; respuesta: Record<string, unknown> | null }
  | { estado: "no_confirmado"; motivo: string; respuesta: Record<string, unknown> | null }
  | { estado: "fallido"; motivo: string; respuesta: Record<string, unknown> | null }
  | { estado: "sin_lectura"; motivo: string };

/**
 * Adapta el mensaje de Chatea Pro a la forma que entiende la lógica pura.
 *
 * `de: "negocio"` es lo saliente. `rol_mensaje: 1` es la convención que
 * `plantillaEnHilo.ts` heredó de ImporChat; se traduce acá y no allá para que
 * el módulo puro no tenga que conocer a ninguno de los dos canales.
 */
export function aCrudo(m: MensajeConversacion): MensajeCrudo {
  return {
    id: m.id,
    rol_mensaje: m.de === "negocio" ? 1 : 0,
    texto_mensaje: m.texto,
    tipo_mensaje: m.tipo,
    plantilla_mensaje: m.plantilla ?? null,
  };
}

/** Lee el hilo y lo devuelve en forma cruda. `null` = no se pudo leer, que NO
 *  es lo mismo que "no hay mensajes" y por eso no se colapsa a `[]`. */
async function leerCrudos(cfg: ChateaproConfig, userNs: string): Promise<MensajeCrudo[] | null> {
  try {
    const hilo = await leerHilo(cfg, userNs);
    return hilo.mensajes.map(aCrudo);
  } catch {
    return null;
  }
}

/** Solo estas claves de la respuesta se guardan. El payload que se ENVÍA no se
 *  guarda nunca: ahí van nombre, dirección y teléfono del cliente. */
function respuestaSegura(datos: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!datos) return null;
  const out: Record<string, unknown> = {};
  for (const k of ["success", "status", "message", "wamid", "error", "code"]) {
    if (k in datos) out[k] = typeof datos[k] === "string" ? String(datos[k]).slice(0, 300) : datos[k];
  }
  return Object.keys(out).length > 0 ? out : null;
}

export async function enviarPlantillaVerificadaCp(opts: {
  cfg: ChateaproConfig;
  /** `null` = el contacto no existe todavía y se crea al vuelo. Ver el punto 2
   *  del comentario de arriba: ese caso no se puede confirmar. */
  userNs: string | null;
  /** El cuerpo con `{{n}}` — de ahí sale el ancla, que es el respaldo por si el
   *  hilo no trae el nombre de la plantilla. */
  cuerpoPlantilla: string;
  nombrePlantilla: string;
  /** Hace el POST real. Se inyecta para no duplicar el cliente HTTP acá. */
  enviar: () => Promise<{ ok: boolean; datos: Record<string, unknown> | null; detalle: string }>;
}): Promise<ResultadoPlantillaCp> {
  const ancla = anclaDePlantilla(opts.cuerpoPlantilla);

  // ── CONTACTO NUEVO ─────────────────────────────────────────────────────────
  // No hay hilo previo que leer. Se manda igual —cortar acá dejaría sin
  // plantilla a todo cliente que escribe por primera vez, que es un flujo que
  // hoy funciona— pero se devuelve `no_confirmado`, no `confirmado`. La pantalla
  // dice "salió, no pude comprobarlo": ni un verde mentiroso ni un rojo falso.
  if (!opts.userNs) {
    const envio = await opts.enviar();
    const resp = respuestaSegura(envio.datos);
    if (!envio.ok) {
      return { estado: "fallido", motivo: `Chatea Pro rechazó el envío: ${envio.detalle}`, respuesta: resp };
    }
    return {
      estado: "no_confirmado",
      motivo: "Se le creó el contacto y salió el envío, pero como no había conversación previa no pude comprobar que el mensaje entró al chat.",
      respuesta: resp,
    };
  }

  // ── BASELINE ───────────────────────────────────────────────────────────────
  // Sin baseline no se puede distinguir MI plantilla de una que se mandó ayer
  // con el mismo cuerpo. O sea: se podría volver a mentir. Si no se puede leer,
  // NO SE MANDA — y se dice. Es la misma regla que en Ecuador.
  let antes = idsSalientes(await leerCrudos(opts.cfg, opts.userNs));
  if (antes === null) antes = idsSalientes(await leerCrudos(opts.cfg, opts.userNs));
  if (antes === null) {
    return {
      estado: "sin_lectura",
      motivo: "No pude leer el chat para comprobar el envío, así que no mandé nada.",
    };
  }

  // ── ENVÍO ──────────────────────────────────────────────────────────────────
  const envio = await opts.enviar();
  const resp = respuestaSegura(envio.datos);
  if (!envio.ok) {
    return { estado: "fallido", motivo: `Chatea Pro rechazó el envío: ${envio.detalle}`, respuesta: resp };
  }

  // ── CONFIRMACIÓN ───────────────────────────────────────────────────────────
  const fin = Date.now() + PRESUPUESTO_CONFIRMAR_MS;
  let ultima: ReturnType<typeof plantillaAparecio> | null = null;
  for (const espera of RELECTURA_MS) {
    if (Date.now() + espera > fin) break;
    await new Promise((r) => setTimeout(r, espera));
    if (fin - Date.now() < 1200) break;
    const crudos = await leerCrudos(opts.cfg, opts.userNs);
    ultima = plantillaAparecio(antes, crudos, { ancla, nombre: opts.nombrePlantilla });
    if (ultima.visto) {
      return { estado: "confirmado", mensajeId: ultima.mensajeId, senal: ultima.senal!, respuesta: resp };
    }
  }

  // Chatea Pro aceptó y el mensaje no apareció. NO es lo mismo que "falló": se
  // registra distinto para poder contarlo y, si es mucho, reclamárselo.
  const motivo = ultima?.motivo === "sin_hilo" || ultima?.motivo === "sin_ids"
    ? "Chatea Pro aceptó el envío pero no pude releer el chat para comprobarlo."
    : "Chatea Pro aceptó el envío pero el mensaje NO aparece en la conversación.";
  return { estado: "no_confirmado", motivo, respuesta: resp };
}

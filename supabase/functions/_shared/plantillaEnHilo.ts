/**
 * ¿La plantilla que acabo de mandar APARECIÓ en la conversación?
 *
 * ⛔ Por qué existe (medido en producción el 4-sep-2026, Ecuador). Del 25-ago al
 * 4-sep, `touchpoints` tenía 14 apuntes de "Mandé la plantilla X" y **9 de esos
 * clientes no recibieron ningún mensaje**: su último saliente real era de días
 * antes. ImporChat contestaba `success: true` y el mensaje no entraba al hilo.
 * Guardian escribía el touchpoint, pintaba la tarjeta como gestionada y sumaba
 * la gestión a la productividad. El cliente, mientras tanto, no tenía nada.
 *
 * El `success:true` de `enviar_template_masivo` confirma que RECIBIERON EL
 * PEDIDO, no que ENTREGARON EL MENSAJE. La única forma de saberlo es mirar el
 * hilo — que es lo que `importchat-send` ya hace para el texto libre desde
 * siempre, y por eso el texto libre sí funcionaba. Este módulo es ese mismo
 * molde, adaptado a plantillas.
 *
 * Control que lo prueba: Colombia usa el MISMO diseño de candado y desde el
 * 20-ago lleva 17 plantillas y 17 entregadas. El candado no era el culpable.
 *
 * ── LA SEÑAL ────────────────────────────────────────────────────────────────
 *
 * Dos partes, y ninguna es la hora:
 *
 * 1. **Novedad por `id`.** Antes de mandar se guarda el conjunto de ids de los
 *    mensajes SALIENTES del hilo. Después solo cuentan los ids que no estaban.
 *    Es el mismo espíritu del "conteo, no existencia" de `importchat-send`, con
 *    una llave más fuerte que el hilo ya trae.
 *
 * 2. **Ancla del cuerpo.** El tramo literal más largo ENTRE huecos, normalizado.
 *    No depende de los valores, así que sirve igual si ImporChat guardó el
 *    mensaje renderizado ("Hola Néstor, su pedido…") o el cuerpo crudo con los
 *    `{{1}}` sin rellenar. Exigir el texto exacto sería suponer un formato que
 *    nadie midió.
 *
 * ⛔ NO se usa `created_at` como señal: `_shared/conversacion.ts` ya documenta
 * que el socket lo devuelve en local sin zona y que el filtro temporal daba
 * falsos positivos Y negativos. Ese error ya se pagó una vez.
 */

/** Mínimo de caracteres para que un ancla sea confiable. Por debajo matchearía
 *  cualquier cosa ("hola", "su pedido") y confirmaría el mensaje del bot. */
export const ANCLA_MIN = 12;
/** Techo: con más de esto se vuelve frágil ante cualquier reescritura de Meta.
 *  Se corta en el último espacio para no partir una palabra por la mitad. */
export const ANCLA_MAX = 64;

export interface MensajeCrudo {
  id?: unknown;
  rol_mensaje?: number;
  texto_mensaje?: unknown;
  tipo_mensaje?: unknown;
  /** El NOMBRE de la plantilla que el canal dice haber mandado en ese mensaje.
   *  Chatea Pro (Colombia) lo devuelve en el hilo; ImporChat no. Es la senal
   *  mas fuerte que existe —no depende del texto ni de como Meta lo reescriba—
   *  asi que cuando esta, manda. Opcional a proposito: Ecuador sigue igual. */
  plantilla_mensaje?: unknown;
}

export type SenalPlantilla = "plantilla" | "ancla" | "nombre" | "tipo" | "tardia";

export interface Aparicion {
  visto: boolean;
  mensajeId: string | null;
  senal: SenalPlantilla | null;
  /** `ok` · `sin_novedad` (no salió) · `sin_ids` (no sé) · `sin_hilo` (no sé). */
  motivo: "ok" | "sin_novedad" | "sin_ids" | "sin_hilo";
}

/** Sin tildes, sin emoji, sin puntuación, en minúsculas y con un solo espacio.
 *  Así el ancla sobrevive a que WhatsApp o ImporChat re-codifiquen el texto. */
export function normalizarParaBuscar(s: string): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * El tramo literal más largo entre huecos, normalizado y recortado.
 *
 * Ejemplo real (`retiro_agencia_k1`):
 *   "Hola {{1}}, tu pedido ya llegó y está listo para que lo retires 🎉\n\n📍Agencia: {{2}}…"
 *   → "tu pedido ya llego y esta listo para que lo retires"
 */
export function anclaDePlantilla(cuerpo: string): string | null {
  const tramos = String(cuerpo ?? "")
    .split(/\{\{\s*\d+\s*\}\}/)
    .map(normalizarParaBuscar)
    .filter((t) => t.length >= ANCLA_MIN);
  if (tramos.length === 0) return null;
  const mejor = tramos.reduce((a, b) => (b.length > a.length ? b : a));
  if (mejor.length <= ANCLA_MAX) return mejor;
  const cortado = mejor.slice(0, ANCLA_MAX);
  const corte = cortado.lastIndexOf(" ");
  const final = (corte >= ANCLA_MIN ? cortado.slice(0, corte) : cortado).trim();
  return final || null;
}

/** Ids de los mensajes SALIENTES (rol 1) del hilo. `null` = no se pudo leer. */
export function idsSalientes(crudos: MensajeCrudo[] | null): Set<string> | null {
  if (crudos === null) return null;
  const out = new Set<string>();
  for (const m of crudos) {
    if (m.rol_mensaje !== 1) continue;
    if (m.id === null || m.id === undefined || m.id === "") continue;
    out.add(String(m.id));
  }
  return out;
}

/**
 * ¿Hay un saliente NUEVO que sea esta plantilla?
 *
 * Tres niveles, de mayor a menor fuerza. El nivel usado viaja en `senal` y se
 * guarda: con el tiempo dice qué tan bien está funcionando el reconocimiento.
 */
export function plantillaAparecio(
  antes: Set<string> | null,
  despues: MensajeCrudo[] | null,
  opts: { ancla: string | null; nombre: string },
): Aparicion {
  if (despues === null) return { visto: false, mensajeId: null, senal: null, motivo: "sin_hilo" };
  if (antes === null) return { visto: false, mensajeId: null, senal: null, motivo: "sin_ids" };

  const salientes = despues.filter((m) => m.rol_mensaje === 1);
  // Sin ids no hay novedad computable. "No sé" NO es "no salió": se dicen
  // distinto y el llamador nunca marca un envío con esto.
  if (salientes.length > 0 && salientes.every((m) => m.id === null || m.id === undefined || m.id === "")) {
    return { visto: false, mensajeId: null, senal: null, motivo: "sin_ids" };
  }

  const nombreN = normalizarParaBuscar(opts.nombre);
  for (const m of salientes) {
    const id = m.id === null || m.id === undefined ? "" : String(m.id);
    if (!id || antes.has(id)) continue; // ya estaba: no es mío
    const texto = normalizarParaBuscar(String(m.texto_mensaje ?? ""));
    const tipo = String(m.tipo_mensaje ?? "").toLowerCase();

    // El canal nos dice literalmente que plantilla mando. Es exacto: ni ancla
    // ni subcadena. Si esta, no hay nada que adivinar.
    const plantillaDelMensaje = m.plantilla_mensaje == null ? "" : String(m.plantilla_mensaje).trim();
    if (plantillaDelMensaje && plantillaDelMensaje === String(opts.nombre).trim()) {
      return { visto: true, mensajeId: id, senal: "plantilla", motivo: "ok" };
    }
    if (opts.ancla && texto.includes(opts.ancla)) {
      return { visto: true, mensajeId: id, senal: "ancla", motivo: "ok" };
    }
    if (nombreN && texto.includes(nombreN)) {
      return { visto: true, mensajeId: id, senal: "nombre", motivo: "ok" };
    }
    // Marcador sin cuerpo: algunos paneles guardan la plantilla sin el texto.
    if (!texto && tipo === "template") {
      return { visto: true, mensajeId: id, senal: "tipo", motivo: "ok" };
    }
    // Un saliente nuevo que no matchea nada NO confirma: casi seguro es el bot
    // mandando otra cosa en el mismo instante.
  }

  return { visto: false, mensajeId: null, senal: null, motivo: "sin_novedad" };
}

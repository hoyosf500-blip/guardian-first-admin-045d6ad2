// La conversación de WhatsApp, normalizada para poder mostrarla en Guardian.
//
// ── Por qué existe ─────────────────────────────────────────────────────────
// Guardian ya sabía MANDAR un mensaje pero no LEER la conversación: para ver
// qué había dicho el cliente había que abrir ImporChat en otra pestaña, así que
// la asesora escribía a ciegas. Y la pregunta original del dueño —"¿lo escribió
// el bot o la asesora?"— seguía sin respuesta MENSAJE POR MENSAJE.
//
// El dato ya estaba en la mano: `importchat-send` pedía la conversación entera
// para verificar el envío y se quedaba solo con un true/false. Acá se le da
// forma.
//
// ── La regla que no se negocia ─────────────────────────────────────────────
// **Guardian no adivina quién escribió.** Muestra el `responsable` tal cual
// viene ('Shopify Confirmación' = automático, 'Estefano Moreno' = asesora). Si
// viene vacío, el autor queda en `null` y la pantalla dice que no se sabe —
// jamás "bot". Es la misma regla que hace que `chat_saliente_at` en NULL nunca
// signifique "no le escribieron".
// El desglose AGREGADO bot-vs-persona ya existe por otra vía y no se duplica
// acá: `orders.chat_saliente_tipo` ('plantilla' | 'directo').
//
// ── Por qué vive en `_shared/` ─────────────────────────────────────────────
// `vitest.config.ts` solo mira `src/**`: las pruebas que viven dentro de
// `supabase/functions/` NUNCA corren. El patrón del repo es dejar la lógica
// pura acá y poner el test en `src/lib/` cruzando el límite (igual que
// `ventanaWhatsapp` y `autoPushSelect`).

/**
 * Un mensaje tal como lo entrega el socket de ImporChat (no el export XLSX —
 * son formatos distintos).
 *
 * ⚠️ Vive acá y NO en `imporchatSocket.ts` a propósito: este archivo lo importa
 * `src/` cruzando el límite, y `imporchatSocket.ts` importa socket.io por URL,
 * que el `tsc` de la app no sabe resolver. Los `_shared` que consume el
 * frontend tienen que quedar SIN imports externos — por eso los otros
 * (`ventanaWhatsapp`, `autoPushSelect`, `walletCategoria`) tampoco tienen.
 */
export interface MensajeIC {
  id?: number | string;
  /** 0 = cliente · 1 = negocio · 3 = notificación interna. */
  rol_mensaje?: number;
  texto_mensaje?: string | null;
  created_at?: string;
  /** Quién lo escribió: 'Shopify Confirmación' (automático) | 'Estefano Moreno'
   *  (asesora) | null. Es el campo que el export XLSX NO trae. */
  responsable?: string | null;
  tipo_mensaje?: string | null;
  ruta_archivo?: string | null;
}

/** De qué lado del mostrador vino el mensaje. */
export type QuienEscribe = "cliente" | "negocio" | "sistema";

export interface MensajeConversacion {
  id: string;
  /** Instante del mensaje en ms UTC. `null` = el socket no lo trajo. */
  fechaMs: number | null;
  de: QuienEscribe;
  texto: string;
  /** El `responsable` CRUDO. `null` = no vino — nunca se traduce a "bot". */
  autor: string | null;
  tipo: string | null;
  /** `texto` es un marcador que armamos nosotros (audio, foto), no lo escrito. */
  esMarcador: boolean;
  /**
   * URL del adjunto (la foto que mandó el cliente, el comprobante, el audio).
   *
   * ⛔ ImporChat SIEMPRE mandó esto en `ruta_archivo` y acá se TIRABA: solo se
   * miraba para elegir un marcador de texto ("🖼️ Imagen") y la ruta nunca
   * llegaba a la pantalla. Por eso "los chats no cargan las imágenes" — no es
   * que fallaran, es que nunca se pidieron. Y el comprobante de pago que manda
   * un cliente por WhatsApp es, muchas veces, la conversación entera.
   *
   * Absoluta siempre: si viene relativa se le antepone el host de ImporChat.
   * `null` = el mensaje no traía adjunto.
   */
  archivoUrl: string | null;
  /**
   * Lo que DICE una nota de voz, en texto.
   *
   * Chatea Pro transcribe los audios solo y lo devuelve en
   * `payload.transcribed_text`. Es exactamente lo que faltaba en ImporChat: se
   * medió sobre 18 conversaciones reales de Ecuador que **14 traían audio** —
   * el cliente responde hablando mucho más de lo que escribe—, y hasta ahora la
   * única forma de saber qué dijo era ponerse a escucharlo.
   *
   * `null` = ese mensaje no es audio, o el canal no transcribe. NUNCA se
   * inventa un texto: sin transcripción queda solo el reproductor.
   */
  transcripcion?: string | null;

  /**
   * Nombre de la plantilla, cuando el mensaje SALIÓ como plantilla de Meta.
   *
   * No se muestra —la asesora ve el texto que leyó el cliente, no el código—
   * pero `chateapro-sync` lo necesita para responder si a ese cliente se le
   * llegó a OFRECER el botón de confirmar. Sin plantilla enviada no se puede
   * exigir un botón que nunca apareció, y ese pedido no puede clasificarse
   * como "no confirmó".
   *
   * `null` = no fue una plantilla, o el canal no dice cuál.
   */
  plantilla?: string | null;
}

/** Host de los adjuntos de ImporChat. `ruta_archivo` puede venir absoluta
 *  ("https://…/x.jpg") o relativa ("/uploads/x.jpg"); esto normaliza las dos
 *  sin inventar nada: lo que no parece ruta usable queda en `null`. */
const ARCHIVOS_BASE = "https://chat.imporfactory.app";

export function urlDeArchivo(ruta: string | null | undefined): string | null {
  const r = String(ruta ?? "").trim();
  if (!r) return null;
  // ⛔ `ruta_archivo` NO SIEMPRE ES UN ARCHIVO. Medido en 18 conversaciones
  // reales de Ecuador el 28-ago-2026: en los mensajes `template` y `text`
  // ImporChat mete ahí un **JSON con los datos del pedido** (nombre, dirección,
  // celular del cliente) — 68 de 98 casos. Tratarlo como ruta armaba un enlace
  // roto y, peor, metía datos personales del cliente dentro de una URL.
  // Los adjuntos DE VERDAD (image/audio/video) vienen absolutos y limpios.
  if (/^[[{]/.test(r)) return null;
  if (/[\s"'<>\\]/.test(r)) return null;
  if (/^https?:\/\//i.test(r)) return r;
  // `//host/x` es protocolo-relativo; `///x` o `//uploads/x` NO son un host,
  // son una ruta con barras de más. Se exige que lo de después parezca dominio.
  if (/^\/\/[^/]+\.[^/]+\//.test(r)) return `https:${r}`;
  return `${ARCHIVOS_BASE}/${r.replace(/^\/+/, "")}`;
}

/**
 * Filas que NO son un mensaje hacia el cliente aunque vengan con rol de
 * negocio: tráfico interno del panel y borrados. Mismo criterio que
 * `derivarActividadChat` en `senalConfirmacion.ts` — no se reimplementa.
 */
const TIPOS_DE_SISTEMA = new Set(["notificacion", "revoke"]);

/** Qué se muestra cuando el mensaje no tiene texto (una foto, un audio…). */
const MARCADOR: Record<string, string> = {
  audio: "🎧 Nota de voz",
  ptt: "🎧 Nota de voz",
  image: "🖼️ Imagen",
  sticker: "🙂 Sticker",
  video: "🎬 Video",
  document: "📎 Archivo",
  file: "📎 Archivo",
  location: "📍 Ubicación",
  contact: "👤 Contacto",
  button: "🔘 Botón",
  template: "📄 Plantilla",
  revoke: "🚫 Mensaje eliminado",
};
const MARCADOR_GENERICO = "📎 Adjunto";

function fechaDe(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function ladoDe(m: MensajeIC): QuienEscribe {
  const tipo = String(m.tipo_mensaje ?? "").toLowerCase();
  // Un `revoke` o una notificación interna no son conversación aunque el rol
  // diga "negocio": son ruido del panel y se muestran aparte.
  if (TIPOS_DE_SISTEMA.has(tipo)) return "sistema";
  if (m.rol_mensaje === 0) return "cliente";
  if (m.rol_mensaje === 1) return "negocio";
  // rol 3 (notificación) y cualquier rol desconocido: no se descarta —
  // desaparecer un mensaje es peor que mostrarlo tenue en el medio.
  return "sistema";
}

function textoDe(m: MensajeIC): { texto: string; esMarcador: boolean } {
  const crudo = String(m.texto_mensaje ?? "").trim();
  if (crudo) return { texto: crudo, esMarcador: false };
  const tipo = String(m.tipo_mensaje ?? "").toLowerCase();
  if (tipo && MARCADOR[tipo]) return { texto: MARCADOR[tipo], esMarcador: true };
  if (m.ruta_archivo) return { texto: MARCADOR_GENERICO, esMarcador: true };
  return { texto: "(sin texto)", esMarcador: true };
}

/**
 * Convierte lo que entrega el socket en algo que se puede pintar.
 *
 * - Deduplica por `id` (el socket a veces repite el último mensaje).
 * - Ordena cronológicamente. **Un mensaje sin fecha no se manda al principio
 *   ni al final**: se queda pegado al anterior, que es donde el socket lo
 *   entregó. Mandarlo al borde reordenaría la conversación y haría parecer que
 *   la asesora contestó antes de que el cliente preguntara.
 * - `null` (no se pudo leer) y `[]` (chat vacío) devuelven ambos una lista
 *   vacía; distinguirlos es trabajo de quien llama, que sí sabe cuál pasó.
 */
export function normalizarConversacion(mensajes: MensajeIC[] | null | undefined): MensajeConversacion[] {
  if (!mensajes || mensajes.length === 0) return [];

  const vistos = new Set<string>();
  const conOrden: { msg: MensajeConversacion; orden: number; i: number }[] = [];
  let ultimaFecha = 0;

  for (let i = 0; i < mensajes.length; i++) {
    const m = mensajes[i];
    const id = m.id != null && String(m.id) !== "" ? String(m.id) : `sin-id-${i}`;
    if (vistos.has(id)) continue;
    vistos.add(id);

    const fechaMs = fechaDe(m.created_at);
    if (fechaMs != null) ultimaFecha = fechaMs;
    const { texto, esMarcador } = textoDe(m);
    const autor = String(m.responsable ?? "").trim();

    conOrden.push({
      i,
      orden: fechaMs ?? ultimaFecha,
      msg: {
        id,
        fechaMs,
        de: ladoDe(m),
        texto,
        autor: autor || null,
        tipo: m.tipo_mensaje ? String(m.tipo_mensaje).toLowerCase() : null,
        esMarcador,
        archivoUrl: urlDeArchivo(m.ruta_archivo),
      },
    });
  }

  // Orden estable: a igual instante manda el orden en que llegó del socket.
  conOrden.sort((a, b) => (a.orden - b.orden) || (a.i - b.i));
  return conOrden.map((x) => x.msg);
}

/**
 * Último mensaje REAL del cliente. Es lo que abre la ventana de 24 h de Meta,
 * así que se calcula sobre el hilo recién leído y no sobre la columna
 * sincronizada, que puede tener media hora de atraso.
 */
export function ultimoEntranteMs(msgs: MensajeConversacion[]): number | null {
  let ultimo: number | null = null;
  for (const m of msgs) {
    if (m.de !== "cliente" || m.fechaMs == null) continue;
    if (ultimo == null || m.fechaMs > ultimo) ultimo = m.fechaMs;
  }
  return ultimo;
}

/** Último mensaje del NEGOCIO y de qué tipo fue, para refrescar el pedido. */
export function ultimoSaliente(msgs: MensajeConversacion[]): { fechaMs: number; tipo: "plantilla" | "directo" } | null {
  let ultimo: MensajeConversacion | null = null;
  for (const m of msgs) {
    if (m.de !== "negocio" || m.fechaMs == null) continue;
    if (!ultimo || m.fechaMs > (ultimo.fechaMs ?? 0)) ultimo = m;
  }
  if (!ultimo || ultimo.fechaMs == null) return null;
  return { fechaMs: ultimo.fechaMs, tipo: ultimo.tipo === "template" ? "plantilla" : "directo" };
}

/**
 * Quién escribió lo ÚLTIMO que salió del negocio, con su nombre tal cual.
 *
 * Pedido del dueño (25-ago-2026) para la pantalla de Confirmar: *"ver si el bot
 * le envió la automatización"*. Ésta es la forma honesta de contestarlo.
 *
 * ⛔ **No devuelve "bot" ni "asesora": devuelve el NOMBRE.** Guardian no puede
 * saber si 'Dropi Status' es un robot y 'Estefano Moreno' una persona — eso lo
 * sabe quien mira la pantalla, de un vistazo, y en otra tienda los nombres
 * serían otros. Clasificar acá sería inventar una regla que se rompe sola.
 *
 * Tampoco sirve `chat_saliente_tipo` para esto: dice si el mensaje fue
 * plantilla o texto libre, NO quién lo mandó — y desde que Guardian también
 * manda plantillas aprobadas, 'plantilla' ya no equivale a 'automático'.
 *
 * `null` = no salió nada del negocio. Nombre vacío ⇒ `null`, nunca un rótulo
 * inventado (misma regla que el resto de este archivo).
 */
export function ultimoAutorNegocio(
  msgs: MensajeConversacion[],
): { autor: string; fechaMs: number | null } | null {
  let ultimo: MensajeConversacion | null = null;
  for (const m of msgs) {
    if (m.de !== "negocio") continue;
    if (!ultimo) { ultimo = m; continue; }
    // Sin fecha no se puede comparar: gana el que viene después en el hilo,
    // que ya está ordenado.
    if (m.fechaMs == null || ultimo.fechaMs == null || m.fechaMs >= ultimo.fechaMs) ultimo = m;
  }
  const autor = String(ultimo?.autor ?? "").trim();
  return autor ? { autor, fechaMs: ultimo!.fechaMs } : null;
}

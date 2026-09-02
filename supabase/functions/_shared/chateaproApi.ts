/**
 * Cliente de la API de Chatea Pro (chateapro.app) — el canal de WhatsApp de las
 * dos tiendas de Colombia.
 *
 * Es un whitelabel de UChat: OpenAPI 3.0, 227 rutas, `Authorization: Bearer`.
 * A diferencia de ImporChat acá **todo es REST**: no hace falta socket.io para
 * el texto libre ni bajar un XLSX de 9 MB para el historial.
 *
 * ── El puente que hace posible todo ────────────────────────────────────────
 * Guardian conoce al cliente por su TELÉFONO. Chatea Pro lo conoce por
 * `user_ns`. `GET /subscribers?phone=...` cruza los dos, y de ahí salen la
 * lectura, el envío y la plantilla. Sin ese cruce no hay módulo.
 *
 * ── La ventana de 24 h ─────────────────────────────────────────────────────
 * Meta solo entrega texto libre dentro de las 24 h del último mensaje DEL
 * CLIENTE. Acá NO se calcula por nuestra cuenta: el propio buscador de
 * suscriptores contesta `is_last_message_in_last_24h`, y además el hilo trae
 * la hora exacta del último entrante. Se usa el hilo (es el dato, no un
 * resumen) y el flag queda como respaldo.
 */

export const CHATEAPRO_BASE_DEFAULT = "https://chateapro.app/api";

export interface ChateaproConfig {
  apiKey: string;
  apiBase: string;
}

/** Últimos 9 dígitos — mismo criterio que `src/lib/phone.ts` y el reconcile. */
export function last9(p: unknown): string {
  return String(p ?? "").replace(/\D/g, "").slice(-9);
}

interface Sb {
  from: (t: string) => {
    select: (c: string) => {
      eq: (c: string, v: string) => { maybeSingle: () => Promise<{ data: unknown; error: unknown }> };
    };
  };
}

/** Credenciales de la tienda. `null` = esta tienda no usa Chatea Pro. */
export async function cargarConfigChateapro(sb: unknown, storeId: string): Promise<ChateaproConfig | null> {
  const { data, error } = await (sb as Sb)
    .from("store_chateapro_config")
    .select("api_key, api_base, habilitado")
    .eq("store_id", storeId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as { api_key?: string; api_base?: string; habilitado?: boolean };
  if (row.habilitado === false) return null;
  if (!row.api_key) return null;
  return { apiKey: row.api_key, apiBase: (row.api_base || CHATEAPRO_BASE_DEFAULT).replace(/\/+$/, "") };
}

export class ChateaproError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function llamar<T>(
  cfg: ChateaproConfig,
  metodo: "GET" | "POST" | "PUT" | "DELETE",
  ruta: string,
  opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
): Promise<T> {
  const url = new URL(cfg.apiBase + ruta);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    method: metodo,
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      Accept: "application/json",
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const txt = await res.text();
  if (!res.ok) {
    // El mensaje de Chatea Pro viaja en `message`. Se conserva: "Unauthenticated"
    // (key mala) y "scope" (key sin permisos) son diagnósticos distintos y el
    // operador tiene que poder distinguirlos sin abrir el panel.
    let msg = txt.slice(0, 300);
    try { const j = JSON.parse(txt); msg = j?.message || j?.error || msg; } catch { /* texto crudo */ }
    throw new ChateaproError(res.status, msg);
  }
  try { return JSON.parse(txt) as T; } catch { return {} as T; }
}

// ── Suscriptor ──────────────────────────────────────────────────────────────

export interface Suscriptor {
  user_ns: string;
  user_id?: string;
  name?: string;
  phone?: string;
}

/**
 * Encuentra al cliente por teléfono.
 *
 * ⛔ MEDIDO el 2-sep-2026 contra la cuenta real, y NO es lo que yo había
 * supuesto. El buscador de Chatea Pro **no busca por subcadena**: sobre un
 * cliente guardado como `3143048595`,
 *
 *     phone=3143048595   → 1 resultado
 *     phone=+573143048595 → 0
 *     phone=143048595     → 0   (los últimos 9)
 *
 * O sea que hay que probar el formato NACIONAL. Chatea Pro guarda los
 * colombianos con 10 dígitos y sin indicativo; Guardian los guarda igual, pero
 * Shopify los manda con `+57`, así que un cambio de origen del dato rompería
 * el cruce en silencio si solo se probara una forma.
 *
 * Se prueban varias y **se confirma comparando los últimos 9 dígitos**: un
 * match flojo acá le muestra a la asesora la conversación de OTRA persona, que
 * es peor que no mostrar nada.
 */
export async function buscarSuscriptorPorTelefono(
  cfg: ChateaproConfig,
  telefono: string,
  countryCode = "CO",
): Promise<Suscriptor | null> {
  const clave = last9(telefono);
  if (!clave) return null;

  const digitos = String(telefono ?? "").replace(/\D/g, "");
  const nacional = digitos.replace(/^0+/, "").slice(-10);
  const conIndicativo = idWhatsapp(telefono, countryCode); // 57XXXXXXXXXX
  const intentos = [
    String(telefono ?? "").trim(), // tal cual viene
    digitos,                        // sin símbolos
    nacional,                       // 3XXXXXXXXX — así lo guarda quien escribió primero
    // ⛔ `+57XXXXXXXXXX` — así queda un contacto CREADO POR LA API (al mandarle
    // una plantilla a alguien que nunca escribió). Medido el 2-sep-2026: sin
    // esta forma, el chat que acabamos de abrir salía como "nunca escribió" la
    // próxima vez que la asesora abriera el pedido.
    "+" + conIndicativo,
    conIndicativo,
    clave,                          // últimos 9, por si otra cuenta los guarda así
  ].filter((q) => q && q.length >= 7);

  const vistos = new Set<string>();
  for (const q of intentos) {
    if (vistos.has(q)) continue;
    vistos.add(q);
    const r = await llamar<{ data?: Suscriptor[] }>(cfg, "GET", "/subscribers", {
      query: { phone: q, limit: 20 },
    });
    const lista = Array.isArray(r?.data) ? r.data : [];
    const exacto = lista.find((s) => last9(s.phone) === clave);
    if (exacto) return exacto;
  }
  return null;
}

// ── Conversación ────────────────────────────────────────────────────────────

export type QuienEscribe = "cliente" | "negocio" | "sistema";

export interface MensajeConversacion {
  id: string;
  fechaMs: number | null;
  de: QuienEscribe;
  texto: string;
  autor: string | null;
  tipo: string | null;
  esMarcador: boolean;
  archivoUrl: string | null;
  /** Lo que DICE la nota de voz. Chatea Pro la transcribe sola. `null` = no es
   *  audio o no vino transcripción — nunca se inventa. */
  transcripcion?: string | null;
}

/**
 * Un mensaje tal como lo devuelve `/subscriber/chat-messages`.
 *
 * ⛔ MEDIDO el 2-sep-2026. Los nombres que yo había supuesto leyendo la spec
 * (`text`, `timestamp`, `agent_name`, `url`) NO existen: con ellos el hilo
 * salía con TODOS los mensajes en blanco. Los reales son estos.
 */
interface MensajeCp {
  id?: number | string;
  mid?: string;
  /** "in" = del cliente · "out" = del bot · "agent" = lo escribió una PERSONA
   *  desde el panel o desde Guardian · "note" = nota interna del asesor. */
  type?: string;
  /** text · image · audio · video · file · wa_template */
  msg_type?: string;
  /** El texto. Vacío en los adjuntos. */
  content?: string;
  /** Todo lo bueno vive ACÁ: la URL del adjunto, la transcripción de la nota de
   *  voz y —en una plantilla— el texto YA ARMADO que leyó el cliente. */
  payload?: {
    url?: string;
    title?: string | null;
    transcribed_text?: string | null;
    /** Plantilla: el mensaje renderizado, con los huecos rellenos. */
    body?: string | null;
  } | null;
  /** "bot" o el `user_ns` del cliente. */
  sender_id?: string;
  /** 0 = no lo escribió una persona. */
  agent_id?: number;
  /** "Bot" o el nombre de quien escribió. */
  username?: string;
  /** Unix en SEGUNDOS. */
  ts?: number;
}

const MARCADOR: Record<string, string> = {
  image: "🖼️ Imagen",
  audio: "🎤 Nota de voz",
  video: "🎬 Video",
  file: "📎 Archivo",
  wa_template: "📨 Plantilla",
};

/**
 * ⛔ `note` NO es un mensaje que el cliente haya visto: es una nota interna que
 * un asesor dejó en el chat. Pintarla como parte de la conversación haría creer
 * que al cliente se le dijo algo que nunca se le dijo. Va como "sistema", que es
 * como la pantalla ya distingue lo que no salió por WhatsApp.
 */
function ladoDe(m: MensajeCp): QuienEscribe {
  if (m.type === "in") return "cliente";
  if (m.type === "note") return "sistema";
  return "negocio";
}

function normalizarMensaje(m: MensajeCp): MensajeConversacion {
  const tipo = (m.msg_type || "text").toLowerCase();
  // ⛔ En un `wa_template`, `content` NO es lo que leyó el cliente: es el NOMBRE
  // de la plantilla ("ES seguimiento_guia_generada_v2_utilidad"). Medido el
  // 2-sep-2026. Pintarlo como texto le muestra a la asesora un código donde
  // debería ver un mensaje, y peor: parece que eso fue lo que se le dijo al
  // cliente. Se marca como marcador, igual que un adjunto.
  // ⛔ En un `wa_template`, `content` es el NOMBRE de la plantilla
  // ("ES seguimiento_guia_generada_v2_utilidad") — un código, no un mensaje.
  // Pero `payload.body` trae el texto YA ARMADO que el cliente leyó, con la
  // guía y el nombre puestos. Medido el 2-sep-2026. Se muestra ese: la asesora
  // necesita saber qué se le dijo al cliente, no cómo se llama la plantilla.
  const esPlantilla = tipo === "wa_template";
  const cuerpoPlantilla = esPlantilla ? String(m.payload?.body ?? "").trim() : "";
  const texto = esPlantilla ? cuerpoPlantilla : String(m.content ?? "").trim();
  const nombrePlantilla = esPlantilla && !cuerpoPlantilla ? String(m.content ?? "").trim() : "";
  const archivoUrl = m.payload?.url || null;
  // Chatea Pro transcribe las notas de voz solo. Se guarda tal cual: es la
  // diferencia entre leer la cola de un vistazo y tener que escuchar 14 audios.
  const transcripcion = String(m.payload?.transcribed_text ?? "").trim() || null;
  // Un adjunto sin texto no se inventa: queda marcado para que la pantalla lo
  // pinte como adjunto y no como algo que alguien escribió.
  const esMarcador = !texto && !!MARCADOR[tipo];
  const fechaMs = typeof m.ts === "number" ? m.ts * 1000 : null;
  // ⛔ Quién escribió. El orden IMPORTA y lo tenía al revés. Un mensaje que
  // manda una PERSONA (desde Guardian o desde el panel) vuelve con
  // `type:"agent"`, `agent_id:<id real>`, `username:"Fabián"` … **y
  // `sender_id:"bot"`**. Preguntando primero por `sender_id` se perdía el
  // nombre de la asesora y todo salía firmado "Bot" — que es exactamente la
  // pregunta que el dueño hizo desde el principio: ¿lo escribió el bot o una
  // persona? Medido con un envío real el 2-sep-2026.
  const autor = (m.agent_id ?? 0) > 0
    ? (m.username || "Asesor")
    : (m.sender_id === "bot" ? "Bot" : null);
  return {
    id: String(m.id ?? m.mid ?? `${fechaMs ?? 0}-${texto.slice(0, 12)}`),
    fechaMs,
    de: ladoDe(m),
    texto: texto || (esPlantilla && nombrePlantilla ? `📨 Plantilla: ${nombrePlantilla}` : "") || MARCADOR[tipo] || "",
    autor,
    tipo,
    esMarcador,
    archivoUrl,
    transcripcion,
  };
}

export interface HiloChateapro {
  mensajes: MensajeConversacion[];
  /** Instante del último mensaje DEL CLIENTE, para la ventana de 24 h. */
  ultimoEntranteMs: number | null;
}

export async function leerHilo(
  cfg: ChateaproConfig,
  userNs: string,
  limite = 100,
): Promise<HiloChateapro> {
  const r = await llamar<{ data?: MensajeCp[] }>(cfg, "GET", "/subscriber/chat-messages", {
    // `include_bot=1` es imprescindible: sin él la asesora ve su lado de la
    // conversación con huecos donde habló el bot, y contesta a ciegas.
    // `include_note=1` trae las notas internas del equipo, que se pintan como
    // "sistema" y no como algo que el cliente vio.
    query: { user_ns: userNs, include_bot: 1, include_note: 1, limit: Math.min(100, limite) },
  });
  const crudos = Array.isArray(r?.data) ? r.data : [];
  const mensajes = crudos.map(normalizarMensaje)
    .sort((a, b) => (a.fechaMs ?? 0) - (b.fechaMs ?? 0));
  let ultimoEntranteMs: number | null = null;
  for (const m of mensajes) {
    if (m.de === "cliente" && m.fechaMs != null) {
      if (ultimoEntranteMs == null || m.fechaMs > ultimoEntranteMs) ultimoEntranteMs = m.fechaMs;
    }
  }
  return { mensajes, ultimoEntranteMs };
}

// ── Escribir ────────────────────────────────────────────────────────────────

export async function enviarTexto(
  cfg: ChateaproConfig,
  userNs: string,
  texto: string,
  comoAsesor: boolean,
): Promise<void> {
  await llamar(cfg, "POST", "/subscriber/send-text", {
    body: {
      user_ns: userNs,
      content: texto,
      // `send_as_agent: 1` hace que el mensaje quede a nombre del asesor y no
      // del bot. Importa para la auditoría: en ImporChat no poder distinguir
      // quién escribió fue un problema real.
      send_as_agent: comoAsesor ? 1 : 0,
    },
  });
}

// ── Plantillas de Meta ──────────────────────────────────────────────────────

export interface PlantillaCp {
  name: string;
  language: string;
  category: string;
  components: unknown[];
}

export async function listarPlantillas(cfg: ChateaproConfig, limite = 100): Promise<PlantillaCp[]> {
  const r = await llamar<{ data?: PlantillaCp[] }>(cfg, "POST", "/whatsapp-template/list", {
    body: { limit: Math.min(100, limite) },
  });
  return Array.isArray(r?.data) ? r.data : [];
}

/**
 * Manda una plantilla aprobada por Meta. Es el ÚNICO camino cuando pasaron las
 * 24 h: el texto libre no se entrega y nadie se entera.
 */
export async function enviarPlantilla(
  cfg: ChateaproConfig,
  userNs: string,
  contenido: Record<string, unknown>,
): Promise<void> {
  await llamar(cfg, "POST", "/subscriber/send-whatsapp-template", {
    body: { user_ns: userNs, content: contenido },
  });
}

/** Indicativo por país, para armar el id de WhatsApp. */
const INDICATIVO: Record<string, string> = { CO: "57", EC: "593", GT: "502" };

/**
 * El id de WhatsApp de un teléfono: indicativo + número nacional, solo dígitos.
 * Verificado leyendo el `mid` de un mensaje real, que lleva el número así
 * (`573218877000`).
 */
export function idWhatsapp(telefono: string, countryCode: string): string {
  const d = String(telefono ?? "").replace(/\D/g, "");
  const ind = INDICATIVO[String(countryCode || "CO").toUpperCase()] ?? "57";
  if (d.startsWith(ind) && d.length > 10) return d;          // ya trae indicativo
  return ind + d.replace(/^0+/, "").slice(-10);              // nacional → con indicativo
}

/**
 * ⛔ LA PLANTILLA AL CLIENTE QUE NUNCA ESCRIBIÓ.
 *
 * Medido el 2-sep-2026: `send-whatsapp-template` exige un `user_ns`, o sea un
 * contacto que YA existe. Un cliente que compró y jamás escribió por WhatsApp
 * no es contacto, así que no se le podía mandar NADA desde Guardian — y son
 * exactamente los que hay que rescatar (el pedido de prueba llevaba 12 días
 * sin retirar en oficina, con la devolución casi segura).
 *
 * Esta ruta lo crea al vuelo (`create_if_not_found`), que es lo mismo que hace
 * el panel. Se usa SOLO como respaldo: si el contacto existe se manda por
 * `user_ns`, que además deja el mensaje en el hilo de siempre.
 */
export async function enviarPlantillaPorTelefono(
  cfg: ChateaproConfig,
  userId: string,
  contenido: Record<string, unknown>,
  nombre?: string,
): Promise<void> {
  await llamar(cfg, "POST", "/subscriber/send-whatsapp-template-by-user-id", {
    body: {
      user_id: userId,
      create_if_not_found: "yes",
      content: contenido,
      ...(nombre ? { contact: { name: nombre } } : {}),
    },
  });
}

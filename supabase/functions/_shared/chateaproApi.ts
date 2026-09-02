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
 * ⚠️ El buscador de Chatea Pro hace coincidencia por texto, no por los últimos
 * 9 dígitos: `+573001112233` y `3001112233` son el mismo cliente y pueden estar
 * guardados de cualquiera de las dos formas. Por eso se prueban las dos y se
 * confirma comparando los últimos 9 — un match flojo acá le muestra a la
 * asesora la conversación de OTRA persona, que es peor que no mostrar nada.
 */
export async function buscarSuscriptorPorTelefono(
  cfg: ChateaproConfig,
  telefono: string,
): Promise<Suscriptor | null> {
  const clave = last9(telefono);
  if (!clave) return null;

  const intentos = [String(telefono ?? "").trim(), clave].filter(Boolean);
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
}

interface MensajeCp {
  id?: string | number;
  mid?: string;
  type?: string;          // "in" = del cliente, "out" = nuestro
  msg_type?: string;      // text, image, audio, video, file
  text?: string;
  message?: string;
  url?: string;
  file_url?: string;
  timestamp?: number;     // unix segundos
  created_at?: string;
  agent_name?: string;
  from?: string;
}

const MARCADOR: Record<string, string> = {
  image: "🖼️ Imagen",
  audio: "🎤 Nota de voz",
  video: "🎬 Video",
  file: "📎 Archivo",
};

function normalizarMensaje(m: MensajeCp): MensajeConversacion {
  const tipo = (m.msg_type || "text").toLowerCase();
  const texto = (m.text ?? m.message ?? "").trim();
  const archivoUrl = m.url || m.file_url || null;
  // Un adjunto sin texto no se inventa: se marca como marcador para que la
  // pantalla lo pinte como adjunto y no como algo que alguien escribió.
  const esMarcador = !texto && !!MARCADOR[tipo];
  const fechaMs = typeof m.timestamp === "number"
    ? m.timestamp * 1000
    : (m.created_at ? Date.parse(m.created_at) : null);
  return {
    id: String(m.id ?? m.mid ?? `${fechaMs ?? 0}-${texto.slice(0, 12)}`),
    fechaMs: Number.isFinite(fechaMs as number) ? (fechaMs as number) : null,
    de: m.type === "in" ? "cliente" : "negocio",
    texto: texto || MARCADOR[tipo] || "",
    // El nombre del asesor cuando Chatea Pro lo trae. NUNCA se rellena con
    // "bot" por defecto: no saber quién escribió no es lo mismo que saber que
    // fue el bot (esa confusión ya costó una discusión en ImporChat).
    autor: m.agent_name || null,
    tipo,
    esMarcador,
    archivoUrl,
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

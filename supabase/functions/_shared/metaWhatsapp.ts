// metaWhatsapp — hablarle DIRECTO a WhatsApp (Meta Cloud API), sin ImporChat.
//
// ── Por qué existe ─────────────────────────────────────────────────────────
// Hasta el 25-ago-2026 Guardian mandaba por ImporChat, y eso nos ataba a TRES
// límites que no eran de WhatsApp sino del intermediario:
//   1. NO se podían mandar fotos / audios / videos (ImporChat pedía el token
//      de Meta para su propio endpoint de media, token que no teníamos).
//   2. Las plantillas con imagen quedaban bloqueadas.
//   3. La llave de sesión de ImporChat vence cada 7 días y apaga TODO.
//
// El dueño consiguió el **System User token de Meta** (permanente) de su socio,
// que es proveedor/BSP de Meta. Con ese token Guardian le habla DIRECTO a
// `graph.facebook.com/{version}/{phone_number_id}/messages`: texto, media y
// TODAS las plantillas, y sin la ventana de 24 h para las plantillas.
//
// ── Descubrimiento clave ───────────────────────────────────────────────────
// El payload de plantilla que ya arma `plantillasMeta.construirPayloadMeta` es
// EXACTAMENTE el formato oficial de Meta (`messaging_product/to/type/template`).
// ImporChat solo lo reenviaba. Así que el camino directo reutiliza esa pieza
// pura y probada tal cual — acá solo se agregan los builders de TEXTO y MEDIA,
// y el transporte HTTP a Meta.
//
// Puro y SIN imports por URL: `src/lib/metaWhatsapp.ts` lo re-exporta para
// probar los builders cruzando el límite (igual que telefonoWhatsapp /
// plantillasMeta / ventanaWhatsapp). El único efecto de red vive en las
// funciones `*Meta()`, que usan `fetch` global — no se importan en las pruebas.

/** Versión de la Graph API. Overridable por env por si Meta deprecia una. */
export const META_API_VERSION_DEFAULT = "v22.0";

/** Los tipos de media que Meta entrega por URL pública (`link`). */
export const TIPOS_MEDIA = ["image", "audio", "video", "document"] as const;
export type TipoMedia = (typeof TIPOS_MEDIA)[number];

const texto = (v: unknown) => String(v ?? "").trim();

/** La base de la Graph API para una versión dada. */
export function graphBase(version?: string | null): string {
  const v = texto(version) || META_API_VERSION_DEFAULT;
  return `https://graph.facebook.com/${v}`;
}

/**
 * El payload EXACTO para un mensaje de TEXTO libre.
 *
 * OJO: Meta solo ENTREGA texto libre dentro de las 24 h del último mensaje del
 * cliente (la "customer service window"). Fuera de eso Meta acepta el request
 * pero NO lo entrega — por eso quien llama tiene que chequear la ventana antes
 * (misma `ventanaWhatsapp` que ya usa el botón). Este builder no decide eso;
 * solo arma el cuerpo.
 *
 * `preview_url:true` deja que WhatsApp muestre la tarjeta de un link si el
 * texto trae uno — no cambia el texto, solo lo enriquece.
 */
export function payloadTexto(destino: string, cuerpo: string): Record<string, unknown> {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: texto(destino),
    type: "text",
    text: { preview_url: true, body: texto(cuerpo) },
  };
}

/**
 * El payload EXACTO para MEDIA por URL pública.
 *
 * Meta descarga el archivo desde `link` (tiene que ser accesible por Meta:
 * https, sin auth, o una signed URL viva). El caller sube el archivo a un lugar
 * público (Supabase Storage) y pasa la URL.
 *
 * Reglas de Meta que se respetan acá:
 *  - `audio` NO admite caption (Meta lo ignora / rechaza) → se omite siempre.
 *  - `document` admite `filename` para que el cliente vea un nombre legible.
 *  - `image`/`video` admiten caption (el texto que acompaña al archivo).
 */
export function payloadMedia(
  destino: string,
  tipo: TipoMedia,
  link: string,
  opts?: { caption?: string | null; filename?: string | null },
): Record<string, unknown> {
  const caption = texto(opts?.caption);
  const filename = texto(opts?.filename);
  const media: Record<string, unknown> = { link: texto(link) };
  if (tipo !== "audio" && caption) media.caption = caption;
  if (tipo === "document" && filename) media.filename = filename;
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: texto(destino),
    type: tipo,
    [tipo]: media,
  };
}

/** Resultado uniforme de cualquier llamada a Meta. */
export interface RespuestaMeta {
  ok: boolean;
  /** El id del mensaje que devuelve Meta al enviar (wamid). */
  wamid: string | null;
  /** Datos crudos (para verificar: nombre del número, plantillas, etc.). */
  datos: Record<string, unknown> | null;
  /** Motivo legible si falló. Vacío si ok. */
  detalle: string;
  /** El HTTP status crudo, para distinguir 401 (token) de 400 (payload). */
  status: number;
}

const TIMEOUT_MS = 25_000;

/** Traduce el error de Meta a algo que una persona pueda accionar. */
function motivoMeta(status: number, datos: Record<string, unknown> | null, texto: string): string {
  const err = (datos?.error ?? null) as Record<string, unknown> | null;
  const msg = err ? String(err.message ?? "") : "";
  if (status === 401 || /expired|invalid|OAuth|access token/i.test(msg)) {
    return "El token de Meta no sirve o venció. Revisá que esté completo en el secreto META_WA_TOKEN.";
  }
  if (status === 400 && /template|param/i.test(msg)) {
    return `Meta rechazó la plantilla: ${msg}`;
  }
  return msg || texto.slice(0, 200) || `HTTP ${status}`;
}

async function fetchMeta(
  url: string,
  init: RequestInit,
): Promise<RespuestaMeta> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    const cuerpo = await r.text();
    let datos: Record<string, unknown> | null = null;
    try { datos = JSON.parse(cuerpo); } catch { /* no era JSON */ }
    if (!r.ok) {
      return { ok: false, wamid: null, datos, detalle: motivoMeta(r.status, datos, cuerpo), status: r.status };
    }
    // Al enviar, Meta devuelve { messages: [{ id: "wamid...." }] }.
    const wamid = (() => {
      const m = datos?.messages;
      return Array.isArray(m) && m[0] && typeof m[0] === "object"
        ? texto((m[0] as Record<string, unknown>).id) || null
        : null;
    })();
    return { ok: true, wamid, datos, detalle: "", status: r.status };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false, wamid: null, datos: null, status: 0,
      detalle: msg.includes("abort") ? "Meta no contestó a tiempo" : msg,
    };
  } finally {
    clearTimeout(t);
  }
}

/** Manda un payload ya armado al número (POST /messages). */
export async function enviarMensajeMeta(args: {
  version?: string | null;
  token: string;
  phoneNumberId: string;
  payload: Record<string, unknown>;
}): Promise<RespuestaMeta> {
  const url = `${graphBase(args.version)}/${args.phoneNumberId}/messages`;
  return fetchMeta(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${args.token}` },
    body: JSON.stringify(args.payload),
  });
}

/** Lee los datos del número (para verificar el token, read-only). */
export async function leerNumeroMeta(args: {
  version?: string | null;
  token: string;
  phoneNumberId: string;
}): Promise<RespuestaMeta> {
  const campos = "verified_name,display_phone_number,quality_rating,code_verification_status";
  const url = `${graphBase(args.version)}/${args.phoneNumberId}?fields=${campos}`;
  return fetchMeta(url, { method: "GET", headers: { Authorization: `Bearer ${args.token}` } });
}

/** Lee las plantillas aprobadas de la WABA (read-only). Devuelve el array crudo
 *  que entiende `plantillasMeta.parsearPlantillas` — mismo formato que ImporChat
 *  reenviaba, porque ImporChat lo sacaba de acá. */
export async function leerPlantillasMeta(args: {
  version?: string | null;
  token: string;
  wabaId: string;
  limit?: number;
}): Promise<RespuestaMeta> {
  const url = `${graphBase(args.version)}/${args.wabaId}/message_templates?limit=${args.limit ?? 100}`;
  return fetchMeta(url, { method: "GET", headers: { Authorization: `Bearer ${args.token}` } });
}

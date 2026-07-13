// Capa de transporte WhatsApp AGNÓSTICA — el seam del Híbrido H2.
//
// "Rentar el caño, no el cerebro": el inbox + la IA viven en Guardian; el
// transporte (conexión a WhatsApp) lo provee un gateway QR MANEJADO. Hoy:
// Whapi.cloud (escaneable estilo WhatsApp Lite, ellos hostean la sesión, cero
// VPS). Si el número se banea o el volumen lo justifica, se swapea a Meta
// Cloud API implementando la MISMA interfaz — sin tocar wa-webhook/wa-send/
// wa-ai-responder ni las tablas.
//
// Las edge functions NUNCA hardcodean el token: lo leen de wa_channels
// (service role) o de un secreto de entorno.

export type WaProvider = "whapi" | "evolution" | "waha" | "cloud_api";

/** Atribución CTWA (Click-to-WhatsApp): cuando un cliente hace clic en un anuncio
 *  de Meta "enviar mensaje" y escribe al bot, el PRIMER mensaje trae el contexto del
 *  anuncio. Guardian tiene su PROPIO bot, así que captura esta atribución NATIVA (a
 *  diferencia de la competencia que depende de un tercero). `raw` guarda el objeto
 *  CRUDO del contexto para no perder nada ni depender de acertar los paths. */
export interface AdReferral {
  ctwaClid?: string; // click id de CTWA (el ancla de atribución)
  sourceId?: string; // id del anuncio / ad
  sourceUrl?: string; // url del anuncio
  sourceType?: string; // 'ad' | 'post' | ...
  headline?: string; // título del anuncio
  body?: string; // cuerpo/copy
  mediaType?: string;
  raw: Record<string, unknown>; // objeto CRUDO del contexto del anuncio
}

/** Mensaje entrante ya normalizado, agnóstico del proveedor. */
export interface WaInboundMessage {
  waMessageId: string;
  fromPhone: string; // solo dígitos, con código de país
  fromName?: string;
  type: string; // 'text' | 'image' | 'audio' | 'document' | ...
  body: string; // texto o caption ('' si no hay)
  media?: Record<string, unknown> | null;
  timestamp: number; // unix seconds
  fromMe: boolean; // true = eco de un saliente nuestro (se ignora como entrante)
  isGroup: boolean; // true = mensaje de un GRUPO/lista de difusión → el bot NO actúa ahí
  // true = el JID llegó como "@lid" (identificador de privacidad) SIN resolver al
  // teléfono real. onlyDigits(@lid) da dígitos basura (truthy) → crearía una
  // conversación FANTASMA y el bot le respondería a un número inexistente, perdiendo
  // EN SILENCIO al cliente que sí escribió. El webhook los omite y loguea (ver
  // auditoría 2026-06-26). Resolver LID→teléfono es trabajo aparte.
  isLid: boolean;
  // Atribución de anuncio (CTWA): presente SOLO en el primer mensaje de un cliente
  // que llegó por un anuncio "Click-to-WhatsApp" de Meta. null si no hay contexto de
  // anuncio (la mayoría de los mensajes). Ver AdReferral.
  adReferral?: AdReferral | null;
}

/** Log de debug: si detectamos atribución de anuncio, la mostramos (recortada) para
 *  poder validar la FORMA real con el primer clic de un anuncio y ajustar los paths. */
function logAdReferral(provider: WaProvider, ref: AdReferral | null): void {
  if (ref) {
    console.log("[wa-ctwa] adReferral detectado", provider, JSON.stringify(ref).slice(0, 600));
  }
}

export interface WaSendResult {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
  httpStatus?: number;
}

/** Binario de un media entrante, descargado del gateway (para transcribir/leer). */
export interface WaMediaBase64 {
  base64: string;
  mimetype?: string;
}

export interface WaTransport {
  readonly provider: WaProvider;
  /** Envía un texto a un teléfono (dígitos con código país). */
  sendText(to: string, body: string): Promise<WaSendResult>;
  /** Parsea el payload crudo del webhook del proveedor → mensajes normalizados. */
  parseInbound(payload: unknown): WaInboundMessage[];
  /** Descarga el binario de un media entrante (audio/imagen) por su messageId, para
   *  transcribirlo o leerlo. Opcional: no todos los proveedores lo implementan.
   *  Devuelve null si el proveedor no soporta o si la descarga falla. */
  fetchMediaBase64?(messageId: string): Promise<WaMediaBase64 | null>;
  /** Resuelve un JID "@lid" (identidad de privacidad de WhatsApp) al TELÉFONO real,
   *  si el proveedor expone el mapeo (WAHA: GET /api/{session}/lids/{id} → { pn }).
   *  Permite keyear la conversación por NÚMERO real → la IA busca el pedido en Dropi
   *  por teléfono como siempre. Devuelve dígitos del teléfono o null si no aplica. */
  resolveLidToPhone?(lidJid: string): Promise<string | null>;
  /** Descarga un media entrante por su URL (cuando el proveedor la incluye en el
   *  payload — WAHA: `media.url`, que apunta a un host interno). Reescribe el host al
   *  base público + auth. Opcional. Devuelve null en cualquier fallo. */
  fetchMediaByUrl?(url: string): Promise<WaMediaBase64 | null>;
}

/** ¿El JID crudo llegó como "@lid" (identificador de privacidad sin resolver)? */
export function isLidJid(jid: unknown): boolean {
  return /@lid\b/i.test(String(jid ?? ""));
}

export interface WaTransportConfig {
  token: string;
  base?: string;
  instanceName?: string;
}

/** Deja solo dígitos (quita +, espacios, guiones, @s.whatsapp.net, etc.). */
export function onlyDigits(s: unknown): string {
  return String(s ?? "").replace(/\D/g, "");
}

// ─── Whapi.cloud (gateway QR manejado, piloto) ────────────────────────────
//
// API: base https://gate.whapi.cloud, Bearer token por canal.
//   - Enviar:  POST /messages/text   { to, body }  → { sent, message:{ id } }
//   - Webhook: POST con { messages: [{ id, from, from_name, type, text:{body},
//              timestamp, from_me, ... }], channel_id, event:{...} }

const WHAPI_DEFAULT_BASE = "https://gate.whapi.cloud";

interface WhapiRawMessage {
  id?: string;
  from?: string;
  from_name?: string;
  from_me?: boolean;
  type?: string;
  timestamp?: number;
  chat_id?: string;
  text?: { body?: string };
  image?: { caption?: string; link?: string; id?: string };
  video?: { caption?: string; link?: string; id?: string };
  document?: { caption?: string; link?: string; filename?: string };
  audio?: { link?: string; id?: string };
  [k: string]: unknown;
}

function whapiBody(m: WhapiRawMessage): string {
  if (m.text?.body) return m.text.body;
  if (m.image?.caption) return m.image.caption;
  if (m.video?.caption) return m.video.caption;
  if (m.document?.caption) return m.document.caption;
  return "";
}

function whapiMedia(m: WhapiRawMessage): Record<string, unknown> | null {
  for (const k of ["image", "video", "document", "audio"] as const) {
    if (m[k]) return { kind: k, ...(m[k] as Record<string, unknown>) };
  }
  return null;
}

// Atribución CTWA en Whapi: expone el contexto del anuncio en `m.referral` (formato
// tipo Meta Cloud API) y/o en `m.context.referred_product`/`m.context.ad`. Extraemos
// lo que esté con nombres snake_case (Cloud API) o camelCase; null si no hay señal.
function whapiAdReferral(m: WhapiRawMessage): AdReferral | null {
  const ctx = (m.context ?? {}) as Record<string, unknown>;
  const ref = (m.referral ?? ctx.referral ?? ctx.ad ?? ctx.referred_product ?? null) as
    | Record<string, unknown>
    | null;
  if (!ref || typeof ref !== "object") return null;
  const g = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = ref[k];
      if (typeof v === "string" && v) return v;
    }
    return undefined;
  };
  const clid = g("ctwa_clid", "ctwaClid");
  const sourceId = g("source_id", "sourceId", "ad_id", "adId");
  const sourceUrl = g("source_url", "sourceUrl", "url");
  const headline = g("headline", "title");
  const bodyText = g("body", "description");
  // Sin ninguna señal de anuncio (ni clid, ni id, ni url) no es una atribución.
  if (!clid && !sourceId && !sourceUrl) return null;
  return {
    ctwaClid: clid,
    sourceId,
    sourceUrl,
    sourceType: g("source_type", "sourceType"),
    headline,
    body: bodyText,
    mediaType: g("media_type", "mediaType"),
    raw: ref,
  };
}

// Grupo o lista de difusión: en WhatsApp el JID del grupo termina en "@g.us" y
// el de status/broadcast en "@broadcast". El bot NO debe actuar ahí (el número
// tiene grupos internos de la empresa). Se detecta por chat_id o from.
function whapiIsGroup(m: WhapiRawMessage): boolean {
  const chat = String(m.chat_id ?? "");
  const from = String(m.from ?? "");
  return /@g\.us/i.test(chat) || /@g\.us/i.test(from) || /@broadcast/i.test(chat) || /@broadcast/i.test(from);
}

class WhapiTransport implements WaTransport {
  readonly provider: WaProvider = "whapi";
  private token: string;
  private base: string;

  constructor(cfg: WaTransportConfig) {
    this.token = cfg.token;
    this.base = (cfg.base || WHAPI_DEFAULT_BASE).replace(/\/+$/, "");
  }

  async sendText(to: string, body: string): Promise<WaSendResult> {
    const phone = onlyDigits(to);
    if (!phone) return { ok: false, error: "Teléfono inválido" };
    if (!this.token) return { ok: false, error: "Canal sin token configurado" };
    try {
      const res = await fetch(`${this.base}/messages/text`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ to: phone, body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          ok: false,
          httpStatus: res.status,
          error: (data as { error?: { message?: string } })?.error?.message ||
            `Gateway respondió ${res.status}`,
        };
      }
      const providerMessageId = (data as { message?: { id?: string }; id?: string })?.message?.id ||
        (data as { id?: string })?.id;
      return { ok: true, providerMessageId, httpStatus: res.status };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  parseInbound(payload: unknown): WaInboundMessage[] {
    const p = (payload ?? {}) as { messages?: WhapiRawMessage[] };
    // Cap defensivo: el webhook es público (solo gateado por secreto). Un payload
    // con un array enorme no debe poder reventar la función.
    const raw = (Array.isArray(p.messages) ? p.messages : []).slice(0, 200);
    return raw.map((m) => {
      const adReferral = whapiAdReferral(m);
      logAdReferral(this.provider, adReferral);
      return {
        waMessageId: String(m.id ?? ""),
        fromPhone: onlyDigits(m.from ?? m.chat_id ?? ""),
        fromName: m.from_name,
        type: String(m.type ?? "text"),
        body: whapiBody(m),
        media: whapiMedia(m),
        timestamp: Number(m.timestamp ?? 0),
        fromMe: Boolean(m.from_me),
        isGroup: whapiIsGroup(m),
        isLid: isLidJid(m.from ?? m.chat_id),
        adReferral,
      };
    }).filter((m) => m.waMessageId && m.fromPhone);
  }
}

// ─── Evolution API (gateway open-source self-host: "tu propio Whapi") ─────────
//
// API v2: base = URL del server propio (ej. https://bot.tudominio.com), auth con
// header `apikey` (API key global de Evolution), y se opera POR INSTANCIA (un
// número = una instancia). El QR se escanea en el Manager propio de Evolution.
//   - Enviar:  POST {base}/message/sendText/{instance}  { number, text } → { key:{ id } }
//   - Webhook: POST { event:"messages.upsert", instance, data:{ key:{ remoteJid, fromMe,
//              id }, pushName, message:{ conversation | extendedTextMessage:{text} |
//              imageMessage:{caption} | ... }, messageTimestamp } }  (data: objeto o array)

interface EvolutionRawMessage {
  key?: { remoteJid?: string; fromMe?: boolean; id?: string };
  pushName?: string;
  messageTimestamp?: number | string;
  messageType?: string;
  message?: {
    conversation?: string;
    extendedTextMessage?: { text?: string };
    imageMessage?: { caption?: string };
    videoMessage?: { caption?: string };
    documentMessage?: { caption?: string; fileName?: string };
    audioMessage?: Record<string, unknown>;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

function evoBody(m: EvolutionRawMessage): string {
  const msg = m.message || {};
  return msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    "";
}

function evoMedia(m: EvolutionRawMessage): Record<string, unknown> | null {
  const msg = m.message || {};
  for (const k of ["imageMessage", "videoMessage", "documentMessage", "audioMessage"] as const) {
    if (msg[k]) return { kind: k, ...(msg[k] as Record<string, unknown>) };
  }
  return null;
}

// Atribución CTWA en Evolution (Baileys — proveedor PRIMARIO): el contexto del anuncio
// llega en `message.extendedTextMessage.contextInfo.externalAdReply` con
// { title, body, sourceType, sourceId, sourceUrl, ctwaClid, mediaType } y/o
// `contextInfo.entryPointConversionSource === 'ctwa_ad'`. También revisamos el
// `contextInfo` a nivel raíz del mensaje por si el proveedor lo mueve ahí. Devuelve
// null si no hay señal de anuncio.
function evoAdReferral(m: EvolutionRawMessage): AdReferral | null {
  const msg = (m.message ?? {}) as Record<string, unknown>;
  // contextInfo puede colgar de varios sub-mensajes (extendedText, image, video...).
  const ext = (msg.extendedTextMessage ?? {}) as Record<string, unknown>;
  const img = (msg.imageMessage ?? {}) as Record<string, unknown>;
  const vid = (msg.videoMessage ?? {}) as Record<string, unknown>;
  const ctx = (ext.contextInfo ??
    img.contextInfo ??
    vid.contextInfo ??
    (m as { contextInfo?: unknown }).contextInfo ??
    null) as Record<string, unknown> | null;
  if (!ctx || typeof ctx !== "object") return null;

  const ear = (ctx.externalAdReply ?? null) as Record<string, unknown> | null;
  const entryPoint = String(ctx.entryPointConversionSource ?? "").toLowerCase();
  const isCtwa = entryPoint === "ctwa_ad";
  // Sin externalAdReply y sin marca ctwa_ad no hay atribución de anuncio.
  if (!ear && !isCtwa) return null;

  const src = (ear ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v ? v : undefined;
  const clid = str(src.ctwaClid) ?? str(ctx.ctwaClid) ??
    str((ctx as { conversionData?: { ctwaClid?: unknown } }).conversionData?.ctwaClid);

  const ref: AdReferral = {
    ctwaClid: clid,
    sourceId: str(src.sourceId),
    sourceUrl: str(src.sourceUrl),
    sourceType: str(src.sourceType),
    headline: str(src.title),
    body: str(src.body),
    mediaType: str(src.mediaType),
    // raw = el contextInfo completo (o el externalAdReply si no hay más): no perder nada.
    raw: (ctx ?? src) as Record<string, unknown>,
  };
  // Si NO hay externalAdReply pero sí la marca ctwa_ad, igual devolvemos la atribución
  // (aunque venga floja) para no perder el clic; raw preserva todo para diagnosticar.
  return ref;
}

// Grupo / difusión: el remoteJid de grupo termina en "@g.us" y el de status en
// "@broadcast". El bot NO debe actuar ahí (mismo criterio que Whapi).
function evoIsGroup(remoteJid: string): boolean {
  return /@g\.us/i.test(remoteJid) || /@broadcast/i.test(remoteJid);
}

class EvolutionTransport implements WaTransport {
  readonly provider: WaProvider = "evolution";
  private token: string;
  private base: string;
  private instance: string;

  constructor(cfg: WaTransportConfig) {
    this.token = cfg.token;
    this.base = (cfg.base || "").replace(/\/+$/, "");
    this.instance = cfg.instanceName || "";
  }

  async sendText(to: string, body: string): Promise<WaSendResult> {
    const phone = onlyDigits(to);
    if (!phone) return { ok: false, error: "Teléfono inválido" };
    if (!this.token) return { ok: false, error: "Canal sin token (apikey) configurado" };
    if (!this.base) return { ok: false, error: "Canal sin URL del server (provider_base)" };
    // Anti-SSRF: el provider_base lo escribe el dueño; exigimos https:// (el server
    // de Evolution va detrás de HTTPS) para no permitir apuntar a hosts internos/http.
    if (!/^https:\/\//i.test(this.base)) return { ok: false, error: "provider_base debe ser una URL https://" };
    if (!this.instance) return { ok: false, error: "Canal sin instancia (instance_name)" };
    try {
      const res = await fetch(`${this.base}/message/sendText/${encodeURIComponent(this.instance)}`, {
        method: "POST",
        headers: { apikey: this.token, "Content-Type": "application/json" },
        body: JSON.stringify({ number: phone, text: body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const d = data as { message?: unknown; error?: unknown; response?: { message?: unknown } };
        const msg = (typeof d?.message === "string" && d.message) ||
          (d?.response?.message && JSON.stringify(d.response.message)) ||
          (typeof d?.error === "string" && d.error) ||
          `Gateway respondió ${res.status}`;
        return { ok: false, httpStatus: res.status, error: String(msg).slice(0, 200) };
      }
      const providerMessageId = (data as { key?: { id?: string } })?.key?.id;
      return { ok: true, providerMessageId, httpStatus: res.status };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  parseInbound(payload: unknown): WaInboundMessage[] {
    const p = (payload ?? {}) as { event?: string; data?: EvolutionRawMessage | EvolutionRawMessage[] };
    // Solo mensajes nuevos. Si viene `event`, exigimos messages.upsert (Evolution
    // manda muchos otros eventos: messages.update, connection.update, etc.). Si no
    // viene, caemos a detección por forma (el filtro del webhook descarta vacíos).
    const ev = String(p.event ?? "").toLowerCase().replace(/_/g, ".");
    if (ev && ev !== "messages.upsert") return [];
    // Cap defensivo (webhook público): no procesar arrays gigantes.
    const raw = (Array.isArray(p.data) ? p.data : (p.data ? [p.data] : [])).slice(0, 200);
    return raw.map((m) => {
      const remoteJid = String(m.key?.remoteJid ?? "");
      const adReferral = evoAdReferral(m);
      logAdReferral(this.provider, adReferral);
      return {
        waMessageId: String(m.key?.id ?? ""),
        fromPhone: onlyDigits(remoteJid),
        fromName: m.pushName,
        type: String(m.messageType ?? "text"),
        body: evoBody(m),
        media: evoMedia(m),
        timestamp: Number(m.messageTimestamp ?? 0) || 0,
        fromMe: Boolean(m.key?.fromMe),
        isGroup: evoIsGroup(remoteJid),
        isLid: isLidJid(remoteJid),
        adReferral,
      };
    }).filter((m) => m.waMessageId && m.fromPhone);
  }

  /** Descarga + descifra el binario de un media entrante vía Evolution
   *  (`POST /chat/getBase64FromMediaMessage/{instance}`). Evolution tiene el mensaje
   *  en su store, así que basta el id de la key. Devuelve null en cualquier fallo
   *  (el caller cae a un marcador → el bot igual responde). */
  async fetchMediaBase64(messageId: string): Promise<WaMediaBase64 | null> {
    if (!messageId || !this.token || !this.base || !this.instance) return null;
    if (!/^https:\/\//i.test(this.base)) return null;
    try {
      const res = await fetch(
        `${this.base}/chat/getBase64FromMediaMessage/${encodeURIComponent(this.instance)}`,
        {
          method: "POST",
          headers: { apikey: this.token, "Content-Type": "application/json" },
          body: JSON.stringify({ message: { key: { id: messageId } }, convertToMp4: false }),
        },
      );
      if (!res.ok) return null;
      const data = await res.json().catch(() => null) as
        | { base64?: string; mimetype?: string; media?: { base64?: string; mimetype?: string } }
        | null;
      const base64 = data?.base64 || data?.media?.base64;
      if (!base64 || typeof base64 !== "string") return null;
      return { base64, mimetype: data?.mimetype || data?.media?.mimetype };
    } catch {
      return null;
    }
  }
}

// ─── WAHA (devlikeapro/waha — motor WEBJS = WhatsApp Web real en Chromium) ────
//
// Self-host como Evolution, pero corre el CLIENTE WhatsApp Web real (más tolerante
// que Baileys para envíos warm). base = URL del server propio detrás de HTTPS
// (ej. https://mi-server/waha), auth con header `X-Api-Key`, y se opera POR SESIÓN
// (instance_name = nombre de la sesión WAHA, ej. "default"). El QR se escanea en el
// dashboard de WAHA.
//   - Enviar:  POST {base}/api/sendText  { session, chatId:"<dígitos>@c.us", text }
//              → { id, _data:{ id:{ _serialized } } }   (¡chatId @c.us, NUNCA @lid crudo!)
//   - Webhook: POST { event:"message", session, payload:{ id, from, fromMe, to, body,
//              hasMedia, type, timestamp, _data:{ notifyName } } }  (evento "message" = entrante)
//
// LID (verificado en vivo 2026-06-27): para un contacto migrado a LID, el webhook
// entrega `from` = "<id>@lid" y el teléfono real queda OCULTO (no está en el payload
// ni en _data — es el punto de LID). WAHA (WhatsApp Web real) ENTREGA tanto a
// "<id>@lid" como a "<tel>@c.us" (ack=2 DEVICE, AMBOS verificados). Por eso:
// parseInbound keyea la conversación por el "<id>@lid" completo y sendText responde a
// ese JID tal cual. (El viejo comentario "el @lid crudo rompe el envío" era de
// Baileys/Evolution, NO de WAHA.)

const WAHA_DEFAULT_SESSION = "default";

interface WahaRawMessage {
  id?: string;
  timestamp?: number;
  from?: string;
  to?: string;
  fromMe?: boolean;
  body?: string;
  hasMedia?: boolean;
  type?: string;
  media?: Record<string, unknown> | null;
  notifyName?: string;
  participant?: string;
  _data?: { notifyName?: string; [k: string]: unknown };
  [k: string]: unknown;
}

function wahaName(m: WahaRawMessage): string | undefined {
  return m.notifyName || m._data?.notifyName || undefined;
}

// WAHA usa el `type` estilo whatsapp-web.js: 'chat' (texto), 'image', 'video',
// 'document', 'audio', 'ptt', 'location', ... Normalizamos 'chat' → 'text'.
// OJO (verificado 2026-06-27): WAHA NO siempre trae `type` a nivel raíz — la nota de
// voz lo trae SOLO en `_data.type` ("ptt"). Si falta o es 'chat', inferimos por el
// mimetype del media para no perder audios/imágenes (sin esto el audio caía a "text"
// y no se transcribía).
function wahaType(m: WahaRawMessage): string {
  const raw = String(m.type ?? (m._data as { type?: string } | undefined)?.type ?? "");
  if (raw && raw !== "chat") return raw;
  const mime = String((m.media as { mimetype?: string } | null | undefined)?.mimetype ?? "");
  if (/audio|ogg|opus/i.test(mime)) return "ptt";
  if (/image/i.test(mime)) return "image";
  if (/video/i.test(mime)) return "video";
  if (mime) return "document";
  return "text";
}

function wahaMedia(m: WahaRawMessage): Record<string, unknown> | null {
  if (m.hasMedia && m.media) return { kind: wahaType(m), ...(m.media as Record<string, unknown>) };
  return null;
}

// Atribución CTWA en WAHA (whatsapp-web.js): el ad reply puede venir en `_data`
// (ej. `_data.ctwaContext`, o campos snake/camelCase sueltos como `ctwa_clid` /
// `matchedText`). No inventamos: si no hay señal clara de anuncio devolvemos null,
// pero cuando SÍ la hay ponemos raw = `_data.ctwaContext` (o `_data`) para no perder
// nada y ajustar después con un clic real.
function wahaAdReferral(m: WahaRawMessage): AdReferral | null {
  const data = (m._data ?? {}) as Record<string, unknown>;
  const ctx = (data.ctwaContext ?? data.adReply ?? null) as Record<string, unknown> | null;
  // Fuente: el sub-objeto ctwaContext si existe, si no el propio _data (para pescar
  // campos sueltos tipo ctwa_clid en la raíz).
  const src = (ctx ?? data) as Record<string, unknown>;
  const g = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = src[k];
      if (typeof v === "string" && v) return v;
    }
    return undefined;
  };
  const clid = g("ctwa_clid", "ctwaClid");
  const sourceId = g("source_id", "sourceId", "ad_id", "adId");
  const sourceUrl = g("source_url", "sourceUrl", "url");
  const headline = g("title", "headline");
  const bodyText = g("body", "description", "matchedText");
  // Solo es atribución si hay clid, id o url. Sin ninguna señal → null (no inventar).
  if (!clid && !sourceId && !sourceUrl) return null;
  return {
    ctwaClid: clid,
    sourceId,
    sourceUrl,
    sourceType: g("source_type", "sourceType"),
    headline,
    body: bodyText,
    mediaType: g("media_type", "mediaType"),
    raw: (ctx ?? data) as Record<string, unknown>,
  };
}

// Grupo / difusión: el JID de grupo termina en "@g.us" y el de status en
// "@broadcast"; los grupos además traen `participant`. El bot NO actúa ahí.
function wahaIsGroup(m: WahaRawMessage): boolean {
  const from = String(m.from ?? "");
  const to = String(m.to ?? "");
  return /@g\.us/i.test(from) || /@broadcast/i.test(from) || /@g\.us/i.test(to) || Boolean(m.participant);
}

class WahaTransport implements WaTransport {
  readonly provider: WaProvider = "waha";
  private token: string;
  private base: string;
  private session: string;

  constructor(cfg: WaTransportConfig) {
    this.token = cfg.token;
    this.base = (cfg.base || "").replace(/\/+$/, "");
    this.session = cfg.instanceName || WAHA_DEFAULT_SESSION;
  }

  async sendText(to: string, body: string): Promise<WaSendResult> {
    const raw = String(to ?? "").trim();
    const phone = onlyDigits(raw);
    if (!phone) return { ok: false, error: "Teléfono inválido" };
    if (!this.token) return { ok: false, error: "Canal sin token (X-Api-Key) configurado" };
    if (!this.base) return { ok: false, error: "Canal sin URL del server (provider_base)" };
    // Anti-SSRF: el provider_base lo escribe el dueño; exigimos https:// (WAHA va
    // detrás de HTTPS) para no permitir apuntar a hosts internos/http.
    if (!/^https:\/\//i.test(this.base)) return { ok: false, error: "provider_base debe ser una URL https://" };
    // chatId: si `to` ya trae un JID (@lid o @c.us) se usa TAL CUAL — caso del contacto
    // migrado a LID, cuyo teléfono real está OCULTO: le respondemos a su "<id>@lid"
    // (WAHA lo entrega, verificado ack=2 DEVICE). Si son solo dígitos (contacto normal),
    // "<dígitos>@c.us" y WAHA resuelve el resto.
    const chatId = raw.includes("@") ? raw : `${phone}@c.us`;
    try {
      const res = await fetch(`${this.base}/api/sendText`, {
        method: "POST",
        headers: { "X-Api-Key": this.token, "Content-Type": "application/json" },
        body: JSON.stringify({ session: this.session, chatId, text: body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const d = data as { message?: unknown; error?: unknown };
        const msg = (typeof d?.message === "string" && d.message) ||
          (typeof d?.error === "string" && d.error) ||
          `Gateway respondió ${res.status}`;
        return { ok: false, httpStatus: res.status, error: String(msg).slice(0, 200) };
      }
      const d = data as { id?: string; _data?: { id?: { _serialized?: string } } };
      const providerMessageId = d?._data?.id?._serialized || (typeof d?.id === "string" ? d.id : undefined);
      return { ok: true, providerMessageId, httpStatus: res.status };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  parseInbound(payload: unknown): WaInboundMessage[] {
    const p = (payload ?? {}) as { event?: string; payload?: WahaRawMessage; data?: WahaRawMessage };
    // WAHA manda muchos eventos (session.status, message.ack, message.revoked, ...).
    // Solo nos interesan los entrantes: "message" (incoming). "message.any" incluye
    // también salientes → se acepta pero el `fromMe` lo filtra aguas abajo (igual
    // que Whapi/Evolution, que devuelven el eco y el webhook lo descarta).
    const ev = String(p.event ?? "").toLowerCase();
    if (ev && ev !== "message" && ev !== "message.any") return [];
    // El mensaje viene en `payload` (forma WAHA con wrapper); fallback a `data` o,
    // si llega el objeto crudo sin wrapper, al payload entero (detección por forma).
    const m = (p.payload || p.data || payload) as WahaRawMessage;
    if (!m || typeof m !== "object") return [];
    const from = String(m.from ?? "");
    const lid = isLidJid(from);
    const adReferral = wahaAdReferral(m);
    logAdReferral(this.provider, adReferral);
    const msg: WaInboundMessage = {
      waMessageId: String(m.id ?? ""),
      // Contacto LID (verificado 2026-06-27): el payload SOLO trae "<id>@lid" — el
      // teléfono real queda OCULTO por diseño de LID. WAHA entrega al @lid nativo,
      // así que keyeamos por el JID @lid COMPLETO y respondemos ahí (sendText lo usa
      // tal cual). Contacto normal → dígitos del "<teléfono>@c.us".
      fromPhone: lid ? from : onlyDigits(from),
      fromName: wahaName(m),
      type: wahaType(m),
      body: String(m.body ?? ""),
      media: wahaMedia(m),
      timestamp: Number(m.timestamp ?? 0) || 0,
      fromMe: Boolean(m.fromMe),
      isGroup: wahaIsGroup(m),
      // WAHA entrega al @lid → NO es un fantasma irresoluble: NO marcamos isLid, para
      // que wa-webhook NO lo descarte (a diferencia de Baileys/Evolution, que no
      // pueden responderle al @lid). La identidad @lid viaja en fromPhone.
      isLid: false,
      adReferral,
    };
    return [msg].filter((x) => x.waMessageId && x.fromPhone);
  }

  /** Descarga el binario de un media entrante vía WAHA
   *  (`GET /api/{session}/files?messageId=...` no es estable entre versiones; usamos
   *  `POST /api/{session}/messages/{id}` no — el camino fiable es pedir el media por id).
   *  WAHA CORE expone el media en el propio payload del webhook (downloadMedia) o por
   *  `GET {base}/api/{session}/auth`... Para mantenerlo simple y robusto entre versiones,
   *  intentamos el endpoint de descarga por id y devolvemos null si no aplica. */
  async fetchMediaBase64(messageId: string): Promise<WaMediaBase64 | null> {
    if (!messageId || !this.token || !this.base) return null;
    if (!/^https:\/\//i.test(this.base)) return null;
    try {
      const url = `${this.base}/api/${encodeURIComponent(this.session)}/messages/${encodeURIComponent(messageId)}/download`;
      const res = await fetch(url, { method: "POST", headers: { "X-Api-Key": this.token } });
      if (!res.ok) return null;
      const data = await res.json().catch(() => null) as
        | { data?: string; base64?: string; mimetype?: string }
        | null;
      const base64 = data?.base64 || data?.data;
      if (!base64 || typeof base64 !== "string") return null;
      return { base64, mimetype: data?.mimetype };
    } catch {
      return null;
    }
  }

  /** Resuelve "<id>@lid" → teléfono real vía WAHA (GET /api/{session}/lids/{id} →
   *  { lid, pn }). Devuelve los dígitos del teléfono (de `pn` = "<tel>@c.us") o null.
   *  Es lo que permite keyear la conversación de un cliente LID por su NÚMERO real y
   *  que la IA le encuentre el pedido en Dropi (verificado en vivo 2026-06-27). */
  async resolveLidToPhone(lidJid: string): Promise<string | null> {
    if (!this.token || !this.base) return null;
    if (!/^https:\/\//i.test(this.base)) return null;
    const lidUser = onlyDigits(lidJid);
    if (!lidUser) return null;
    try {
      const res = await fetch(
        `${this.base}/api/${encodeURIComponent(this.session)}/lids/${encodeURIComponent(lidUser)}`,
        { headers: { "X-Api-Key": this.token } },
      );
      if (!res.ok) return null;
      const data = await res.json().catch(() => null) as { pn?: string } | null;
      const phone = onlyDigits(data?.pn ?? "");
      return phone || null;
    } catch {
      return null;
    }
  }

  /** Descarga el binario de un media de WAHA desde su `media.url` (el payload la trae
   *  como host interno, ej. http://localhost:3000/api/files/...). Tomamos el PATH y lo
   *  colgamos del base público (Caddy /waha → :3000) + X-Api-Key → bytes → base64. Es
   *  el camino fiable: el POST /messages/{id}/download da 404 en esta versión (2026-06). */
  async fetchMediaByUrl(url: string): Promise<WaMediaBase64 | null> {
    if (!url || !this.token || !this.base) return null;
    if (!/^https:\/\//i.test(this.base)) return null;
    try {
      let path = url;
      try { path = new URL(url).pathname; } catch { /* ya es relativa */ }
      if (!path.startsWith("/")) path = `/${path}`;
      const res = await fetch(`${this.base}${path}`, { headers: { "X-Api-Key": this.token } });
      if (!res.ok) return null;
      const mimetype = res.headers.get("content-type") || undefined;
      const buf = new Uint8Array(await res.arrayBuffer());
      if (!buf.length || buf.length > 24 * 1024 * 1024) return null;
      let bin = "";
      for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
      return { base64: btoa(bin), mimetype };
    } catch {
      return null;
    }
  }
}

// ─── Factory ───────────────────────────────────────────────────────────────
// Whapi, Evolution y WAHA implementados. cloud_api queda como escape hatch
// documentado (implementa la MISMA interfaz cuando se necesite).
export function getWaTransport(provider: WaProvider, cfg: WaTransportConfig): WaTransport {
  switch (provider) {
    case "whapi":
      return new WhapiTransport(cfg);
    case "evolution":
      return new EvolutionTransport(cfg);
    case "waha":
      return new WahaTransport(cfg);
    case "cloud_api":
      throw new Error(
        `Transporte '${provider}' aún no implementado. Implementá WaTransport y agregalo al factory (escape hatch del Híbrido H2).`,
      );
    default:
      throw new Error(`Proveedor WhatsApp desconocido: ${provider}`);
  }
}

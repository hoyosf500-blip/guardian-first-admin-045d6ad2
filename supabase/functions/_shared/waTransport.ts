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

export type WaProvider = "whapi" | "evolution" | "cloud_api";

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
}

export interface WaSendResult {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
  httpStatus?: number;
}

export interface WaTransport {
  readonly provider: WaProvider;
  /** Envía un texto a un teléfono (dígitos con código país). */
  sendText(to: string, body: string): Promise<WaSendResult>;
  /** Parsea el payload crudo del webhook del proveedor → mensajes normalizados. */
  parseInbound(payload: unknown): WaInboundMessage[];
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
    return raw.map((m) => ({
      waMessageId: String(m.id ?? ""),
      fromPhone: onlyDigits(m.from ?? m.chat_id ?? ""),
      fromName: m.from_name,
      type: String(m.type ?? "text"),
      body: whapiBody(m),
      media: whapiMedia(m),
      timestamp: Number(m.timestamp ?? 0),
      fromMe: Boolean(m.from_me),
      isGroup: whapiIsGroup(m),
    })).filter((m) => m.waMessageId && m.fromPhone);
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
      };
    }).filter((m) => m.waMessageId && m.fromPhone);
  }
}

// ─── Factory ───────────────────────────────────────────────────────────────
// Whapi y Evolution implementados. cloud_api queda como escape hatch documentado
// (implementa la MISMA interfaz cuando se necesite).
export function getWaTransport(provider: WaProvider, cfg: WaTransportConfig): WaTransport {
  switch (provider) {
    case "whapi":
      return new WhapiTransport(cfg);
    case "evolution":
      return new EvolutionTransport(cfg);
    case "cloud_api":
      throw new Error(
        `Transporte '${provider}' aún no implementado. Implementá WaTransport y agregalo al factory (escape hatch del Híbrido H2).`,
      );
    default:
      throw new Error(`Proveedor WhatsApp desconocido: ${provider}`);
  }
}

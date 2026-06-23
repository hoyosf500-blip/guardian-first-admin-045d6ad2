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
    const raw = Array.isArray(p.messages) ? p.messages : [];
    return raw.map((m) => ({
      waMessageId: String(m.id ?? ""),
      fromPhone: onlyDigits(m.from ?? m.chat_id ?? ""),
      fromName: m.from_name,
      type: String(m.type ?? "text"),
      body: whapiBody(m),
      media: whapiMedia(m),
      timestamp: Number(m.timestamp ?? 0),
      fromMe: Boolean(m.from_me),
    })).filter((m) => m.waMessageId && m.fromPhone);
  }
}

// ─── Factory ───────────────────────────────────────────────────────────────
// Hoy solo Whapi está implementado. evolution / cloud_api son el escape hatch
// documentado: implementan la MISMA interfaz cuando se necesiten.
export function getWaTransport(provider: WaProvider, cfg: WaTransportConfig): WaTransport {
  switch (provider) {
    case "whapi":
      return new WhapiTransport(cfg);
    case "evolution":
    case "cloud_api":
      throw new Error(
        `Transporte '${provider}' aún no implementado. Implementá WaTransport y agregalo al factory (escape hatch del Híbrido H2).`,
      );
    default:
      throw new Error(`Proveedor WhatsApp desconocido: ${provider}`);
  }
}

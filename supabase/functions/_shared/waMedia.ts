// Helpers PUROS para clasificar media entrante de WhatsApp y generar un marcador
// legible cuando no hay transcripción/visión. Sin dependencias de Deno → testeables
// en Vitest. Los consume wa-webhook para enriquecer mensajes media-only (audio/foto
// sin texto) de modo que NUNCA se descarten ni dejen al bot en silencio.

/** Tipo de media normalizado de un mensaje entrante (kind del media o type). */
export function mediaKindOf(m: { type?: string; media?: Record<string, unknown> | null }): string {
  const fromMedia = m.media && typeof m.media === "object"
    ? String((m.media as { kind?: unknown }).kind ?? "")
    : "";
  return (fromMedia || String(m.type ?? "")).toLowerCase();
}

/** ¿Es una nota de voz / audio? (Evolution: 'audioMessage'; WAHA/WEBJS: 'audio'|'ptt'.) */
export function isAudioKind(kind: string): boolean {
  return /audio|ptt|voice/i.test(kind);
}

/** Marcador legible para un media sin texto (se guarda como body → lo ve la asesora
 *  en el inbox y le da al bot algo a qué responder, nunca silencio). */
export function mediaMarker(kind: string): string {
  if (isAudioKind(kind)) return "🎧 [nota de voz recibida]";
  if (/image/i.test(kind)) return "📷 [imagen recibida]";
  if (/video/i.test(kind)) return "🎬 [video recibido]";
  if (/document|file/i.test(kind)) return "📎 [archivo recibido]";
  if (/location/i.test(kind)) return "📍 [ubicación recibida]";
  if (/sticker/i.test(kind)) return "🩹 [sticker recibido]";
  return "[mensaje multimedia recibido]";
}

// Transcripción de notas de voz de WhatsApp a texto vía OpenAI Whisper.
//
// Por qué existe: Claude (el cerebro del bot, vía kie.ai) NO procesa audio. Cuando
// un cliente manda una nota de voz, wa-webhook descarga el binario del gateway
// (transport.fetchMediaBase64) y lo pasa por acá; el texto resultante se guarda como
// body del mensaje → la asesora lo LEE en el inbox y el bot razona sobre él como si
// el cliente lo hubiera escrito.
//
// Defensivo a propósito: devuelve null ante CUALQUIER fallo (sin key, audio raro,
// error de red, 4xx/5xx). El caller cae a un marcador "[nota de voz recibida]" y el
// bot igual responde — nunca silencio. Secreto: OPENAI_API_KEY. Modelo configurable
// con WA_STT_MODEL (default whisper-1).

const OPENAI_URL = "https://api.openai.com/v1/audio/transcriptions";
const MAX_BYTES = 24 * 1024 * 1024; // Whisper acepta hasta 25MB; una nota de voz pesa KB.

/** Decodifica base64 (con o sin prefijo data:) a bytes. */
function decodeBase64(b64: string): Uint8Array {
  const clean = b64.includes(",") ? b64.slice(b64.indexOf(",") + 1) : b64;
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Elige nombre de archivo + content-type según el mimetype del audio (WhatsApp manda
 *  OGG/Opus por defecto). Whisper se guía por la extensión del filename. */
function audioMeta(mimetype?: string): { blobType: string; filename: string } {
  const mt = (mimetype || "").toLowerCase();
  if (mt.includes("mp4") || mt.includes("m4a") || mt.includes("aac")) {
    return { blobType: "audio/mp4", filename: "audio.m4a" };
  }
  if (mt.includes("mpeg") || mt.includes("mp3")) return { blobType: "audio/mpeg", filename: "audio.mp3" };
  if (mt.includes("wav")) return { blobType: "audio/wav", filename: "audio.wav" };
  if (mt.includes("webm")) return { blobType: "audio/webm", filename: "audio.webm" };
  return { blobType: "audio/ogg", filename: "audio.ogg" }; // default WhatsApp (OGG/Opus)
}

/** Transcribe un audio (base64) a texto. null en cualquier fallo. */
export async function transcribeAudio(base64: string, mimetype?: string): Promise<string | null> {
  const key = Deno.env.get("OPENAI_API_KEY") || "";
  if (!key || !base64) return null;
  const model = Deno.env.get("WA_STT_MODEL") || "whisper-1";
  try {
    const bytes = decodeBase64(base64);
    if (!bytes.length || bytes.length > MAX_BYTES) return null;
    const { blobType, filename } = audioMeta(mimetype);
    const fd = new FormData();
    fd.append("file", new Blob([bytes], { type: blobType }), filename);
    fd.append("model", model);
    fd.append("language", "es"); // español → mejor precisión y latencia
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` }, // multipart: NO setear Content-Type a mano
      body: fd,
    });
    if (!res.ok) {
      console.error("[waTranscribe] OpenAI", res.status, (await res.text().catch(() => "")).slice(0, 200));
      return null;
    }
    const data = await res.json().catch(() => null) as { text?: string } | null;
    const text = data?.text;
    return typeof text === "string" && text.trim() ? text.trim() : null;
  } catch (e) {
    console.error("[waTranscribe] error", e instanceof Error ? e.message : String(e));
    return null;
  }
}

// Transcripción de notas de voz de WhatsApp a texto vía Groq Whisper
// (`whisper-large-v3-turbo`), endpoint compatible con OpenAI. Es el MISMO Whisper
// que usa ChatGPT, pero el tier gratis de Groq lo hace sin costo y muy rápido.
//
// POR QUÉ NO KIE (verificado en vivo 2026-06-27): kie.ai NO ofrece speech-to-text
// — su catálogo (134 modelos) es GENERACIÓN (imagen/video/música/voz-TTS/chat).
// El viejo `elevenlabs/speech-to-text` NO existía en kie → nunca pudo transcribir.
// Por eso esto va contra Groq con su propia key (`GROQ_API_KEY`), separada de la
// del bot (kie/Claude no procesan audio; transcribir es una capacidad aparte).
//
// Flujo (mucho más simple que el de kie: el endpoint Whisper recibe el binario
// directo, NO necesita URL pública ni subir a Storage ni poll de job async):
//   POST {base}/audio/transcriptions  (multipart/form-data)
//     file=<audio>  model=<whisper>  language=es  response_format=json
//   → 200 { text: "…" }
//
// Defensivo a propósito: devuelve null ante CUALQUIER fallo. El caller (wa-webhook)
// deja el marcador "🎧 [nota de voz recibida]" y el bot igual responde — nunca silencio.
//
// Config por env (todo opcional menos la key):
//   GROQ_API_KEY        → Bearer de Groq (crear gratis en console.groq.com). REQUERIDA.
//   WA_STT_MODEL        → default "whisper-large-v3-turbo" (multilingüe). Alt: "whisper-large-v3".
//   WA_STT_BASE         → default "https://api.groq.com/openai/v1" (endpoint OpenAI-compat).
//   WA_STT_LANGUAGE     → default "es".
//
// `sbAdmin`/`storeId`/`messageId` se conservan en la firma por compatibilidad con
// el caller (antes el flujo de kie los necesitaba para Storage); Groq no los usa.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

/** Decodifica base64 (con o sin prefijo data:) a bytes. */
function decodeBase64(b64: string): Uint8Array {
  const clean = b64.includes(",") ? b64.slice(b64.indexOf(",") + 1) : b64;
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Extensión + content-type según el mimetype (WhatsApp manda OGG/Opus por defecto). */
function audioMeta(mimetype?: string): { contentType: string; ext: string } {
  const mt = (mimetype || "").toLowerCase();
  if (mt.includes("mp4") || mt.includes("m4a") || mt.includes("aac")) return { contentType: "audio/mp4", ext: "m4a" };
  if (mt.includes("mpeg") || mt.includes("mp3")) return { contentType: "audio/mpeg", ext: "mp3" };
  if (mt.includes("wav")) return { contentType: "audio/wav", ext: "wav" };
  if (mt.includes("webm")) return { contentType: "audio/webm", ext: "webm" };
  return { contentType: "audio/ogg", ext: "ogg" }; // default WhatsApp (OGG/Opus)
}

/** Transcribe un audio (base64) a texto vía Groq Whisper. null en cualquier fallo. */
export async function transcribeAudio(opts: {
  sbAdmin?: SupabaseClient; // no usado por Groq (compat con el caller)
  storeId?: string; // idem
  messageId?: string; // idem (solo para logs)
  base64: string;
  mimetype?: string;
}): Promise<string | null> {
  const { base64, mimetype, messageId } = opts;
  const key = Deno.env.get("GROQ_API_KEY") || "";
  if (!key || !base64) return null;
  const base = (Deno.env.get("WA_STT_BASE") || "https://api.groq.com/openai/v1").replace(/\/+$/, "");
  const model = Deno.env.get("WA_STT_MODEL") || "whisper-large-v3-turbo";
  const language = Deno.env.get("WA_STT_LANGUAGE") || "es";

  try {
    const bytes = decodeBase64(base64);
    // Whisper acepta hasta ~25MB; una nota de voz son KB. Cota defensiva.
    if (!bytes.length || bytes.length > 24 * 1024 * 1024) return null;
    const { contentType, ext } = audioMeta(mimetype);

    const form = new FormData();
    form.append("file", new Blob([bytes], { type: contentType }), `audio.${ext}`);
    form.append("model", model);
    form.append("language", language);
    form.append("response_format", "json");
    form.append("temperature", "0");

    const res = await fetch(`${base}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` }, // multipart: NO setear Content-Type a mano
      body: form,
    });
    if (!res.ok) {
      console.error("[waTranscribe] groq", res.status, (await res.text().catch(() => "")).slice(0, 300), "msg", messageId);
      return null;
    }
    const data = await res.json().catch(() => null) as { text?: string } | null;
    const text = typeof data?.text === "string" ? data.text.trim() : "";
    return text.length >= 1 ? text : null;
  } catch (e) {
    console.error("[waTranscribe] error", e instanceof Error ? e.message : String(e));
    return null;
  }
}

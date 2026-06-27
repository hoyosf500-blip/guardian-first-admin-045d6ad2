// Transcripción de notas de voz de WhatsApp a texto vía kie.ai (modelo
// `elevenlabs/speech-to-text`), reutilizando la MISMA key de kie del bot
// (WA_AI_API_KEY) — sin key nueva ni proveedor extra. Claude NO procesa audio,
// por eso el STT aparte; kie.ai lo expone por su job API async.
//
// Flujo (kie.ai job API necesita el audio como URL pública, no base64):
//   1. Sube el binario a Supabase Storage (bucket `wa-audio`, auto-creado) → signed URL.
//   2. POST /api/v1/jobs/createTask { model, input: { <campo>: signedUrl, language_code } }.
//   3. Poll GET /api/v1/jobs/recordInfo?taskId= hasta state=success → texto del resultJson.
//   4. Borra el archivo temporal (best-effort).
//
// Defensivo a propósito: devuelve null ante CUALQUIER fallo. El caller (wa-webhook)
// deja el marcador "[nota de voz recibida]" y el bot igual responde — nunca silencio.
//
// Config por env (todo opcional, con defaults):
//   WA_AI_API_KEY / KIE_API_KEY  → Bearer de kie.ai (ya seteada para el bot)
//   WA_STT_MODEL                  → default "elevenlabs/speech-to-text"
//   WA_STT_INPUT_FIELD            → nombre del campo de audio en input (default "audio_url")
//   WA_KIE_BASE                   → default "https://api.kie.ai"

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const AUDIO_BUCKET = "wa-audio";
const POLL_INTERVAL_MS = 2500;
const POLL_MAX_ATTEMPTS = 24; // ~60s techo (una nota de voz se transcribe en segundos)

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sube el audio a Storage y devuelve { path, signedUrl } o null. Auto-crea el bucket. */
async function uploadAudio(
  sbAdmin: SupabaseClient,
  storeId: string,
  messageId: string,
  bytes: Uint8Array,
  contentType: string,
  ext: string,
): Promise<{ path: string; signedUrl: string } | null> {
  try {
    // Idempotente: si el bucket ya existe, el error se ignora.
    await sbAdmin.storage.createBucket(AUDIO_BUCKET, { public: false }).catch(() => {});
    const safeId = messageId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || `${Date.now()}`;
    const path = `${storeId}/${safeId}.${ext}`;
    const up = await sbAdmin.storage.from(AUDIO_BUCKET).upload(path, bytes, { contentType, upsert: true });
    if (up.error) { console.error("[waTranscribe] upload", up.error.message); return null; }
    const signed = await sbAdmin.storage.from(AUDIO_BUCKET).createSignedUrl(path, 600);
    const signedUrl = signed.data?.signedUrl;
    if (!signedUrl) { console.error("[waTranscribe] signedUrl vacío"); return null; }
    return { path, signedUrl };
  } catch (e) {
    console.error("[waTranscribe] uploadAudio", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** Busca el texto transcrito en una estructura de resultado desconocida (defensivo:
 *  el contrato exacto del modelo no está en los docs públicos de kie.ai). */
function extractText(obj: unknown, depth = 0): string | null {
  if (!obj || depth > 4) return null;
  if (typeof obj === "string") {
    const s = obj.trim();
    return s.length >= 1 ? s : null;
  }
  if (typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;
  // Campos típicos de STT primero.
  for (const k of ["text", "transcription", "transcript", "result_text"]) {
    if (typeof rec[k] === "string" && (rec[k] as string).trim()) return (rec[k] as string).trim();
  }
  // Anidados comunes.
  for (const k of ["resultObject", "result", "output", "data"]) {
    if (rec[k]) { const t = extractText(rec[k], depth + 1); if (t) return t; }
  }
  return null;
}

/** Transcribe un audio (base64) a texto vía kie.ai. null en cualquier fallo. */
export async function transcribeAudio(opts: {
  sbAdmin: SupabaseClient;
  storeId: string;
  messageId: string;
  base64: string;
  mimetype?: string;
}): Promise<string | null> {
  const { sbAdmin, storeId, messageId, base64, mimetype } = opts;
  const key = Deno.env.get("WA_AI_API_KEY") || Deno.env.get("KIE_API_KEY") || "";
  if (!key || !base64) return null;
  const base = (Deno.env.get("WA_KIE_BASE") || "https://api.kie.ai").replace(/\/+$/, "");
  const model = Deno.env.get("WA_STT_MODEL") || "elevenlabs/speech-to-text";
  const audioField = Deno.env.get("WA_STT_INPUT_FIELD") || "audio_url";

  let uploadedPath: string | null = null;
  try {
    const bytes = decodeBase64(base64);
    if (!bytes.length || bytes.length > 24 * 1024 * 1024) return null;
    const { contentType, ext } = audioMeta(mimetype);

    const up = await uploadAudio(sbAdmin, storeId, messageId, bytes, contentType, ext);
    if (!up) return null;
    uploadedPath = up.path;

    // 1) createTask
    const create = await fetch(`${base}/api/v1/jobs/createTask`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: { [audioField]: up.signedUrl, language_code: "es" } }),
    });
    if (!create.ok) {
      console.error("[waTranscribe] createTask", create.status, (await create.text().catch(() => "")).slice(0, 200));
      return null;
    }
    const created = await create.json().catch(() => null) as
      | { data?: { taskId?: string; task_id?: string }; taskId?: string }
      | null;
    const taskId = created?.data?.taskId || created?.data?.task_id || created?.taskId;
    if (!taskId) { console.error("[waTranscribe] sin taskId", JSON.stringify(created).slice(0, 200)); return null; }

    // 2) poll recordInfo
    for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
      await sleep(POLL_INTERVAL_MS);
      const poll = await fetch(`${base}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!poll.ok) continue;
      const info = await poll.json().catch(() => null) as
        | { data?: { state?: string; resultJson?: string; failMsg?: string } }
        | null;
      const state = String(info?.data?.state || "").toLowerCase();
      if (state === "fail") { console.error("[waTranscribe] job fail", info?.data?.failMsg); return null; }
      if (state === "success") {
        const rj = info?.data?.resultJson;
        let parsed: unknown = rj;
        if (typeof rj === "string") { try { parsed = JSON.parse(rj); } catch { parsed = rj; } }
        return extractText(parsed) || extractText(info?.data);
      }
      // waiting/queuing/generating → seguir esperando
    }
    console.error("[waTranscribe] timeout esperando el job");
    return null;
  } catch (e) {
    console.error("[waTranscribe] error", e instanceof Error ? e.message : String(e));
    return null;
  } finally {
    // Limpieza best-effort del audio temporal (no guardamos audio del cliente).
    if (uploadedPath) {
      sbAdmin.storage.from(AUDIO_BUCKET).remove([uploadedPath]).catch(() => {});
    }
  }
}

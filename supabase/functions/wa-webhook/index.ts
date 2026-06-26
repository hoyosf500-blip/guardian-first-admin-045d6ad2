// wa-webhook — ENTRANTE de WhatsApp (lo llama el gateway QR, ej. Whapi).
//
// Endpoint PÚBLICO (el gateway no manda JWT). Se protege con un secreto
// compartido (?secret= o header x-wa-secret) contra WA_WEBHOOK_SECRET, igual
// que el cron secret. El store_id viaja en el query (?store_id=) porque así se
// configura la URL del webhook por canal.
//
// Flujo: parsea entrantes → upsert conversación (por teléfono) → registra
// mensaje (idempotente por wa_message_id) → si el hilo tiene la IA activada en
// modo 'auto', dispara wa-ai-responder (fire-and-forget). Responde 200 rápido.
//
// NO escribe touchpoints en entrantes: touchpoints.operator_id es NOT NULL y un
// mensaje del cliente no tiene operador. El timeline lee wa_messages directo.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { loadWaChannel, recordInbound, upsertConversation } from "../_shared/waChannel.ts";
import { transcribeAudio } from "../_shared/waTranscribe.ts";
import { isAudioKind, mediaKindOf, mediaMarker } from "../_shared/waMedia.ts";

function json(body: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

async function triggerAiResponder(storeId: string, conversationId: string, triggerMessageId: string) {
  const fnUrl = `${Deno.env.get("SUPABASE_URL")!}/functions/v1/wa-ai-responder`;
  await fetch(fnUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!}`,
      "x-wa-internal": Deno.env.get("WA_WEBHOOK_SECRET") || "",
    },
    body: JSON.stringify({
      store_id: storeId,
      conversation_id: conversationId,
      trigger_message_id: triggerMessageId,
    }),
  });
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405, corsHeaders);

  const url = new URL(req.url);
  const storeId = url.searchParams.get("store_id") || "";
  const secret = url.searchParams.get("secret") || req.headers.get("x-wa-secret") || "";
  const expected = Deno.env.get("WA_WEBHOOK_SECRET") || "";

  if (!expected || secret !== expected) return json({ error: "unauthorized" }, 401, corsHeaders);
  if (!storeId) return json({ error: "missing store_id" }, 400, corsHeaders);

  const sbAdmin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const payload = await req.json().catch(() => ({}));
    const channel = await loadWaChannel(sbAdmin, storeId);
    const parsed = channel.transport.parseInbound(payload);

    // Mensajes @lid sin resolver: onlyDigits(@lid) da dígitos basura → crearían una
    // conversación fantasma y el bot respondería a un número inexistente, perdiendo
    // EN SILENCIO al cliente real (ver auditoría 2026-06-26). Se omiten y se loguea
    // para que sea VISIBLE si alguna vez empieza a pasar (no silencioso).
    const lidSkipped = parsed.filter((m) => !m.fromMe && !m.isGroup && m.isLid).length;
    if (lidSkipped) {
      console.warn(`wa-webhook: ${lidSkipped} mensaje(s) @lid sin resolver omitidos (store=${storeId}). Revisar resolución LID→teléfono.`);
    }

    // Ignoramos GRUPOS / difusión y @lid. Dejamos pasar media SIN texto (audio/foto):
    // antes el filtro `m.body` los descartaba y el bot quedaba MUDO ante una nota de voz.
    const inbound = parsed.filter((m) => !m.fromMe && !m.isGroup && !m.isLid && (m.body || m.media));

    const triggers: Array<{ conversationId: string; messageId: string }> = [];

    for (const m of inbound) {
      // Enriquecer media sin texto → nunca silencio: audio se TRANSCRIBE (OpenAI) y el
      // texto queda como body (la asesora lo lee, el bot razona sobre él); otros media
      // (foto/archivo/ubicación) reciben un marcador legible. Si la transcripción falla,
      // cae al marcador y el bot igual responde.
      let body = m.body;
      if (!body && m.media) {
        const kind = mediaKindOf(m);
        let transcript: string | null = null;
        if (isAudioKind(kind) && channel.transport.fetchMediaBase64) {
          const media = await channel.transport.fetchMediaBase64(m.waMessageId).catch(() => null);
          if (media?.base64) transcript = await transcribeAudio(media.base64, media.mimetype);
        }
        body = transcript ? `🎧 ${transcript}` : mediaMarker(kind);
      }

      const conv = await upsertConversation(sbAdmin, {
        storeId,
        channelId: channel.channelId,
        phone: m.fromPhone,
        name: m.fromName,
        // El bot arranca ACTIVO en automático para todo cliente que escribe (chat
        // individual). Solo aplica al CREAR la conversación: si una humana ya tomó
        // el control (handoff) o la apagó, ese estado se respeta (no se pisa).
        enableAiOnCreate: true,
      });
      const rec = await recordInbound(sbAdmin, {
        storeId,
        conversationId: conv.id,
        channelId: channel.channelId,
        waMessageId: m.waMessageId,
        body,
        media: m.media,
        providerTs: m.timestamp,
      });
      if (rec.inserted && conv.aiEnabled && conv.aiState === "auto" && rec.messageId) {
        triggers.push({ conversationId: conv.id, messageId: rec.messageId });
      }
    }

    // Dispara la IA sin bloquear la respuesta al gateway (waitUntil si existe).
    for (const t of triggers) {
      const p = triggerAiResponder(storeId, t.conversationId, t.messageId).catch((e) =>
        console.error("trigger ai-responder failed:", e)
      );
      const waitUntil = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } })
        .EdgeRuntime?.waitUntil;
      if (typeof waitUntil === "function") waitUntil(p);
      else await p;
    }

    return json({ ok: true, received: inbound.length, ai_triggered: triggers.length }, 200, corsHeaders);
  } catch (err) {
    console.error("wa-webhook error:", err);
    // 200 a propósito: si devolvemos error, el gateway reintenta en loop.
    return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 200, corsHeaders);
  }
});

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
import { loadWaChannel, recordAdAttribution, recordInbound, upsertConversation } from "../_shared/waChannel.ts";
import { transcribeAudio } from "../_shared/waTranscribe.ts";
import { isAudioKind, mediaKindOf, mediaMarker } from "../_shared/waMedia.ts";
import { isLidJid } from "../_shared/waTransport.ts";

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

    // Texto → trigger inmediato; audio → transcribir en BACKGROUND (el job de kie es
    // async, no debe colgar el webhook ni hacer reintentar al gateway).
    const triggers: Array<{ conversationId: string; messageId: string }> = [];
    const audioJobs: Array<{
      conversationId: string;
      messageId: string;
      waMessageId: string;
      mimetype?: string;
      mediaUrl?: string;
      aiAuto: boolean;
    }> = [];

    for (const m of inbound) {
      const kind = m.media ? mediaKindOf(m) : "";
      const isAudio = !m.body && m.media != null && isAudioKind(kind);
      // Body inicial: texto, o marcador legible para media (NUNCA vacío) → se persiste
      // YA (la asesora lo ve, idempotencia). Para audio, el marcador se reemplaza por
      // la transcripción en background.
      const initialBody = m.body || (m.media ? mediaMarker(kind) : "");

      // LID → teléfono real: si el remitente entró como "@lid" (privacidad) y el
      // proveedor expone el mapeo (WAHA: /lids/{id} → { pn }), resolvemos su teléfono
      // real para keyear la conversación por NÚMERO → la IA encuentra el pedido en
      // Dropi por teléfono, como siempre. Si no se resuelve, queda el @lid (igual
      // responde — WAHA entrega al @lid — pero sin lookup automático por teléfono).
      let phone = m.fromPhone;
      if (isLidJid(phone) && channel.transport.resolveLidToPhone) {
        const real = await channel.transport.resolveLidToPhone(phone).catch(() => null);
        if (real) phone = real;
      }

      const conv = await upsertConversation(sbAdmin, {
        storeId,
        channelId: channel.channelId,
        phone,
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
        body: initialBody,
        media: m.media,
        providerTs: m.timestamp,
      });
      if (!rec.inserted || !rec.messageId) continue;

      // Atribución pedido↔anuncio (CTWA): si el primer mensaje trae contexto de un
      // anuncio de Meta, lo guardamos YA (best-effort, no rompe el flujo del bot).
      if (m.adReferral) {
        await recordAdAttribution(sbAdmin, {
          storeId,
          conversationId: conv.id,
          phone,
          waMessageId: m.waMessageId,
          ad: m.adReferral,
        });
      }

      const aiAuto = conv.aiEnabled && conv.aiState === "auto";
      if (isAudio) {
        const mo = (m.media ?? null) as { mimetype?: unknown; url?: unknown } | null;
        const mt = mo && typeof mo.mimetype === "string" ? mo.mimetype : undefined;
        const mu = mo && typeof mo.url === "string" ? mo.url : undefined;
        audioJobs.push({ conversationId: conv.id, messageId: rec.messageId, waMessageId: m.waMessageId, mimetype: mt, mediaUrl: mu, aiAuto });
      } else if (aiAuto) {
        triggers.push({ conversationId: conv.id, messageId: rec.messageId });
      }
    }

    // Background (no bloquea la respuesta al gateway): (1) IA de los mensajes de texto;
    // (2) audios → transcribir (kie job async) → actualizar el body con el texto → recién
    // ahí disparar la IA (así razona sobre lo que DIJO el cliente, no sobre el marcador).
    const background = (async () => {
      for (const t of triggers) {
        await triggerAiResponder(storeId, t.conversationId, t.messageId)
          .catch((e) => console.error("trigger ai-responder failed:", e));
      }
      for (const job of audioJobs) {
        try {
          // Descarga del binario: WAHA expone el media por URL (media.url) — el camino
          // fiable; Evolution lo baja por messageId. Preferimos la URL si vino.
          const media = (job.mediaUrl && channel.transport.fetchMediaByUrl)
            ? await channel.transport.fetchMediaByUrl(job.mediaUrl).catch(() => null)
            : (channel.transport.fetchMediaBase64
              ? await channel.transport.fetchMediaBase64(job.waMessageId).catch(() => null)
              : null);
          const text = media?.base64
            ? await transcribeAudio({
              sbAdmin,
              storeId,
              messageId: job.waMessageId,
              base64: media.base64,
              mimetype: media.mimetype || job.mimetype,
            })
            : null;
          if (text) {
            const body = `🎧 ${text}`;
            await sbAdmin.from("wa_messages").update({ body }).eq("id", job.messageId);
            await sbAdmin.from("wa_conversations").update({ last_message_preview: body.slice(0, 200) }).eq("id", job.conversationId);
          }
        } catch (e) {
          console.error("wa-webhook transcribe failed:", e);
        }
        // Disparar la IA tras la transcripción (con o sin texto: nunca silencio).
        if (job.aiAuto) {
          await triggerAiResponder(storeId, job.conversationId, job.messageId)
            .catch((e) => console.error("trigger ai-responder (audio) failed:", e));
        }
      }
    })();

    const waitUntil = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } })
      .EdgeRuntime?.waitUntil;
    if (typeof waitUntil === "function") waitUntil(background);
    else await background;

    const aiTriggered = triggers.length + audioJobs.filter((j) => j.aiAuto).length;
    return json({ ok: true, received: inbound.length, ai_triggered: aiTriggered }, 200, corsHeaders);
  } catch (err) {
    console.error("wa-webhook error:", err);
    // 200 a propósito: si devolvemos error, el gateway reintenta en loop.
    return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 200, corsHeaders);
  }
});

// Helpers store-aware para las edge functions de WhatsApp.
//
// Centraliza: cargar el canal de una tienda (+ token + transporte), upsert de
// conversación por teléfono, registro idempotente de mensajes entrantes, y
// envío + registro de salientes. Mantiene wa-webhook / wa-send / wa-ai-responder
// finitas. Espejo conceptual de _shared/dropiStoreConfig.ts.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getWaTransport, onlyDigits, type WaProvider, type WaTransport } from "./waTransport.ts";

export interface LoadedWaChannel {
  channelId: string;
  storeId: string;
  provider: WaProvider;
  phoneNumber: string | null;
  transport: WaTransport;
}

/** Carga el canal más reciente de la tienda + arma el transporte.
 *  El token sale de wa_channels (service role) o, como fallback, del secreto
 *  de entorno WHAPI_TOKEN (cómodo durante el trial). Tira error claro si falta. */
export async function loadWaChannel(
  sbAdmin: SupabaseClient,
  storeId: string,
): Promise<LoadedWaChannel> {
  const { data, error } = await sbAdmin
    .from("wa_channels")
    .select("id, store_id, provider, phone_number, provider_token, provider_base")
    .eq("store_id", storeId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`No se pudo leer wa_channels: ${error.message}`);
  if (!data) throw new Error("La tienda no tiene canal de WhatsApp configurado.");

  const provider = String(data.provider || "whapi") as WaProvider;
  const token = String(data.provider_token || "") || Deno.env.get("WHAPI_TOKEN") || "";
  const transport = getWaTransport(provider, {
    token,
    base: data.provider_base || undefined,
  });

  return {
    channelId: String(data.id),
    storeId: String(data.store_id),
    provider,
    phoneNumber: data.phone_number ?? null,
    transport,
  };
}

/** Best-effort: linkea un teléfono a un pedido de la tienda (match por últimos
 *  8 dígitos, robusto a prefijos de país CO 57 / EC 593). Devuelve external_id
 *  o null. La IA igual re-consulta el estado real en tiempo de respuesta. */
export async function findLinkedExternalId(
  sbAdmin: SupabaseClient,
  storeId: string,
  phoneDigits: string,
): Promise<string | null> {
  const last8 = onlyDigits(phoneDigits).slice(-8);
  if (last8.length < 8) return null;
  const { data } = await sbAdmin
    .from("orders")
    .select("external_id")
    .eq("store_id", storeId)
    .ilike("phone", `%${last8}%`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.external_id ? String(data.external_id) : null;
}

/** Encuentra o crea la conversación de un teléfono dentro de una tienda. */
export async function upsertConversation(
  sbAdmin: SupabaseClient,
  args: {
    storeId: string;
    channelId: string;
    phone: string;
    name?: string | null;
    /** Si true y la conversación NO existe, se crea con la IA ACTIVA (ai_enabled=true,
     *  ai_state='auto'). Solo afecta el ALTA: una conversación existente conserva su
     *  estado (respeta handoff / apagado manual). Lo usa el webhook entrante para que
     *  el bot arranque solo con cada cliente nuevo. */
    enableAiOnCreate?: boolean;
  },
): Promise<{ id: string; aiEnabled: boolean; aiState: string }> {
  const { storeId, channelId, phone, name, enableAiOnCreate } = args;

  const existing = await sbAdmin
    .from("wa_conversations")
    .select("id, ai_enabled, ai_state")
    .eq("store_id", storeId)
    .eq("customer_phone", phone)
    .maybeSingle();

  if (existing.data) {
    return {
      id: String(existing.data.id),
      aiEnabled: Boolean(existing.data.ai_enabled),
      aiState: String(existing.data.ai_state),
    };
  }

  const linked = await findLinkedExternalId(sbAdmin, storeId, phone);
  const inserted = await sbAdmin
    .from("wa_conversations")
    .insert({
      store_id: storeId,
      channel_id: channelId,
      customer_phone: phone,
      customer_name: name ?? null,
      linked_external_id: linked,
      // Auto-ON al crear (solo si lo pide el caller, ej. webhook entrante). El
      // default de la tabla es OFF; los chats iniciados por operadora no lo pasan.
      ...(enableAiOnCreate ? { ai_enabled: true, ai_state: "auto" } : {}),
    })
    .select("id, ai_enabled, ai_state")
    .single();

  if (inserted.error) throw new Error(`No se pudo crear la conversación: ${inserted.error.message}`);
  return {
    id: String(inserted.data.id),
    aiEnabled: Boolean(inserted.data.ai_enabled),
    aiState: String(inserted.data.ai_state),
  };
}

/** Registra un mensaje ENTRANTE (idempotente por wa_message_id) y actualiza la
 *  conversación (last_message_at, preview, unread++, last_direction='in'). */
export async function recordInbound(
  sbAdmin: SupabaseClient,
  args: {
    storeId: string;
    conversationId: string;
    channelId: string;
    waMessageId: string;
    body: string;
    media?: Record<string, unknown> | null;
    providerTs?: number;
  },
): Promise<{ inserted: boolean; messageId?: string }> {
  const { storeId, conversationId, channelId, waMessageId, body, media, providerTs } = args;

  // Idempotencia: si ya existe el wa_message_id para la tienda, no dupliques.
  if (waMessageId) {
    const dup = await sbAdmin
      .from("wa_messages")
      .select("id")
      .eq("store_id", storeId)
      .eq("wa_message_id", waMessageId)
      .maybeSingle();
    if (dup.data) return { inserted: false };
  }

  const ins = await sbAdmin
    .from("wa_messages")
    .insert({
      store_id: storeId,
      conversation_id: conversationId,
      channel_id: channelId,
      wa_message_id: waMessageId || null,
      direction: "in",
      sender: "customer",
      body,
      media: media ?? null,
      status: "received",
      provider_ts: providerTs ? new Date(providerTs * 1000).toISOString() : null,
    })
    .select("id")
    .single();

  if (ins.error) throw new Error(`No se pudo registrar el mensaje entrante: ${ins.error.message}`);

  await bumpConversation(sbAdmin, conversationId, { preview: body, direction: "in", incUnread: true });

  return { inserted: true, messageId: String(ins.data.id) };
}

/** Envía un texto por el transporte y registra el mensaje SALIENTE + actualiza
 *  la conversación. Usado por wa-send (operadora) y wa-ai-responder (IA). */
export async function sendAndRecord(
  sbAdmin: SupabaseClient,
  channel: LoadedWaChannel,
  args: {
    conversationId: string;
    to: string;
    body: string;
    sender: "operator" | "ai" | "system";
    operatorId?: string | null;
  },
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const { conversationId, to, body, sender, operatorId } = args;

  const sent = await channel.transport.sendText(to, body);

  const ins = await sbAdmin
    .from("wa_messages")
    .insert({
      store_id: channel.storeId,
      conversation_id: conversationId,
      channel_id: channel.channelId,
      wa_message_id: sent.providerMessageId || null,
      direction: "out",
      sender,
      body,
      status: sent.ok ? "sent" : "failed",
      ai_generated: sender === "ai",
      operator_id: operatorId ?? null,
    })
    .select("id")
    .single();

  if (ins.error) {
    return { ok: false, error: `Envío ${sent.ok ? "ok" : "falló"} pero no se registró: ${ins.error.message}` };
  }

  await bumpConversation(sbAdmin, conversationId, { preview: body, direction: "out", incUnread: false });

  return sent.ok
    ? { ok: true, messageId: String(ins.data.id) }
    : { ok: false, messageId: String(ins.data.id), error: sent.error };
}

/** Actualiza los campos de "último mensaje" de la conversación. */
async function bumpConversation(
  sbAdmin: SupabaseClient,
  conversationId: string,
  args: { preview: string; direction: "in" | "out"; incUnread: boolean },
): Promise<void> {
  // unread_count se incrementa solo en entrantes. Para no leer-modificar-escribir
  // (race), en entrantes sumamos via expresión; supabase-js no soporta `+1`
  // directo, así que leemos el valor actual de forma barata.
  let unread: number | undefined;
  if (args.incUnread) {
    const cur = await sbAdmin
      .from("wa_conversations")
      .select("unread_count")
      .eq("id", conversationId)
      .maybeSingle();
    unread = Number(cur.data?.unread_count ?? 0) + 1;
  }
  const patch: Record<string, unknown> = {
    last_message_at: new Date().toISOString(),
    last_message_preview: args.preview.slice(0, 200),
    last_direction: args.direction,
    updated_at: new Date().toISOString(),
  };
  if (unread !== undefined) patch.unread_count = unread;
  await sbAdmin.from("wa_conversations").update(patch).eq("id", conversationId);
}

// wa-send — SALIENTE manual (operadora). La IA envía por su cuenta en
// wa-ai-responder; esta función es el botón "Enviar" del drawer en /seguimiento.
//
// Auth: JWT del operador. Valida membresía de la tienda (isStoreMember).
// Envía por el transporte del canal, registra el mensaje saliente, y escribe un
// touchpoint `WHATSAPP: ...` (el operador SÍ tiene operator_id) → alimenta el
// timeline y el chip "tu cola hoy".

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { isStoreMember } from "../_shared/dropiStoreConfig.ts";
import { loadWaChannel, sendAndRecord, upsertConversation } from "../_shared/waChannel.ts";
import { onlyDigits } from "../_shared/waTransport.ts";

function json(body: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405, corsHeaders);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) return json({ error: "No autorizado" }, 401, corsHeaders);

  const anon = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: { user } } = await anon.auth.getUser();
  if (!user) return json({ error: "Token inválido" }, 401, corsHeaders);

  let payload: { store_id?: string; conversation_id?: string; to?: string; body?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "JSON inválido" }, 400, corsHeaders);
  }

  const storeId = String(payload.store_id || "").trim();
  const text = String(payload.body || "").trim();
  if (!storeId || !text) return json({ error: "Faltan store_id o body" }, 400, corsHeaders);

  const sbAdmin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  if (!(await isStoreMember(sbAdmin, user.id, storeId))) {
    return json({ error: "No sos miembro de esta tienda" }, 403, corsHeaders);
  }

  try {
    const channel = await loadWaChannel(sbAdmin, storeId);

    // Resolver conversación + teléfono destino.
    let conversationId = String(payload.conversation_id || "").trim();
    let phone = onlyDigits(payload.to || "");

    if (conversationId) {
      const c = await sbAdmin
        .from("wa_conversations")
        .select("customer_phone")
        .eq("id", conversationId)
        .eq("store_id", storeId)
        .maybeSingle();
      if (!c.data) return json({ error: "Conversación no encontrada" }, 404, corsHeaders);
      phone = onlyDigits(c.data.customer_phone);
    } else {
      if (!phone) return json({ error: "Falta 'to' o 'conversation_id'" }, 400, corsHeaders);
      const conv = await upsertConversation(sbAdmin, {
        storeId,
        channelId: channel.channelId,
        phone,
      });
      conversationId = conv.id;
    }

    const result = await sendAndRecord(sbAdmin, channel, {
      conversationId,
      to: phone,
      body: text,
      sender: "operator",
      operatorId: user.id,
    });

    // Touchpoint para timeline + cobertura ("tu cola hoy"). Solo si se envió.
    if (result.ok) {
      await sbAdmin.from("touchpoints").insert({
        store_id: storeId,
        phone,
        operator_id: user.id,
        action: `WHATSAPP: ${text.slice(0, 120)}`,
      });
    }

    return json(result, result.ok ? 200 : 502, corsHeaders);
  } catch (err) {
    console.error("wa-send error:", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500, corsHeaders);
  }
});

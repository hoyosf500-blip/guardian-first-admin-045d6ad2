import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const DASHSCOPE_URL =
  "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions";
const MODEL = "qwen-turbo";

// ─── System prompts per action ────────────────────────────────────────

const SYSTEM_PROMPTS: Record<string, string> = {
  call_script: `Eres un asistente de confirmación de pedidos COD (contra-entrega) en Colombia.
Tu trabajo es generar un GUIÓN DE LLAMADA corto y natural para que la operadora confirme el pedido.

Reglas:
- Máximo 5 líneas. Directo, sin rodeos.
- Saludo personalizado con el nombre del cliente.
- Confirma: producto, dirección, ciudad, valor total (incluye flete).
- Si hay novedad: mencionar que hubo un problema y ofrecer solución.
- Si es cliente VIP: mencionar que es un buen cliente, agradecer su confianza.
- Si hay intentos previos sin respuesta: decir "intentamos comunicarnos antes".
- Termina con "¿Le confirmo el envío?"
- Responde SOLO con el guión, sin explicaciones ni encabezados.
- Idioma: español colombiano coloquial pero respetuoso.`,

  novedad_action: `Eres un experto en logística de última milla en Colombia (COD/contra-entrega).
Analiza la novedad del pedido y sugiere la MEJOR ACCIÓN CONCRETA.

Reglas:
- Máximo 3 líneas.
- Primera línea: acción recomendada (Reprogramar / Devolver / Contactar cliente / Esperar).
- Segunda línea: razón breve.
- Tercera línea: texto sugerido para la solución (si aplica reprogramar).
- Considera: días transcurridos, transportadora, tipo de novedad, valor del pedido.
- Si la novedad menciona dirección incorrecta → sugerir contactar cliente para corregir.
- Si la novedad menciona "cerrado" o "no se encontró" → sugerir reprogramar.
- Si lleva +5 días → considerar devolución para evitar cobros.
- Responde SOLO con la sugerencia, sin explicaciones adicionales.`,

  customer_profile: `Eres un analista de clientes para una operación de e-commerce COD en Colombia.
Genera un PERFIL CORTO del cliente basándote en su historial de pedidos.

Reglas:
- Máximo 4 líneas.
- Línea 1: tipo de cliente (VIP / Recurrente / Nuevo / Riesgoso) + emoji.
- Línea 2: patrón de compra (productos frecuentes, valor promedio, frecuencia).
- Línea 3: tasa de éxito y riesgo (% entregas vs devoluciones).
- Línea 4: recomendación para la operadora (confirmar rápido / verificar dirección / llamar con cuidado).
- Responde SOLO con el perfil, sin explicaciones.`,

  priority_reason: `Eres un sistema de triage de pedidos COD en Colombia.
Explica en UNA FRASE CORTA (máx 15 palabras) por qué este pedido tiene prioridad alta.
Menciona los factores más relevantes: días sin movimiento, novedad, valor, tipo de estado.
Responde SOLO con la frase, sin explicaciones.`,
};

// ─── Handler ──────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Read API key: try env var first, then app_settings table
    let apiKey = Deno.env.get("DASHSCOPE_API_KEY") || "";

    if (!apiKey) {
      const sbUrl = Deno.env.get("SUPABASE_URL")!;
      const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const sb = createClient(sbUrl, sbKey);
      const { data: setting } = await sb
        .from("app_settings")
        .select("value")
        .eq("key", "dashscope_api_key")
        .maybeSingle();
      apiKey = setting?.value || "";
    }

    if (!apiKey) {
      return new Response(
        JSON.stringify({ ok: false, error: "DASHSCOPE_API_KEY not configured. Set it in app_settings or as an Edge Function secret." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const body = await req.json();
    const { action, context } = body as {
      action: string;
      context: string;
    };

    const systemPrompt = SYSTEM_PROMPTS[action];
    if (!systemPrompt) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: `Unknown action: ${action}. Valid: ${Object.keys(SYSTEM_PROMPTS).join(", ")}`,
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (!context || typeof context !== "string") {
      return new Response(
        JSON.stringify({ ok: false, error: "Missing context string" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Call DashScope (OpenAI-compatible)
    const aiRes = await fetch(DASHSCOPE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: context.slice(0, 3000) }, // cap input
        ],
        temperature: 0.3,
        max_tokens: 400,
        stream: false,
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      console.error("DashScope error:", aiRes.status, errText);
      return new Response(
        JSON.stringify({
          ok: false,
          error: `AI service error (${aiRes.status})`,
        }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const aiData = await aiRes.json();
    const reply = aiData?.choices?.[0]?.message?.content || "";
    const usage = aiData?.usage || {};

    return new Response(
      JSON.stringify({
        ok: true,
        reply: reply.trim(),
        usage: {
          prompt_tokens: usage.prompt_tokens || 0,
          completion_tokens: usage.completion_tokens || 0,
        },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("ai-order-assistant error:", msg);
    return new Response(
      JSON.stringify({ ok: false, error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

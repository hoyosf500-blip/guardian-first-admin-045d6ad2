import { useState, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';

type AiAction = 'call_script' | 'novedad_action' | 'customer_profile' | 'priority_reason';

interface AiResult {
  reply: string;
  loading: boolean;
  error: string | null;
}

const DASHSCOPE_URL =
  'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions';

const SYSTEM_PROMPTS: Record<AiAction, string> = {
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
- Línea 1: tipo de cliente (VIP / Recurrente / Nuevo / Riesgoso) con emoji.
- Línea 2: patrón de compra (productos frecuentes, valor promedio, frecuencia).
- Línea 3: tasa de éxito y riesgo (% entregas vs devoluciones).
- Línea 4: recomendación para la operadora (confirmar rápido / verificar dirección / llamar con cuidado).
- Responde SOLO con el perfil, sin explicaciones.`,

  priority_reason: `Eres un sistema de triage de pedidos COD en Colombia.
Explica en UNA FRASE CORTA (máx 15 palabras) por qué este pedido tiene prioridad alta.
Menciona los factores más relevantes: días sin movimiento, novedad, valor, tipo de estado.
Responde SOLO con la frase, sin explicaciones.`,
};

/** Cached API key — loaded once from app_settings. */
let cachedApiKey: string | null = null;

async function getApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;
  const { data } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'dashscope_api_key')
    .maybeSingle();
  cachedApiKey = data?.value || '';
  return cachedApiKey;
}

/**
 * Hook for AI insights powered by DashScope/Qwen.
 *
 * Calls the API directly from the browser using the key stored in
 * app_settings. Caches results by a caller-supplied key so repeated
 * renders don't re-call the AI for the same order.
 */
export function useAiInsight() {
  const [results, setResults] = useState<Record<string, AiResult>>({});
  const inflightRef = useRef(new Set<string>());

  const ask = useCallback(async (
    key: string,
    action: AiAction,
    context: string,
  ) => {
    if (results[key]?.reply || inflightRef.current.has(key)) return;

    inflightRef.current.add(key);
    setResults(prev => ({
      ...prev,
      [key]: { reply: '', loading: true, error: null },
    }));

    try {
      const apiKey = await getApiKey();
      if (!apiKey) {
        setResults(prev => ({
          ...prev,
          [key]: { reply: '', loading: false, error: 'Clave IA no configurada. Ve a Admin → Clave API de IA.' },
        }));
        inflightRef.current.delete(key);
        return;
      }

      const res = await fetch(DASHSCOPE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'qwen-turbo',
          messages: [
            { role: 'system', content: SYSTEM_PROMPTS[action] },
            { role: 'user', content: context.slice(0, 3000) },
          ],
          temperature: 0.3,
          max_tokens: 400,
          stream: false,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        setResults(prev => ({
          ...prev,
          [key]: { reply: '', loading: false, error: `Error IA (${res.status}): ${errText.slice(0, 100)}` },
        }));
        inflightRef.current.delete(key);
        return;
      }

      const data = await res.json();
      const reply = data?.choices?.[0]?.message?.content || '';

      setResults(prev => ({
        ...prev,
        [key]: { reply: reply.trim(), loading: false, error: null },
      }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setResults(prev => ({
        ...prev,
        [key]: { reply: '', loading: false, error: msg },
      }));
    } finally {
      inflightRef.current.delete(key);
    }
  }, [results]);

  const get = useCallback((key: string): AiResult => {
    return results[key] || { reply: '', loading: false, error: null };
  }, [results]);

  return { ask, get };
}

import { useState, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';

type AiAction = 'call_script' | 'novedad_action' | 'customer_profile' | 'priority_reason';

interface AiResult {
  reply: string;
  loading: boolean;
  error: string | null;
}

/**
 * Hook for AI insights — calls the `ai-order-assistant` edge function.
 * Fix 3: la clave DashScope ya NO se lee en el browser ni se llama directo a
 * dashscope-intl.aliyuncs.com. Toda la lógica del prompt y la key vive en
 * la edge function (autenticada por JWT).
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
      const { data, error } = await supabase.functions.invoke('ai-order-assistant', {
        body: { action, context: context.slice(0, 3000) },
      });

      if (error) {
        setResults(prev => ({
          ...prev,
          [key]: { reply: '', loading: false, error: error.message || 'Error IA' },
        }));
        return;
      }

      const payload = data as { ok?: boolean; reply?: string; error?: string } | null;
      if (!payload?.ok) {
        setResults(prev => ({
          ...prev,
          [key]: { reply: '', loading: false, error: payload?.error || 'Error IA' },
        }));
        return;
      }

      setResults(prev => ({
        ...prev,
        [key]: { reply: (payload.reply || '').trim(), loading: false, error: null },
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

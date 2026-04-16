import { useState, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';

type AiAction = 'call_script' | 'novedad_action' | 'customer_profile' | 'priority_reason';

interface AiResult {
  reply: string;
  loading: boolean;
  error: string | null;
}

/**
 * Hook for calling the ai-order-assistant Edge Function.
 *
 * Caches results by a caller-supplied key so repeated renders
 * don't re-call the AI for the same order.
 */
export function useAiInsight() {
  const [results, setResults] = useState<Record<string, AiResult>>({});
  const inflightRef = useRef(new Set<string>());

  const ask = useCallback(async (
    key: string,
    action: AiAction,
    context: string,
  ) => {
    // Already cached or in-flight
    if (results[key]?.reply || inflightRef.current.has(key)) return;

    inflightRef.current.add(key);
    setResults(prev => ({
      ...prev,
      [key]: { reply: '', loading: true, error: null },
    }));

    try {
      const { data, error } = await supabase.functions.invoke('ai-order-assistant', {
        body: { action, context },
      });

      const payload = data as { ok?: boolean; reply?: string; error?: string } | null;

      if (error || !payload?.ok) {
        const msg = error?.message || payload?.error || 'Error desconocido';
        setResults(prev => ({
          ...prev,
          [key]: { reply: '', loading: false, error: msg },
        }));
      } else {
        setResults(prev => ({
          ...prev,
          [key]: { reply: payload.reply || '', loading: false, error: null },
        }));
      }
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

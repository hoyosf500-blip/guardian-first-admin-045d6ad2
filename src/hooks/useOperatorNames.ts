import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';

/**
 * Resolución reutilizable operator_id → nombre (profiles.display_name).
 * Antes cada consumidor (NotesPanel, timeline, etc.) re-consultaba `profiles` y
 * armaba su propio map. Acá un cache módulo-level trae la tabla UNA vez por sesión
 * (profiles cambia raramente) y todos los consumidores comparten el resultado.
 */
let namesCache: Record<string, string> | null = null;
let inflight: Promise<Record<string, string>> | null = null;

async function loadNames(): Promise<Record<string, string>> {
  if (namesCache) return namesCache;
  // El builder de supabase es PromiseLike (no Promise real) → envolver en async
  // IIFE para que `inflight` sea un Promise con .catch/.finally (gotcha conocido).
  if (!inflight) {
    inflight = (async () => {
      const { data } = await supabase.from('profiles').select('user_id, display_name');
      const m: Record<string, string> = {};
      (data || []).forEach((p: { user_id: string; display_name: string }) => {
        if (p.user_id) m[p.user_id] = p.display_name || 'Asesora';
      });
      namesCache = m;
      return m;
    })();
  }
  return inflight;
}

export function useOperatorNames() {
  const [names, setNames] = useState<Record<string, string>>(namesCache || {});

  useEffect(() => {
    let on = true;
    void loadNames().then((m) => { if (on) setNames(m); });
    return () => { on = false; };
  }, []);

  const nameOf = useCallback(
    (id?: string | null): string => (id && names[id]) || 'Asesora',
    [names],
  );

  return { nameOf };
}

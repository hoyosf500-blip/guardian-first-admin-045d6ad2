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
      const { data, error } = await supabase.from('profiles').select('user_id, display_name');
      const m: Record<string, string> = {};
      (data || []).forEach((p: { user_id: string; display_name: string }) => {
        if (p.user_id) m[p.user_id] = p.display_name || 'Asesora';
      });
      // ⛔ Un fallo NO se cachea (4-sep-2026). Antes un timeout en el primer
      // render dejaba `{}` guardado para toda la sesión: todas las asesoras
      // salían como "Asesora" en todas las pantallas —el sello de "quién tocó
      // este cliente" dejaba de identificar a nadie— hasta F5. Ahora el próximo
      // consumidor vuelve a intentar.
      if (error) {
        console.warn('[useOperatorNames] no se pudieron leer los nombres:', error.message);
        inflight = null;
        return m;
      }
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

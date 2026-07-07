import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';

// Trae los external_ids con INCIDENCIA ABIERTA en Dropi (edge
// dropi-open-incidences — la misma consulta del panel de novedades de Dropi).
// `openIds === null` = "no disponible" (edge caída, función sin deployar,
// sesión Dropi vencida): el consumidor NO separa la cola y todo sigue como
// antes. Nunca lanza ni muestra toasts — es un enriquecimiento opcional.
//
// Frescura: las novedades NUEVAS llegan al CRM vía dropi-cron (cada 5 min),
// así que refrescamos este set con la misma cadencia (poll 5 min) y además
// cuando el consumidor detecta que cambió la composición de su cola
// (reloadOpen respeta un mínimo de 60s para no martillar a Dropi — la cuenta
// EC throttlea, ver ec_dropi_throttle_cascade). Cache módulo-level por tienda
// para que ir y volver de la pestaña no dispare un fetch (ni un auto-login)
// por cada montaje.

interface OpenIncidencesResp {
  ok?: boolean;
  ids?: (string | number)[];
  error?: string;
}

const MIN_REFRESH_MS = 60 * 1000;
const POLL_MS = 5 * 60 * 1000;

// Cache por tienda compartido entre montajes (mismo patrón módulo-level que
// setTrackingCountry / los overrides del validador de direcciones).
const cache = new Map<string, { ids: Set<string> | null; at: number }>();

export function useOpenIncidences(storeId: string | null) {
  const cached = storeId ? cache.get(storeId) : undefined;
  const [openIds, setOpenIds] = useState<Set<string> | null>(cached?.ids ?? null);
  const [openLoading, setOpenLoading] = useState(false);
  // Evita aplicar una respuesta vieja si el usuario cambió de tienda a mitad
  // del fetch (mismo patrón que las demás cargas store-scoped).
  const reqSeq = useRef(0);
  const inFlight = useRef(false);

  const reloadOpen = useCallback(async (force = false) => {
    if (!storeId || inFlight.current) return;
    const prev = cache.get(storeId);
    if (!force && prev && Date.now() - prev.at < MIN_REFRESH_MS) {
      setOpenIds(prev.ids);
      return;
    }
    const seq = ++reqSeq.current;
    inFlight.current = true;
    setOpenLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('dropi-open-incidences', {
        body: { store_id: storeId },
      });
      const d = (data as OpenIncidencesResp | null) ?? null;
      const ids = !error && d?.ok && Array.isArray(d.ids)
        ? new Set(d.ids.map(String))
        : null;
      cache.set(storeId, { ids, at: Date.now() });
      if (seq === reqSeq.current) setOpenIds(ids);
    } catch {
      cache.set(storeId, { ids: null, at: Date.now() });
      if (seq === reqSeq.current) setOpenIds(null);
    } finally {
      inFlight.current = false;
      if (seq === reqSeq.current) setOpenLoading(false);
    }
  }, [storeId]);

  useEffect(() => {
    const fresh = storeId ? cache.get(storeId) : undefined;
    setOpenIds(fresh?.ids ?? null);
    void reloadOpen();
    const t = setInterval(() => { void reloadOpen(true); }, POLL_MS);
    return () => clearInterval(t);
  }, [reloadOpen, storeId]);

  return { openIds, openLoading, reloadOpen };
}

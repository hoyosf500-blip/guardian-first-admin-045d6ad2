import { pollWhenVisible } from '@/lib/pollWhenVisible';
import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';

/**
 * Lightweight change-detection hook (F6).
 *
 * Polls order counts by key estado groups every 2 minutes.  When a count
 * increases vs. the "last seen" snapshot the operator took (by visiting the
 * corresponding tab), the delta is surfaced as a badge number.
 *
 * No new tables, no audit_log dependency — just simple count queries.
 */

interface TabBadges {
  seguimiento: number;
  rescate: number;
}

// Clave POR TIENDA: con la clave global, al cambiar de tienda se restaba el
// baseline de la tienda A contra los conteos de la B → badges fantasma.
const sessionKey = (storeId: string) => `changeAlerts:lastSeen:${storeId}`;

interface LastSeen {
  novedades: number;
  devoluciones: number;
  oficina: number;
}

const ZERO: LastSeen = { novedades: 0, devoluciones: 0, oficina: 0 };

function loadLastSeen(storeId: string): LastSeen {
  try {
    const raw = sessionStorage.getItem(sessionKey(storeId));
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { ...ZERO };
}

function saveLastSeen(storeId: string, s: LastSeen) {
  sessionStorage.setItem(sessionKey(storeId), JSON.stringify(s));
}

export function useChangeAlerts(userId: string | undefined, storeId?: string | null) {
  const [badges, setBadges] = useState<TabBadges>({ seguimiento: 0, rescate: 0 });
  const [banner, setBanner] = useState<string | null>(null);
  const lastSeen = useRef<LastSeen>({ ...ZERO });
  const current = useRef<LastSeen>({ ...ZERO });
  const initialised = useRef(false);

  // Al cambiar de tienda: cargar SU baseline y limpiar lo de la anterior.
  useEffect(() => {
    lastSeen.current = storeId ? loadLastSeen(storeId) : { ...ZERO };
    current.current = { ...ZERO };
    initialised.current = false;
    setBadges({ seguimiento: 0, rescate: 0 });
    setBanner(null);
  }, [storeId]);

  const poll = useCallback(async () => {
    if (!userId || !storeId) return;

    // Count active novedades (unresolved) — scoped to active store.
    const [novRes, devRes, ofiRes] = await Promise.all([
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('store_id', storeId)
        // La MISMA red ancha que la cola real (useNovedades: ilike %NOVEDAD%,
        // porque Dropi usa variantes como 'NOVEDAD PENDIENTE' / 'NOVEDAD EN
        // RUTA' y el match estricto dejaba pedidos fuera — bug ya pagado).
        // Al ser un COUNT head:true no puede filtrar client-side como la cola,
        // asi que la variante resuelta se excluye en el propio filtro
        // (NOVEDAD SOLUCIONADA; 'SOLUCION APROBADA' no contiene NOVEDAD).
        .or('and(estado.ilike.%NOVEDAD%,estado.not.ilike.%SOLUCIONADA%),estado.ilike.%INTENTO DE ENTREGA%').eq('novedad_sol', false),
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('store_id', storeId)
        .ilike('estado', '%DEVOL%'),
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('store_id', storeId)
        .or('estado.ilike.%OFICINA%,estado.ilike.%RECLAME%'),
    ]);

    const nov = novRes.count ?? 0;
    const dev = devRes.count ?? 0;
    const ofi = ofiRes.count ?? 0;

    current.current = { novedades: nov, devoluciones: dev, oficina: ofi };

    if (!initialised.current) {
      // First poll: set baseline if nothing was stored
      if (lastSeen.current.novedades === 0 && lastSeen.current.devoluciones === 0 && lastSeen.current.oficina === 0) {
        lastSeen.current = { novedades: nov, devoluciones: dev, oficina: ofi };
        saveLastSeen(storeId, lastSeen.current);
      }
      initialised.current = true;
    }

    const newNov = Math.max(0, nov - lastSeen.current.novedades);
    const newDev = Math.max(0, dev - lastSeen.current.devoluciones);
    const newOfi = Math.max(0, ofi - lastSeen.current.oficina);

    setBadges({
      seguimiento: newNov,
      rescate: newDev + newOfi,
    });

    // Show banner if there are new items (only on subsequent polls, not initial)
    if (initialised.current && (newNov > 0 || newDev > 0 || newOfi > 0)) {
      const parts: string[] = [];
      if (newNov > 0) parts.push(`${newNov} novedad${newNov > 1 ? 'es' : ''}`);
      if (newDev > 0) parts.push(`${newDev} devoluci${newDev > 1 ? 'ones' : 'ón'}`);
      if (newOfi > 0) parts.push(`${newOfi} en oficina`);
      setBanner(`Nuevos: ${parts.join(', ')}`);
    }
  }, [userId, storeId]);

  // COST-1: subido de 2 min → 10 min, y se pausa con pestaña oculta.
  useEffect(() => {
    if (!userId || !storeId) return;
    poll();
    return pollWhenVisible(poll, 10 * 60 * 1000, { runOnVisible: false });
  }, [userId, storeId, poll]);

  /** Call when the user opens a tab to reset its badge. */
  const markSeen = useCallback((tab: 'seguimiento' | 'rescate') => {
    if (tab === 'seguimiento') {
      lastSeen.current.novedades = current.current.novedades;
    } else if (tab === 'rescate') {
      lastSeen.current.devoluciones = current.current.devoluciones;
      lastSeen.current.oficina = current.current.oficina;
    }
    if (storeId) saveLastSeen(storeId, lastSeen.current);
    setBadges(prev => ({ ...prev, [tab]: 0 }));
  }, [storeId]);

  const dismissBanner = useCallback(() => setBanner(null), []);

  return { badges, banner, markSeen, dismissBanner };
}

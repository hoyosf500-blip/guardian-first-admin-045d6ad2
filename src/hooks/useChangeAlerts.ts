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

const SESSION_KEY = 'changeAlerts:lastSeen';

interface LastSeen {
  novedades: number;
  devoluciones: number;
  oficina: number;
}

function loadLastSeen(): LastSeen {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { novedades: 0, devoluciones: 0, oficina: 0 };
}

function saveLastSeen(s: LastSeen) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
}

export function useChangeAlerts(userId: string | undefined) {
  const [badges, setBadges] = useState<TabBadges>({ seguimiento: 0, rescate: 0 });
  const [banner, setBanner] = useState<string | null>(null);
  const lastSeen = useRef<LastSeen>(loadLastSeen());
  const current = useRef<LastSeen>({ novedades: 0, devoluciones: 0, oficina: 0 });
  const initialised = useRef(false);

  const poll = useCallback(async () => {
    if (!userId) return;

    // Count active novedades (unresolved)
    const [novRes, devRes, ofiRes] = await Promise.all([
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .or('estado.eq.NOVEDAD,estado.ilike.%INTENTO DE ENTREGA%').eq('novedad_sol', false),
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .ilike('estado', '%DEVOL%'),
      supabase.from('orders').select('id', { count: 'exact', head: true })
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
        saveLastSeen(lastSeen.current);
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
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    poll();
    const interval = setInterval(poll, 2 * 60 * 1000); // every 2 min
    return () => clearInterval(interval);
  }, [userId, poll]);

  /** Call when the user opens a tab to reset its badge. */
  const markSeen = useCallback((tab: 'seguimiento' | 'rescate') => {
    if (tab === 'seguimiento') {
      lastSeen.current.novedades = current.current.novedades;
    } else if (tab === 'rescate') {
      lastSeen.current.devoluciones = current.current.devoluciones;
      lastSeen.current.oficina = current.current.oficina;
    }
    saveLastSeen(lastSeen.current);
    setBadges(prev => ({ ...prev, [tab]: 0 }));
  }, []);

  const dismissBanner = useCallback(() => setBanner(null), []);

  return { badges, banner, markSeen, dismissBanner };
}

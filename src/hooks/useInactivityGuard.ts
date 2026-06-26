import { useEffect, useRef, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useStore } from '@/contexts/StoreContext';
import {
  isWithinAlertWindow,
  workingSecondsLost,
  bogotaDateKey,
  IDLE_THRESHOLD_SECONDS,
} from '@/lib/inactivityWindow';

/**
 * Alertas de inactividad (presión psicológica de no perder tiempo).
 *
 * Mecánica (decisión del dueño 2026-06-26):
 *  - "Inactiva" = sin interacción (mouse/teclado/click/scroll) por 5+ min de
 *    tiempo LABORAL (9–17 Bogotá, excluye almuerzo 12:30–13:30).
 *  - No molestamos MIENTRAS está ausente: contamos el tiempo y, cuando vuelve
 *    (primer evento), le BLOQUEAMOS la pantalla con un modal que muestra cuánto
 *    tiempo perdió. Al tocar "Entendido" se desbloquea y suma +1 al contador.
 *  - 3 strikes (solo psicológico, NUNCA bloquea de verdad): 1º aviso, 2º "si
 *    repetís se bloqueará", 3º "el CRM se bloqueará". El contador acumula por
 *    día y queda registrado server-side (record_inactivity_warning) para el
 *    reporte del admin.
 *
 * Gates: solo OPERADORAS puras (no admin, no owner/supervisor) con tienda
 * activa — el dueño/managers no se molestan.
 */

export interface InactivityWarning {
  lostSeconds: number;
  number: number; // 1, 2, 3… acumulativo del día (Bogotá)
}

const MOUSEMOVE_THROTTLE_MS = 1000;

function dayKey(storeId: string, now: Date): string {
  return `guardian.inactivityWarnings:${storeId}:${bogotaDateKey(now)}`;
}

export function useInactivityGuard() {
  const { user, isAdmin, loading: authLoading } = useAuth();
  const { activeStoreId, isManagerOfActive } = useStore();

  const [warning, setWarning] = useState<InactivityWarning | null>(null);
  const lastActivityRef = useRef<number | null>(null);
  const lastMousemoveRef = useRef(0);
  const pendingRef = useRef(false);          // hay un modal en pantalla
  const warningsTodayRef = useRef(0);        // cuántos avisos lleva hoy (para "1/3")
  const storeRef = useRef<string | null>(null);
  const initializedStoreRef = useRef<string | null>(null);

  // Solo operadoras puras con tienda activa.
  const enabled =
    !authLoading && !!user && !isAdmin && !!activeStoreId && !isManagerOfActive;

  // Init del contador del día desde localStorage (sobrevive a un reload).
  // Corre UNA vez por tienda: un flip transitorio de `enabled` (ej. refresh de
  // token) NO debe re-inicializar ni borrar un modal abierto.
  useEffect(() => {
    if (!enabled || !activeStoreId) return;
    if (initializedStoreRef.current === activeStoreId) return;
    initializedStoreRef.current = activeStoreId;
    storeRef.current = activeStoreId;
    let n = 0;
    try { n = parseInt(localStorage.getItem(dayKey(activeStoreId, new Date())) || '0', 10) || 0; } catch { /* noop */ }
    warningsTodayRef.current = n;
    lastActivityRef.current = Date.now(); // arrancamos "activa"
    pendingRef.current = false;
    setWarning(null);
  }, [enabled, activeStoreId]);

  useEffect(() => {
    if (!enabled) return;

    const handle = () => {
      if (pendingRef.current) return;          // modal abierto → no procesar
      const now = Date.now();
      const last = lastActivityRef.current;
      lastActivityRef.current = now;
      if (last === null) return;               // primer evento de la sesión
      const nowDate = new Date(now);
      if (!isWithinAlertWindow(nowDate)) return; // fuera de horario / almuerzo
      const lost = workingSecondsLost(new Date(last), nowDate);
      if (lost < IDLE_THRESHOLD_SECONDS) return;
      // Volvió tras >=5 min de inactividad laboral → confrontar.
      pendingRef.current = true;
      setWarning({ lostSeconds: lost, number: warningsTodayRef.current + 1 });
    };

    const onMousemove = () => {
      const now = Date.now();
      if (now - lastMousemoveRef.current < MOUSEMOVE_THROTTLE_MS) return;
      lastMousemoveRef.current = now;
      handle();
    };

    window.addEventListener('mousemove', onMousemove, { passive: true });
    window.addEventListener('keydown', handle);
    window.addEventListener('click', handle);
    window.addEventListener('wheel', handle, { passive: true });
    window.addEventListener('touchstart', handle, { passive: true });

    return () => {
      window.removeEventListener('mousemove', onMousemove);
      window.removeEventListener('keydown', handle);
      window.removeEventListener('click', handle);
      window.removeEventListener('wheel', handle);
      window.removeEventListener('touchstart', handle);
    };
  }, [enabled]);

  const acknowledge = useCallback(() => {
    // Dedup: el segundo click de un double-click llega antes del re-render.
    // pendingRef ya está en false tras el primer ack → early return.
    if (!pendingRef.current) return;
    pendingRef.current = false;
    const w = warning;
    if (!w) return;
    const store = storeRef.current;
    const now = new Date();

    // Optimista: cerrar modal, contar, resetear la actividad (el click de
    // "Entendido" no debe re-disparar otra alerta).
    warningsTodayRef.current = w.number;
    if (store) {
      try { localStorage.setItem(dayKey(store, now), String(w.number)); } catch { /* noop */ }
    }
    setWarning(null);
    lastActivityRef.current = Date.now();

    // Persistir best-effort (el reporte del admin lee de la DB).
    if (store) {
      void (async () => {
        try {
          const { data } = await (supabase.rpc as unknown as (
            fn: 'record_inactivity_warning',
            args: { p_store_id: string; p_lost_seconds: number },
          ) => Promise<{ data: number | null; error: { message?: string } | null }>)(
            'record_inactivity_warning',
            { p_store_id: store, p_lost_seconds: w.lostSeconds },
          );
          // Reconciliar el número con el server (autoritativo) por si hubo
          // avisos desde otra pestaña / antes de un reload.
          if (typeof data === 'number' && data > warningsTodayRef.current) {
            warningsTodayRef.current = data;
            try { localStorage.setItem(dayKey(store, new Date()), String(data)); } catch { /* noop */ }
          }
        } catch { /* best-effort, no rompemos UX */ }
      })();
    }
  }, [warning]);

  return { warning, acknowledge };
}

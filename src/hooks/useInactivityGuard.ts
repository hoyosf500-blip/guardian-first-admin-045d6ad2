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
 * Mecánica (decisiones del dueño 2026-06-26):
 *  - "Inactiva" = sin interacción (mouse/teclado/click/scroll) por 5+ min de
 *    tiempo LABORAL (9–17 Bogotá, excluye almuerzo 12:30–13:30).
 *  - SOLO penaliza si HAY TRABAJO PENDIENTE (Confirmar / Novedades / Seguimiento).
 *    Si terminó todo y no hay nada que hacer, NO la molesta. Mientras no hay
 *    trabajo, un tick "excusa" la inactividad (resetea el reloj) para que el
 *    tiempo muerto sin trabajo no se acumule.
 *  - No molestamos mientras está ausente: contamos el tiempo y, cuando vuelve
 *    (primer evento), le mostramos un modal con cuánto tiempo perdió.
 *  - 3 avisos por día: 1º y 2º son avisos (se cierran con "Entendido", suman +1).
 *    El 3º (y siguientes) BLOQUEA la pantalla 5 minutos reales (cuenta regresiva,
 *    no se puede cerrar hasta que termine). El contador acumula por día y queda
 *    registrado server-side (record_inactivity_warning) para el reporte del admin.
 *
 * Gates: solo OPERADORAS puras (no admin, no owner/supervisor) con tienda activa.
 */

export interface InactivityWarning {
  lostSeconds: number;
  number: number;            // 1, 2, 3… acumulativo del día (Bogotá)
  lockedUntil?: number;      // si number>=3: timestamp hasta el que la pantalla queda bloqueada
}

const MOUSEMOVE_THROTTLE_MS = 1000;
const LOCK_DURATION_MS = 5 * 60 * 1000; // 3er aviso = 5 min de bloqueo real
const TICK_MS = 1000;

function dayKey(storeId: string, now: Date): string {
  return `guardian.inactivityWarnings:${storeId}:${bogotaDateKey(now)}`;
}

// Bloqueo activo persistido (el 3er aviso bloquea 5 min REALES — no se evade
// recargando la página). Guarda { until, number, lostSeconds }.
function lockKey(storeId: string): string {
  return `guardian.inactivityLock:${storeId}`;
}

export function useInactivityGuard({ hasPendingWork }: { hasPendingWork: boolean }) {
  const { user, isAdmin, loading: authLoading } = useAuth();
  const { activeStoreId, isManagerOfActive } = useStore();

  const [warning, setWarning] = useState<InactivityWarning | null>(null);
  const lastActivityRef = useRef<number | null>(null);
  const lastMousemoveRef = useRef(0);
  const pendingRef = useRef(false);          // hay un modal en pantalla
  const warningsTodayRef = useRef(0);        // cuántos avisos lleva hoy
  const storeRef = useRef<string | null>(null);
  const initializedStoreRef = useRef<string | null>(null);
  // Último valor de hasPendingWork — leído en el handler/tick (que corren fuera
  // del render) para decidir si penalizar. Se actualiza en cada render.
  const hasWorkRef = useRef(hasPendingWork);
  hasWorkRef.current = hasPendingWork;

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
    lastActivityRef.current = Date.now();

    // ¿Hay un bloqueo activo persistido? Si sí, lo restauramos (un reload no
    // evade el bloqueo de 5 min). Si ya expiró mientras no estaba, lo limpiamos.
    let restored = false;
    try {
      const raw = localStorage.getItem(lockKey(activeStoreId));
      if (raw) {
        const lk = JSON.parse(raw) as { until?: number; number?: number; lostSeconds?: number };
        if (typeof lk.until === 'number' && lk.until > Date.now()) {
          warningsTodayRef.current = Math.max(warningsTodayRef.current, lk.number || 0);
          pendingRef.current = true;
          setWarning({ lostSeconds: lk.lostSeconds || 0, number: lk.number || 3, lockedUntil: lk.until });
          restored = true;
        } else {
          localStorage.removeItem(lockKey(activeStoreId));
        }
      }
    } catch { /* noop */ }

    if (!restored) {
      pendingRef.current = false;
      setWarning(null);
    }
  }, [enabled, activeStoreId]);

  useEffect(() => {
    if (!enabled) return;

    const handle = () => {
      if (pendingRef.current) return;            // modal abierto → no procesar
      const now = Date.now();
      const last = lastActivityRef.current;
      lastActivityRef.current = now;
      if (last === null) return;                 // primer evento de la sesión
      if (!hasWorkRef.current) return;           // sin trabajo → no penalizar
      const nowDate = new Date(now);
      if (!isWithinAlertWindow(nowDate)) return; // fuera de horario / almuerzo
      const lost = workingSecondsLost(new Date(last), nowDate);
      if (lost < IDLE_THRESHOLD_SECONDS) return;
      // Volvió tras >=5 min de inactividad laboral CON trabajo pendiente.
      pendingRef.current = true;
      const number = warningsTodayRef.current + 1;
      const lockedUntil = number >= 3 ? now + LOCK_DURATION_MS : undefined;
      setWarning({ lostSeconds: lost, number, lockedUntil });
      // Persistir el bloqueo para que un reload NO lo evada.
      if (lockedUntil && storeRef.current) {
        try {
          localStorage.setItem(
            lockKey(storeRef.current),
            JSON.stringify({ until: lockedUntil, number, lostSeconds: lost }),
          );
        } catch { /* noop */ }
      }
    };

    const onMousemove = () => {
      const now = Date.now();
      if (now - lastMousemoveRef.current < MOUSEMOVE_THROTTLE_MS) return;
      lastMousemoveRef.current = now;
      handle();
    };

    // Tick: mientras NO hay trabajo (y no hay modal abierto), "excusamos" la
    // inactividad reseteando el reloj — el tiempo muerto sin nada que hacer NO
    // se acumula. Apenas aparece trabajo, el reloj corre normal desde ahí.
    const tickId = window.setInterval(() => {
      if (!pendingRef.current && !hasWorkRef.current) {
        lastActivityRef.current = Date.now();
      }
    }, TICK_MS);

    window.addEventListener('mousemove', onMousemove, { passive: true });
    window.addEventListener('keydown', handle);
    window.addEventListener('click', handle);
    window.addEventListener('wheel', handle, { passive: true });
    window.addEventListener('touchstart', handle, { passive: true });

    return () => {
      window.clearInterval(tickId);
      window.removeEventListener('mousemove', onMousemove);
      window.removeEventListener('keydown', handle);
      window.removeEventListener('click', handle);
      window.removeEventListener('wheel', handle);
      window.removeEventListener('touchstart', handle);
    };
  }, [enabled]);

  const acknowledge = useCallback(() => {
    // Dedup: el segundo click de un double-click llega antes del re-render.
    if (!pendingRef.current) return;
    pendingRef.current = false;
    const w = warning;
    if (!w) return;
    const store = storeRef.current;
    const now = new Date();

    warningsTodayRef.current = w.number;
    if (store) {
      try {
        localStorage.setItem(dayKey(store, now), String(w.number));
        localStorage.removeItem(lockKey(store)); // bloqueo cumplido / aviso cerrado
      } catch { /* noop */ }
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

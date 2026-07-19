import { useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useStore } from '@/contexts/StoreContext';

/**
 * Heartbeat de actividad de operadora — tracking jornada (Capa Productividad).
 *
 * Qué hace:
 *  - Escucha mousemove (throttled 1s), keydown, touchstart, click, wheel en
 *    window. Cualquier evento marca "ahora hay actividad".
 *  - Cada 1s, decide si el segundo cuenta como ACTIVO (hubo evento en últimos
 *    5 min) o IDLE (no hubo). Acumula en 2 buckets en useRef.
 *  - Cada 60s, manda los buckets al servidor vía RPC record_operator_heartbeat
 *    y los resetea. Si el RPC falla (offline, throttle, etc.), el bucket se
 *    pierde — best effort, no rompemos UX.
 *
 * Por qué no usar visibilitychange para forzar idle: decisión del usuario
 * 2026-05-28 — solo medir mouse/teclado, no penalizar por tener otra pestaña
 * abierta. Si la tab está en background, mousemove deja de dispararse en
 * NUESTRA window → el contador idle sube naturalmente, sin código extra.
 *
 * Por qué no se monta para isAdmin: los admins son el dueño/Fabian, no
 * producen volumen de confirmaciones. No queremos su data en el dashboard.
 */

const IDLE_THRESHOLD_MS = 5 * 60 * 1000;
// COST 2026-07-16: 60s → 5min. Reduce ~80% de writes de heartbeat. El server
// cappea cada bucket a 300s (ver record_operator_heartbeat) para no perder
// jornada tras un flush espaciado.
const PING_INTERVAL_MS = 5 * 60 * 1000;
const TICK_INTERVAL_MS = 1000;
// Throttle el mousemove (que se dispara cientos de veces por segundo) a 1
// "marca de actividad" por segundo. Para los demás eventos no hace falta.
const MOUSEMOVE_THROTTLE_MS = 1000;

export function useOperatorHeartbeat() {
  const { user, isAdmin, profileLoaded, loading: authLoading } = useAuth();
  const { activeStoreId } = useStore();

  // Refs (no rerenders): bucket de segundos activos/idle acumulados desde
  // el último ping al server.
  const activeBucket = useRef(0);
  const idleBucket = useRef(0);
  // Último timestamp donde detectamos input. Si NULL = todavía no hubo,
  // contamos todo como idle (operadora abrió pestaña pero no tocó).
  const lastActivityRef = useRef<number | null>(null);
  const lastMousemoveRef = useRef(0);

  useEffect(() => {
    // Gates: solo correr para operadora/supervisor de una tienda. Admin
    // global y "sin tienda activa" no se trackean.
    //
    // `profileLoaded` NO es redundante con `authLoading` (bug 2026-07-19):
    // `loading` se apaga apenas hay sesión, pero los roles se consultan en un
    // `setTimeout(…, 0)` posterior. Sin esta bandera el hook corría con
    // `isAdmin === false` prematuro y le fichaba jornada AL DUEÑO — quedó
    // evidencia en operator_activity_daily: una fila suya de 1 segundo, que es
    // exactamente la firma de la marca de entrada de acá abajo.
    if (authLoading || !profileLoaded) return;
    if (!user || isAdmin) return;
    if (!activeStoreId) return;

    const onActivity = () => {
      lastActivityRef.current = Date.now();
    };

    const onMousemove = () => {
      const now = Date.now();
      if (now - lastMousemoveRef.current < MOUSEMOVE_THROTTLE_MS) return;
      lastMousemoveRef.current = now;
      onActivity();
    };

    window.addEventListener('mousemove', onMousemove, { passive: true });
    window.addEventListener('keydown', onActivity);
    window.addEventListener('touchstart', onActivity, { passive: true });
    window.addEventListener('click', onActivity);
    window.addEventListener('wheel', onActivity, { passive: true });

    // ── MARCA DE ENTRADA (2026-07-19) ────────────────────────────────────
    // Pedido del dueño: "cuando la operadora lo abre, ahí empieza su turno y me
    // marca la hora de entrada".
    //
    // `first_action_at` — la columna que /admin → Productividad muestra como
    // ENTRÓ — se sella en el PRIMER INSERT del día de `operator_activity_daily`
    // y después el ON CONFLICT ya no la toca. Hasta ahora ese primer INSERT
    // llegaba con el primer flush, o sea HASTA 5 MINUTOS TARDE (PING_INTERVAL
    // subió de 60s a 5min en julio por costo). Peor: si abría y no tocaba nada,
    // la hora de entrada terminaba siendo la de su primer movimiento, no la de
    // su llegada.
    //
    // Este ping inmediato sella la hora al abrir. Es 1 SEGUNDO de actividad —
    // abrir el CRM ES una acción, y un segundo es ruido frente a una jornada.
    // Tiene que ser > 0: el server descarta el ping si active e idle son ambos
    // cero (`IF p_active_seconds = 0 AND p_idle_seconds = 0 THEN RETURN`), así
    // que un ping "vacío" no crearía la fila y no habría hora que marcar.
    //
    // Es IDEMPOTENTE por diseño: si ya hay fila del día, el ON CONFLICT suma el
    // segundo y CONSERVA el `first_action_at` original. Recargar la página o
    // volver de otra pestaña no reescribe la hora de llegada.
    let cancelado = false;
    void (async () => {
      try {
        await (
          supabase.rpc as unknown as (
            fn: 'record_operator_heartbeat',
            args: { p_store_id: string; p_active_seconds: number; p_idle_seconds: number },
          ) => Promise<{ error: { message?: string } | null }>
        )('record_operator_heartbeat', {
          p_store_id: activeStoreId,
          p_active_seconds: 1,
          p_idle_seconds: 0,
        });
      } catch (err) {
        if (!cancelado && process.env.NODE_ENV !== 'production') {
          // eslint-disable-next-line no-console
          console.warn('[heartbeat] marca de entrada falló', err);
        }
      }
    })();

    // Tick cada segundo: decide bucket basado en última actividad.
    const tickId = window.setInterval(() => {
      const now = Date.now();
      const last = lastActivityRef.current;
      if (last !== null && now - last < IDLE_THRESHOLD_MS) {
        activeBucket.current += 1;
      } else {
        idleBucket.current += 1;
      }
    }, TICK_INTERVAL_MS);

    // Ping cada 60s: vuelca los buckets al servidor.
    const flush = async () => {
      const active = activeBucket.current;
      const idle = idleBucket.current;
      if (active === 0 && idle === 0) return;
      activeBucket.current = 0;
      idleBucket.current = 0;
      try {
        const { error } = await (
          supabase.rpc as unknown as (
            fn: 'record_operator_heartbeat',
            args: { p_store_id: string; p_active_seconds: number; p_idle_seconds: number },
          ) => Promise<{ error: { message?: string } | null }>
        )('record_operator_heartbeat', {
          p_store_id: activeStoreId,
          p_active_seconds: active,
          p_idle_seconds: idle,
        });
        if (error) {
          // Silencioso por diseño — no queremos romper UX por un ping fallado.
          // Devolvemos los segundos al bucket para reintentar en el próximo
          // ping (mejor doble-conteo eventual que perder data).
          if (process.env.NODE_ENV !== 'production') {
            // eslint-disable-next-line no-console
            console.warn('[heartbeat] rpc failed', error);
          }
          activeBucket.current += active;
          idleBucket.current += idle;
        }
      } catch (err) {
        if (process.env.NODE_ENV !== 'production') {
          // eslint-disable-next-line no-console
          console.warn('[heartbeat] threw', err);
        }
        activeBucket.current += active;
        idleBucket.current += idle;
      }
    };
    const pingId = window.setInterval(() => { void flush(); }, PING_INTERVAL_MS);

    // Cleanup en unmount / cambio de store / logout
    return () => {
      cancelado = true;
      window.clearInterval(tickId);
      window.clearInterval(pingId);
      window.removeEventListener('mousemove', onMousemove);
      window.removeEventListener('keydown', onActivity);
      window.removeEventListener('touchstart', onActivity);
      window.removeEventListener('click', onActivity);
      window.removeEventListener('wheel', onActivity);
      // Flush final best-effort — no esperamos la promesa
      void flush();
    };
  }, [user, isAdmin, profileLoaded, authLoading, activeStoreId]);
}

import { useEffect, useRef, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useStore } from '@/contexts/StoreContext';
import {
  isWithinAlertWindow,
  workingSecondsLost,
  bogotaDateKey,
  scheduleFromMinutes,
  DEFAULT_SCHEDULE,
  IDLE_THRESHOLD_SECONDS,
  type WorkSchedule,
} from '@/lib/inactivityWindow';
import { useStoreSchedule } from '@/hooks/useStoreSchedule';
import { onGestion } from '@/lib/eventosGestion';
import { seLeBloqueaLaPantalla } from '@/lib/rolesTrabajo';

/**
 * Alertas de inactividad (presión psicológica de no perder tiempo).
 *
 * Mecánica (decisiones del dueño 2026-06-26):
 *  - "Inactiva" = sin interacción (mouse/teclado/click/scroll) por 6+ min de
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
 * Gates: `seLeBloqueaLaPantalla` (`rolesTrabajo.ts`) — operadora pura con tienda
 * activa. Ni admin, ni dueño, ni supervisor: al supervisor SÍ se le mide el
 * trabajo, pero trabarle la pantalla deja al equipo sin quien lo destrabe.
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

/**
 * Grabar el aviso en la base.
 *
 * ⛔ SE LLAMA CUANDO EL AVISO SALE, NO CUANDO LO CIERRAN (3-sep-2026).
 *
 * Antes vivía dentro de `acknowledge`, o sea que **solo quedaba constancia si la
 * persona apretaba "Entendido"**. Cerrar la pestaña con el modal en pantalla
 * borraba la evidencia — justo lo que haría quien no quiere que la cuenten — y
 * el dueño veía CERO avisos sobre alguien a quien el modal le había salido tres
 * veces. Ese hueco es la razón principal por la que el dueño dijo *"las alertas
 * de inactividad no las he vuelto a ver"*.
 *
 * Es best-effort a propósito: si la red falla, el modal igual sale y la pantalla
 * igual se bloquea. Perder el registro es malo; frenarle el CRM a una asesora
 * por un error de red sería peor.
 *
 * Devuelve el contador del día que dice el SERVIDOR, o `null` si no se pudo.
 */
async function grabarAviso(storeId: string, lostSeconds: number): Promise<number | null> {
  try {
    const { data } = await (supabase.rpc as unknown as (
      fn: 'record_inactivity_warning',
      args: { p_store_id: string; p_lost_seconds: number },
    ) => Promise<{ data: number | null; error: { message?: string } | null }>)(
      'record_inactivity_warning',
      { p_store_id: storeId, p_lost_seconds: lostSeconds },
    );
    return typeof data === 'number' ? data : null;
  } catch {
    return null; // best-effort: no rompemos la UX de quien está trabajando
  }
}

export function useInactivityGuard({ hasPendingWork, enPausa = false }: { hasPendingWork: boolean; enPausa?: boolean }) {
  const { user, isAdmin, loading: authLoading } = useAuth();
  const { activeStoreId, isManagerOfActive, isOwnerOfActive } = useStore();
  // Horario laboral de la tienda (configurable). Default 9–17 si no está cargado
  // o la migration no se aplicó — el guard nunca depende de que exista.
  const scheduleQuery = useStoreSchedule(activeStoreId);

  const [warning, setWarning] = useState<InactivityWarning | null>(null);
  const lastActivityRef = useRef<number | null>(null);
  const lastMousemoveRef = useRef(0);
  const pendingRef = useRef(false);          // hay un modal en pantalla
  const warningsTodayRef = useRef(0);        // cuántos avisos lleva hoy
  const storeRef = useRef<string | null>(null);
  const initializedStoreRef = useRef<string | null>(null);
  // Número del último aviso que YA se grabó en la base. Evita grabar dos veces
  // el mismo cuando después se aprieta "Entendido".
  const grabadoRef = useRef(0);
  // Último valor de hasPendingWork — leído en el handler/tick (que corren fuera
  // del render) para decidir si penalizar. Se actualiza en cada render.
  const hasWorkRef = useRef(hasPendingWork);
  hasWorkRef.current = hasPendingWork;
  // Pausa declarada ("estoy en la agencia"). Mismo tratamiento que "no hay
  // trabajo": no se penaliza y el tick va reseteando el reloj, así que al
  // volver no hay una hora acumulada esperándola. Ver `pausaTrabajo.ts`.
  const enPausaRef = useRef(enPausa);
  enPausaRef.current = enPausa;
  // Horario en un ref (el handler/tick corren fuera del render). Se actualiza en
  // cada render con el último dato del hook.
  const scheduleRef = useRef<WorkSchedule>(DEFAULT_SCHEDULE);
  scheduleRef.current = scheduleQuery.data ? scheduleFromMinutes(scheduleQuery.data) : DEFAULT_SCHEDULE;

  // Solo a quien se le puede TRABAR la pantalla, con tienda activa.
  //
  // La reja es más estrecha que «trabaja la cola» a propósito, y desde el
  // 28-ago-2026 esa diferencia está escrita y probada en `rolesTrabajo.ts` en
  // vez de vivir en un `!isManagerOfActive` suelto que se leía como un olvido.
  // Al supervisor SÍ se le mide el trabajo (reparto, jornada, aviso por huecos,
  // botón de pausa); lo único que no se le hace es bloquearle la pantalla cinco
  // minutos, porque es el que destraba al resto del equipo.
  const enabled =
    !authLoading && !!user && !!activeStoreId &&
    seLeBloqueaLaPantalla({ isAdmin, isOwnerOfActive, isManagerOfActive });

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
        const lk = JSON.parse(raw) as { until?: number; number?: number; lostSeconds?: number; grabado?: boolean };
        if (typeof lk.until === 'number' && lk.until > Date.now()) {
          warningsTodayRef.current = Math.max(warningsTodayRef.current, lk.number || 0);
          // ⛔ Si este aviso YA se grabó antes del reload, que "Entendido" no
          // lo vuelva a grabar: record_inactivity_warning es COUNT+1, no es
          // idempotente, y la asesora aparecía con 4 avisos por 3 reales.
          if (lk.grabado) grabadoRef.current = lk.number || 3;
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
      if (enPausaRef.current) return;            // dijo dónde estaba → no se le acusa
      const nowDate = new Date(now);
      if (!isWithinAlertWindow(nowDate, scheduleRef.current)) return; // fuera de horario / almuerzo
      const lost = workingSecondsLost(new Date(last), nowDate, scheduleRef.current);
      if (lost < IDLE_THRESHOLD_SECONDS) return;
      // Volvió tras >=6 min de inactividad laboral CON trabajo pendiente.
      pendingRef.current = true;
      const number = warningsTodayRef.current + 1;
      const lockedUntil = number >= 3 ? now + LOCK_DURATION_MS : undefined;
      setWarning({ lostSeconds: lost, number, lockedUntil });
      // Persistir el bloqueo para que un reload NO lo evada.
      if (lockedUntil && storeRef.current) {
        try {
          localStorage.setItem(
            lockKey(storeRef.current),
            // `grabado`: el aviso se graba en la base ACÁ abajo, en este mismo
            // paso; el candado lo recuerda para que un F5 no lo grabe dos veces.
            JSON.stringify({ until: lockedUntil, number, lostSeconds: lost, grabado: true }),
          );
        } catch { /* noop */ }
      }
      // ⛔ ACÁ, no en `acknowledge`. El aviso ya salió: que quede constancia
      // aunque la persona cierre la pestaña sin cerrarlo. Ver `grabarAviso`.
      const tienda = storeRef.current;
      if (tienda) {
        grabadoRef.current = number;
        void grabarAviso(tienda, lost).then((delServidor) => {
          if (delServidor != null && delServidor > warningsTodayRef.current) {
            warningsTodayRef.current = delServidor;
            try { localStorage.setItem(dayKey(tienda, new Date()), String(delServidor)); } catch { /* noop */ }
          }
        });
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
    //
    // Una pausa declarada se trata igual. Y tiene que ser acá, en el tick, no
    // solo en `handle()`: si solo se filtrara al volver, los 45 minutos en la
    // agencia quedarían ACUMULADOS y el primer movimiento de mouse después de
    // cerrar la pausa dispararía el castigo por el tiempo ya justificado.
    const tickId = window.setInterval(() => {
      if (!pendingRef.current && (!hasWorkRef.current || enPausaRef.current)) {
        lastActivityRef.current = Date.now();
      }
    }, TICK_MS);

    // ⛔ Una gestión registrada NO pasa por `handle()`: solo pone el reloj en
    // cero (27-ago-2026).
    //
    // La diferencia importa. `handle()` es "volvió después de estar ausente" y
    // puede acusar; esto es "acaba de hacer un trabajo REAL", que es la señal
    // más fuerte que existe de que la persona está laburando — más fuerte que
    // mover el mouse, que es lo único que este guard miraba. Pasarla por
    // `handle()` sería absurdo: marcar un pedido después de una llamada larga
    // dispararía el castigo justo por trabajar.
    //
    // Esto NO tapa el caso de Estefano (una hora en la web de Servientrega, sin
    // tocar Guardian): para eso está el botón "Estoy en otra cosa". Tapa el
    // caso de quien SÍ está marcando y aun así aparecía "quieto" porque no
    // movía el mouse entre marca y marca.
    const enCero = () => { if (!pendingRef.current) lastActivityRef.current = Date.now(); };

    window.addEventListener('mousemove', onMousemove, { passive: true });
    window.addEventListener('keydown', handle);
    window.addEventListener('click', handle);
    window.addEventListener('wheel', handle, { passive: true });
    window.addEventListener('touchstart', handle, { passive: true });
    window.addEventListener('guardian:mi-gestion', enCero);
    const offGestion = onGestion(enCero);

    return () => {
      window.clearInterval(tickId);
      window.removeEventListener('mousemove', onMousemove);
      window.removeEventListener('keydown', handle);
      window.removeEventListener('click', handle);
      window.removeEventListener('wheel', handle);
      window.removeEventListener('touchstart', handle);
      window.removeEventListener('guardian:mi-gestion', enCero);
      offGestion();
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

    // ⛔ Nunca hacia abajo: el servidor pudo haber contestado ya (en `handle`)
    // con un número mayor —otro navegador, localStorage vacío— y pisarlo acá
    // atrasaba la numeración local: el bloqueo del 3er aviso llegaba un aviso
    // tarde.
    warningsTodayRef.current = Math.max(warningsTodayRef.current, w.number);
    if (store) {
      try {
        localStorage.setItem(dayKey(store, now), String(warningsTodayRef.current));
        localStorage.removeItem(lockKey(store)); // bloqueo cumplido / aviso cerrado
      } catch { /* noop */ }
    }
    setWarning(null);
    lastActivityRef.current = Date.now();

    // ⛔ RED DE SEGURIDAD, ya no la vía principal. El aviso se graba al SALIR
    // (ver `handle`); acá solo se cubre el caso del bloqueo restaurado desde
    // localStorage tras un reload, donde este montaje nunca vio salir el aviso
    // y por lo tanto nunca lo grabó. Sin la guarda de `grabadoRef`, apretar
    // "Entendido" sumaría un segundo aviso por el mismo hueco y le inflaría el
    // número a la asesora — el error opuesto, y también injusto.
    if (store && grabadoRef.current !== w.number) {
      grabadoRef.current = w.number;
      void grabarAviso(store, w.lostSeconds).then((delServidor) => {
        if (delServidor != null && delServidor > warningsTodayRef.current) {
          warningsTodayRef.current = delServidor;
          try { localStorage.setItem(dayKey(store, new Date()), String(delServidor)); } catch { /* noop */ }
        }
      });
    }
  }, [warning]);

  return { warning, acknowledge };
}

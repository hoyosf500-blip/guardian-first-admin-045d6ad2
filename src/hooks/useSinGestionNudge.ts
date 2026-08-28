import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { debeAvisarSinGestion, minutosSinGestion } from '@/lib/huecosGestion';
import { onGestion } from '@/lib/eventosGestion';

/**
 * Aviso SUAVE a la operadora cuando lleva un rato sin MARCAR un pedido.
 *
 * Pedido del dueño (25-ago-2026): la alerta vieja mira el mouse, no las
 * gestiones, así que una asesora podía estar 30 min sin marcar nada y figurar
 * "activa". Esto mira lo correcto (la última gestión real) y le da un
 * recordatorio — que **NO bloquea la pantalla ni cuenta como falta**, a
 * diferencia del modal de `useInactivityGuard`. Es un empujón, no un castigo:
 * una llamada larga legítima también se ve como un hueco, y no queremos
 * penalizar a quien está vendiendo.
 *
 * Señal de "acabo de gestionar": el evento `guardian:mi-gestion` que despacha
 * `markResult` (OrderContext) en cada conf/canc/noresp. Es LOCAL e instantáneo
 * — no depende del realtime, así que un corte de realtime no dispara un aviso
 * falso. Al montar se siembra `lastMark = ahora` (gracia): recién entrando,
 * nadie recibe el aviso hasta pasado el umbral.
 *
 * Gates (via `enabled`, que decide el que lo monta): solo operadora pura, no
 * admin ni dueño ni supervisor — a ellos este recordatorio les mentiría.
 */
export function useSinGestionNudge({ hasPendingWork, enabled }: { hasPendingWork: boolean; enabled: boolean }) {
  const lastMarkRef = useRef<number>(Date.now());
  const ultimoAvisoRef = useRef<number | null>(null);
  const workRef = useRef(hasPendingWork);
  workRef.current = hasPendingWork;

  // Cada gestión propia reinicia el reloj — venga de DONDE venga.
  //
  // ⛔ Hasta el 27-ago-2026 escuchaba SOLO `guardian:mi-gestion`, que despacha
  // `markResult` (OrderContext) y que existe únicamente en Confirmar. Una
  // asesora que trabajaba Seguimiento entero —marcando en el tablero, avisando
  // a clientes de agencia, llamando— recibía "Llevás 20 min sin marcar un
  // pedido" CADA 20 MINUTOS, para siempre, por mucho que marcara. El dueño leyó
  // esa señal y le reclamó por WhatsApp a alguien que estaba trabajando.
  // `EVENTO_GESTION` lo emite `useRecordGestion`, que es por donde pasan TODAS
  // las gestiones de Seguimiento, Novedades y rescate.
  useEffect(() => {
    if (!enabled) return;
    const onMark = () => { lastMarkRef.current = Date.now(); };
    window.addEventListener('guardian:mi-gestion', onMark);
    const offGestion = onGestion(onMark);
    return () => {
      window.removeEventListener('guardian:mi-gestion', onMark);
      offGestion();
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => {
      const now = Date.now();
      if (!debeAvisarSinGestion({
        lastMarkMs: lastMarkRef.current,
        nowMs: now,
        hayTrabajo: workRef.current,
        ultimoAvisoMs: ultimoAvisoRef.current,
      })) return;
      ultimoAvisoRef.current = now;
      const min = minutosSinGestion(lastMarkRef.current, now);
      toast(`Llevás ${min} min sin marcar un pedido`, {
        description: '¿Seguís en una llamada? Si no, hay clientes esperando en la cola 🙂',
        duration: 12_000,
      });
    }, 60_000);
    return () => window.clearInterval(id);
  }, [enabled]);
}

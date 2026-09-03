import { useEffect, useRef } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useStore } from '@/contexts/StoreContext';
import { soloObserva } from '@/lib/rolesTrabajo';
import { useOrderLock } from '@/hooks/useOrderLock';

/**
 * "ESTOY ATENDIENDO ESTE PEDIDO" — el candado corto que evita llamar dos veces
 * al mismo cliente.
 *
 * ── Por qué existe (pedido del dueño, 3-sep-2026) ───────────────────────────
 * Textual: *"cuando un asesor o supervisor toque, que bloquee ese pedido para
 * que no pase el bug de que se llame 2 veces"*.
 *
 * En **Confirmar** esto ya existía desde hace un año: abrir la ficha de llamada
 * reclama el pedido con `claim_order` y la cola de las demás lo esconde. En
 * **Seguimiento, Novedades y la bandeja no había nada**: dos personas podían
 * abrir el mismo chat y escribirle al mismo cliente al mismo tiempo.
 *
 * Este hook usa la MISMA función que Confirmar (`claim_order` / `release_order`,
 * ya desplegadas, atómicas y con TTL de 15 min más un cron que limpia los
 * huérfanos). Cero migraciones.
 *
 * ── ⛔ LA LÍNEA QUE NO SE CRUZA ─────────────────────────────────────────────
 * Esto es un candado CORTO Y VIVO, no un dueño estampado. En mayo-2026 un
 * trigger le ponía dueño a cada pedido al nacer y la pantalla lo trataba como
 * candado (*"Atendido por X — no puedes ejecutar acciones"*): todo pedido tenía
 * dueño, casi ninguno tenía trabajo hecho, y las demás quedaban bloqueadas. Se
 * apagó entero (`20260524120000`).
 *
 * La diferencia que hace que esto sea seguro, y que hay que conservar:
 *   · dura mientras la pantalla está ABIERTA, y se suelta al cerrarla;
 *   · vence solo a los 15 minutos, aunque el navegador se muera;
 *   · **NO impide gestionar**: en Seguimiento, Novedades y la bandeja el pedido
 *     se sigue viendo y se sigue pudiendo trabajar. Lo único que hace es
 *     sacarlo de la COLA DE LLAMADAS de Confirmar mientras alguien lo atiende
 *     — que es, literalmente, evitar la segunda llamada.
 *
 * ⛔ Y el dueño NO reclama nunca (`soloObserva`). Entrar a mirar un pedido no
 * puede costarle un cliente al equipo: ese error ya se pagó en Confirmar, donde
 * el dueño abría una ficha y `claim_order` se la escondía a TODAS por 15 min.
 */
/**
 * Cuantos lugares de la pantalla sostienen el candado de cada pedido.
 *
 * ⛔ SIN ESTO SE SUELTA UN CANDADO AJENO. `claim_order` RENUEVA cuando el lock
 * ya es propio (`locked_by = auth.uid()`), asi que dos partes de la misma
 * pantalla pueden "tomar" el mismo pedido y creer las dos que es suyo. La
 * primera en cerrarse lo soltaba por las dos — y en una ficha de llamada eso
 * significa que otra asesora puede tomar el cliente MIENTRAS la primera esta
 * hablando con el, que es justo el bug que este candado vino a evitar.
 *
 * Es por sesion (memoria del modulo), que es exactamente el alcance correcto:
 * lo que hay que contar son los lugares de ESTA pantalla.
 */
const SOSTENIDOS = new Map<string, number>();

export function useAtencionPedido(dbId: string | null | undefined, activo: boolean): void {
  const { isAdmin } = useAuth();
  const { isOwnerOfActive } = useStore();
  const { claimOrder, releaseOrder } = useOrderLock();
  // Solo se suelta lo que SE tomó. `release_order` corriendo como admin puede
  // soltar el candado de otra persona: misma guarda que ya tiene CallView.
  const mioRef = useRef<string | null>(null);

  const observa = soloObserva({ isAdmin, isOwnerOfActive });

  useEffect(() => {
    if (observa || !activo || !dbId) return;
    let cancelado = false;
    void claimOrder(dbId).then((r) => {
      // ⛔ Si la pantalla ya se cerró cuando llega la respuesta, el candado YA
      // existe en la base (4-sep-2026): con el `return` a secas quedaba
      // huérfano 15 min y `isLockedByOther` escondía ese pedido a TODO el
      // equipo — el "Siguiente salta" de la bandeja y de Novedades al pasar
      // rápido entre tarjetas. Se suelta acá mismo.
      if (cancelado) {
        // ⛔ Solo si NADIE MÁS de esta pestaña lo sostiene. `claim_order`
        // renueva un candado propio y devuelve ok:true; si la bandeja (o la
        // ficha de Novedades) tiene el mismo pedido abierto y el diálogo de
        // WhatsApp se cerró antes de que respondiera el RPC, soltar acá le
        // quitaba el candado a la pantalla que sí lo tiene — y Confirmar se lo
        // entregaba a otra asesora (revisión 3-sep-2026).
        if (r.ok && !(SOSTENIDOS.get(dbId) ?? 0)) void releaseOrder(dbId);
        return;
      }
      // `ok:false` no se avisa ni se salta: acá el pedido YA está en pantalla
      // porque la persona lo eligió. Que otra lo tenga tomado no es motivo para
      // sacárselo de la vista —seguir el hilo de un chat no le hace daño a
      // nadie—; lo que no pasa es que se lo tome ella también.
      if (r.ok) {
        mioRef.current = dbId;
        SOSTENIDOS.set(dbId, (SOSTENIDOS.get(dbId) ?? 0) + 1);
      }
    });
    return () => {
      cancelado = true;
      if (mioRef.current === dbId) {
        mioRef.current = null;
        const quedan = (SOSTENIDOS.get(dbId) ?? 1) - 1;
        if (quedan > 0) { SOSTENIDOS.set(dbId, quedan); return; }
        SOSTENIDOS.delete(dbId);
        void releaseOrder(dbId);
      }
    };
  }, [dbId, activo, observa, claimOrder, releaseOrder]);
}

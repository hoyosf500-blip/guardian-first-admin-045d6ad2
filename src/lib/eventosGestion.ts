/**
 * El aviso LOCAL de "acabo de registrar una gestión".
 *
 * ── Por qué existe (bug del 27-ago-2026, y costó un regaño a una persona) ────
 * Una asesora marcaba "Avisé: en oficina" en el tablero y **el número no
 * bajaba**. Textual: *"sí le pongo pero no baja el número"*. El dueño lo leyó
 * como que no trabajaba.
 *
 * La causa: `OrderContext` actualiza `mySegTouchedToday` /
 * `gestionSegPorTelefono` **solo desde el realtime de `touchpoints`**… y esa
 * tabla NUNCA se agregó a la publicación `supabase_realtime` (las únicas
 * publicadas son orders, order_results, wa_conversations, wa_messages y
 * order_labels). El handler estaba escrito y esperando eventos que no llegaban
 * nunca. `SegBoard.gestionar()` solo pintaba la tarjeta, un estado local que
 * ningún contador mira.
 *
 * ── La regla que sale de ahí ────────────────────────────────────────────────
 * **Un contador no puede depender de la red para reflejar lo que la persona
 * acaba de hacer con su propio dedo.** El realtime sirve para enterarse de lo
 * que hizo OTRA (y se arregla aparte, publicando la tabla); lo propio se aplica
 * en el acto, sin salir del navegador.
 *
 * Es el mismo molde que `guardian:mi-gestion` (el que despacha `markResult` en
 * Confirmar): un evento de `window`, para no acoplar `useRecordGestion` —que es
 * un hook suelto que se usa en tres pantallas— al contexto de pedidos.
 *
 * ⛔ **Esto NO reemplaza al INSERT ni lo adelanta**: se emite DESPUÉS de que la
 * base confirmó la fila. Un contador que baje con un INSERT que falló sería
 * peor que el bug original — le diría a la asesora que ya avisó a un cliente
 * que nunca se enteró.
 */

/** Gestión propia recién registrada. Lo escucha `OrderContext` (contadores) y
 *  `useSinGestionNudge` (para no acusar de inactiva a quien acaba de marcar). */
export const EVENTO_GESTION = 'guardian:gestion-registrada';

export interface DetalleGestion {
  /** Teléfono del pedido: es la clave con la que Seguimiento cruza touchpoints
   *  (la tabla no guarda order_id). */
  phone: string;
  /** El módulo del touchpoint: 'SEG' es el único que mueve los contadores de
   *  Seguimiento; LLAMADA/WHATSAPP son intentos de contacto y no cuentan como
   *  gestión (ver `useRecordGestion`). */
  modulo: string;
  /** El texto SIN prefijo — 'Avisé: en oficina', no 'SEG: Avisé: en oficina'.
   *  Así llega igual que lo que `aplicarGestionEnVivo` recibe del realtime. */
  accion: string;
  operatorId: string | null;
  /** ISO de cuándo quedó registrada, tal como lo devolvió la base. */
  at: string;
}

export function emitirGestion(detalle: DetalleGestion): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<DetalleGestion>(EVENTO_GESTION, { detail: detalle }));
}

/** Suscribe y devuelve la función para desuscribirse (para usar tal cual como
 *  cleanup de un `useEffect`). */
export function onGestion(cb: (d: DetalleGestion) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (e: Event) => {
    const d = (e as CustomEvent<DetalleGestion>).detail;
    if (d?.phone) cb(d);
  };
  window.addEventListener(EVENTO_GESTION, handler);
  return () => window.removeEventListener(EVENTO_GESTION, handler);
}

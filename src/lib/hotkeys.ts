// Overlays que se ADUEÑAN del teclado. Radix le pone role="dialog" a Dialog
// pero role="alertdialog" a AlertDialog: mirar solo el primero dejaba vivos los
// atajos con el "¿Borrar esta nota?" abierto y una tecla 1 confirmaba —
// despachando a Dropi— el pedido tapado por el overlay. role="menu" cubre los
// dropdown de Radix. Todos se desmontan al cerrar, así que el selector solo
// matchea overlays realmente abiertos.
const OVERLAY_SELECTOR = '[role="dialog"], [role="alertdialog"], [role="menu"], [aria-modal="true"]';

/**
 * ¿Puede correr un atajo de teclado AHORA?
 *
 * Pura y compartida por CallView, CrmCallView y la ficha del pedido: UNA sola
 * definición, porque la copia divergente es exactamente cómo volvió el bug la
 * vez pasada. Vive en lib/ y no dentro de una pantalla para que importarla no
 * arrastre el bundle de esa pantalla a las demás.
 *
 * Falla hacia "no hacer nada": ante cualquier overlay o campo de texto, la
 * tecla no dispara nada.
 */
export function hotkeysHabilitados(
  activeElement: Element | null,
  doc: Document | null = typeof document !== 'undefined' ? document : null,
): boolean {
  const el = activeElement as HTMLElement | null;
  const tag = el?.tagName;
  // Con un campo enfocado la tecla es TEXTO (notas, dirección, teléfono).
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return false;
  if (!doc) return false;
  if (doc.querySelector(OVERLAY_SELECTOR)) return false;
  return true;
}

/** Un atajo NUNCA debe pisarle un acelerador al navegador ni auto-repetirse
 *  con la tecla sostenida (100 marcas por dedo trabado). */
export function esTeclaDeAtajo(e: KeyboardEvent): boolean {
  return !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat;
}

/**
 * Copiar al portapapeles, diciendo la verdad sobre si se pudo.
 *
 * ── Por qué existe (28-ago-2026) ────────────────────────────────────────────
 * El botón para copiar el número de pedido en el tablero estaba escrito así:
 *
 *   navigator.clipboard?.writeText(n).then(avisar).catch(avisarError)
 *
 * El `?.` **corta la cadena entera**, no solo la llamada: sin
 * `navigator.clipboard` no corre ni el `.then` ni el `.catch`. La asesora
 * apretaba y no pasaba **nada** — ni copiaba, ni avisaba. El comentario que
 * tenía al lado afirmaba justo lo contrario ("avisa que no se pudo"), que es lo
 * peor de las dos cosas: el que lo lea después no vuelve a revisar.
 *
 * `navigator.clipboard` solo existe en contexto seguro (HTTPS o localhost).
 * Producción va por HTTPS, así que el camino bueno es el normal; el fallback es
 * para el previsualizador y para cuando el navegador rechaza el permiso.
 *
 * Devuelve `true` solo si de verdad copió. Nunca lanza.
 */
export async function copiarAlPortapapeles(texto: string): Promise<boolean> {
  if (!texto) return false;

  // Camino bueno. Puede rechazar aunque exista (permiso denegado, documento sin
  // foco), y en ese caso NO se da por perdido: se intenta el de abajo.
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(texto);
      return true;
    } catch {
      /* sigue por el fallback */
    }
  }

  // Fallback para contexto no seguro. `execCommand` está deprecado pero es lo
  // único que funciona sin HTTPS, y acá el costo de no copiar lo paga alguien
  // que tiene que transcribir un número de 7 dígitos a mano.
  try {
    if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false;
    const ta = document.createElement('textarea');
    ta.value = texto;
    // Fuera de la vista pero SELECCIONABLE: con `display:none` o `hidden` el
    // navegador no deja seleccionar y la copia falla en silencio.
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

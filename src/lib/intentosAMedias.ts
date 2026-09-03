import type { GestionDelPedido } from './gestionPorPedido';

/**
 * Pedidos que se llamaron una vez, no contestaron, y ahí quedaron.
 *
 * ── Por qué existe (3-sep-2026) ─────────────────────────────────────────────
 * Pedido del dueño: *"hacen 1 intento en vez de 3"*. El tope de tres llamadas
 * por día ya existía (`MAX_DAILY_ATTEMPTS` en `confirmarQueue.ts`) y la ficha ya
 * dice "Hoy 1 de 3" **en el pedido abierto**. Lo que no existía era el número
 * agregado: **cuántos pedidos quedaron a medio intentar**. Sin eso, quedarse en
 * el primer intento no se nota en ninguna pantalla.
 *
 * ── La definición, y por qué es esta ────────────────────────────────────────
 * Un pedido está **a medias** cuando se lo llamó hoy, **no contestó**, y todavía
 * le quedan llamadas del día.
 *
 * ⛔ Un pedido **confirmado o cancelado en la primera llamada NO está a medias**:
 * está resuelto. Contarlo sería castigar justo a quien lo hizo bien de una,
 * y ese número lo va a leer alguien para hablar con una persona.
 *
 * ⛔ Un pedido que ya gastó sus tres llamadas **tampoco**: la asesora hizo lo que
 * debía y el pedido vuelve a la cola mañana. Ese se cuenta aparte, porque
 * significa otra cosa (trabajo completo sin resultado).
 *
 * Es la foto de LA COLA, no de una persona: `gestionPorPedido` cuenta las
 * llamadas del EQUIPO. Sirve para ver si la cola se está trabajando a fondo.
 */

export interface ResumenIntentos {
  /** Llamados hoy, no contestaron, y les quedan llamadas del día. */
  aMedias: number;
  /** Llamados hoy y agotaron sus tres: trabajo completo, sin respuesta. */
  agotados: number;
  /** Resueltos hoy (confirmó o canceló), sin importar en qué intento. */
  resueltos: number;
}

const VACIO: ResumenIntentos = { aMedias: 0, agotados: 0, resueltos: 0 };

/**
 * @param gestiones las gestiones de hoy. Se acepta un iterable —
 *   `gestionPorPedido.values()` de `OrderContext`, que es un **Map**— o un
 *   objeto plano, para no obligar a quien llama a convertir nada.
 */
export function resumirIntentos(
  gestiones: Iterable<GestionDelPedido> | Record<string, GestionDelPedido> | null | undefined,
  maxDiario: number,
): ResumenIntentos {
  if (!gestiones) return VACIO;
  const lista: Iterable<GestionDelPedido> =
    typeof (gestiones as Iterable<GestionDelPedido>)[Symbol.iterator] === 'function'
      ? (gestiones as Iterable<GestionDelPedido>)
      : Object.values(gestiones as Record<string, GestionDelPedido>);
  const out: ResumenIntentos = { aMedias: 0, agotados: 0, resueltos: 0 };
  for (const g of lista) {
    if (!g || g.intentos <= 0) continue;
    if (g.ultimoResult === 'conf' || g.ultimoResult === 'canc') { out.resueltos += 1; continue; }
    if (g.ultimoResult !== 'noresp') continue;   // fila que no es un intento de llamada
    if (g.intentos >= maxDiario) out.agotados += 1;
    else out.aMedias += 1;
  }
  return out;
}

/**
 * El texto para la pantalla, o `null` si no hay nada que decir.
 *
 * Cero pedidos a medias no se anuncia: un "0 quedaron a medias" en verde ocupa
 * lugar todos los días para no decir nada, y lo que se ve siempre se deja de ver.
 */
export function textoIntentosAMedias(r: ResumenIntentos): string | null {
  if (r.aMedias <= 0) return null;
  return r.aMedias === 1
    ? '1 pedido quedó con un solo intento'
    : `${r.aMedias} pedidos quedaron con un solo intento`;
}

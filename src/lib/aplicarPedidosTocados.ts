import type { OrderData } from '@/lib/orderUtils';

/**
 * Aplica sobre la cola en memoria SOLO los pedidos que cambiaron.
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────
 * Medido en producción el 28-ago-2026, con `/seguimiento` abierto y **nadie
 * tocando nada**: 112 peticiones a la base en 60 segundos, 53 de ellas páginas
 * de la descarga COMPLETA del tablero. La causa: cualquier UPDATE en `orders`
 * disparaba `loadSegData(true)` + `loadNovedades(true)` + `loadWorkQueue()`, y
 * el cron de Dropi mueve pedidos sin parar. La consulta de la asesora quedaba
 * haciendo fila detrás de esa descarga; por eso abrir un pedido tardaba minutos.
 *
 * Ahora el realtime dice QUÉ pedido cambió, se traen esas filas con una sola
 * consulta dirigida, y esta función las aplica.
 *
 * ── Las tres reglas ─────────────────────────────────────────────────────────
 * 1. **Solo actualiza; nunca agrega ni quita.** Un pedido que no está en
 *    memoria se ignora (los nuevos llegan por INSERT, que sí recarga). Y uno
 *    que pasa a un estado terminal NO se saca: `classifySegEstado` lo manda
 *    solo a la columna de historia, que ya está plegada. Así se evita tener que
 *    reimplementar en el cliente los diez filtros negativos del SQL — una
 *    segunda definición de "qué está en la cola" se desincroniza sola, y el
 *    error se pagaría escondiendo pedidos vivos.
 * 2. **Lo que es del cliente se conserva.** `result`, `reason` y `retryCount`
 *    los pone `buildWorkQueue` desde `order_results`, no vienen en la fila de
 *    `orders`: si se pisaran con `undefined`, la gestión que la asesora acaba
 *    de marcar desaparecería de la pantalla.
 * 3. **Identidad estable.** Si una fila no cambió en nada que se vea, se
 *    devuelve la MISMA referencia, y si no cambió ninguna se devuelve el array
 *    original. Es lo que evita que el tablero se redibuje entero y le mueva el
 *    scroll a quien está trabajando.
 */

/** La clave con la que se cruzan las filas. Igual que `smartMerge`. */
const claveDe = (o: OrderData): string => o.dbId || `${o.phone}|${o.idx}`;

/**
 * Campos que, al cambiar, obligan a redibujar la tarjeta. Es la MISMA lista que
 * usa `smartMerge` en `useDataLoader`: si se separan, un cambio visible en una
 * pantalla dejaría de verse en la otra.
 */
function cambioVisible(a: OrderData, b: OrderData): boolean {
  return (
    a.estado !== b.estado ||
    a.assignedTo !== b.assignedTo ||
    a.lockedBy !== b.lockedBy ||
    a.lockedAt !== b.lockedAt ||
    a.diasConf !== b.diasConf ||
    a.dias !== b.dias ||
    a.novedad !== b.novedad ||
    a.novedadSol !== b.novedadSol ||
    a.guia !== b.guia ||
    a.transportadora !== b.transportadora ||
    a.lastMovementAt !== b.lastMovementAt ||
    a.nombre !== b.nombre ||
    a.ciudad !== b.ciudad ||
    a.direccion !== b.direccion ||
    a.valor !== b.valor
  );
}

export function aplicarPedidosTocados(prev: OrderData[], frescos: OrderData[]): OrderData[] {
  if (prev.length === 0 || frescos.length === 0) return prev;
  const porClave = new Map(frescos.map((o) => [claveDe(o), o]));
  let alguienCambio = false;
  const salida = prev.map((viejo) => {
    const nuevo = porClave.get(claveDe(viejo));
    if (!nuevo) return viejo;
    if (!cambioVisible(viejo, nuevo)) return viejo;
    alguienCambio = true;
    // Regla 2: lo que puso el cliente manda sobre lo que trae la base.
    return {
      ...nuevo,
      result: viejo.result,
      reason: viejo.reason,
      retryCount: viejo.retryCount,
    };
  });
  return alguienCambio ? salida : prev;
}

/**
 * Ids que llegaron por realtime pero NO están en memoria.
 *
 * Se usan para decidir si hace falta una recarga de verdad: si el cron trae un
 * pedido que la cola no tiene, parcharlo no alcanza. Devolverlos en vez de
 * recargar a ciegas es lo que evita volver al bucle que esto vino a cortar.
 */
export function idsDesconocidos(prev: OrderData[], ids: string[]): string[] {
  if (!ids.length) return [];
  const conocidos = new Set(prev.map((o) => String(o.dbId ?? '')));
  return ids.filter((id) => !conocidos.has(String(id)));
}

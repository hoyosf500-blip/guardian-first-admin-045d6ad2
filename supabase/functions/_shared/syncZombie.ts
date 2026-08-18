// ¿Un sync que trajo CERO pedidos está roto, o simplemente no había nada?
//
// El detector de "zombie" existe para un caso real: el cron corre, Dropi
// responde 200 y devuelve 0 pedidos, y el tablero se congela con datos viejos
// mientras el badge dice verde. Para una tienda EN OPERACIÓN, cero es sospechoso.
//
// Pero la misma condición es CIERTA y NORMAL en una tienda recién dada de alta
// que todavía no vendió nada. El 18-ago-2026, una tienda nueva de Colombia se
// conectó bien y lo primero que vio su dueño fue un banner ROJO acusando a su
// clave de Dropi de ser inválida. Nada estaba mal: no tenía pedidos.
//
// La diferencia no está en el cero, está en la historia: si Guardian nunca vio
// UN pedido de esa tienda, el cero es la respuesta correcta.
//
// ¿Y si la clave SÍ está mal en una tienda nueva? No se pierde la señal: una
// clave inválida devuelve error HTTP (que ya cae en `error`, no acá), y además
// `dropi-health` la prueba contra la API cada hora y escribe
// `last_health_status`. Ese es el detector de credenciales; éste es el de
// "el tablero se quedó quieto".

export interface SenalesDeSync {
  /** Error duro del pase (null si no hubo). */
  error?: string | null;
  /** Dropi throttleó (429). */
  throttled?: boolean;
  /** Pedidos efectivamente guardados. */
  synced: number;
  /** Filas que devolvió el pase por CAMBIO DE ESTATUS. */
  statusTotal: number;
  /** ¿Guardian tiene ALGÚN pedido de esta tienda? */
  tienePedidos: boolean;
}

/**
 * `true` solo cuando el cero es sospechoso de verdad: la tienda ya opera y aun
 * así no vino nada, sin error ni throttle que lo explique.
 */
export function esZombieReal(s: SenalesDeSync): boolean {
  if (s.error) return false;
  if (s.throttled) return false;
  if (s.synced !== 0 || s.statusTotal !== 0) return false;
  // Tienda sin un solo pedido: el cero es la verdad, no una falla.
  return s.tienePedidos;
}

/** ¿El cero se explica solo porque la tienda todavía no tiene pedidos? */
export function esTiendaSinPedidosTodavia(s: SenalesDeSync): boolean {
  return !s.error && !s.throttled && s.synced === 0 && s.statusTotal === 0 && !s.tienePedidos;
}

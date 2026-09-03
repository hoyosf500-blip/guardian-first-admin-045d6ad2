// ¿Cuántas novedades llevan más de un día esperando respuesta?
//
// ── La regla del dueño (3-sep-2026), textual ────────────────────────────────
// *"Las novedades deben estar en 0 y con este sistema no puede pasar más de
// 24 h sin dar respuesta."*
//
// Ya existía el escalón de Novedades en la escalera del turno, y ya era el
// primero después de la bandeja urgente. Lo que faltaba era el RECLAMO: la
// barra decía *"4 novedades abiertas"* igual el primer día que el tercero. Una
// novedad de hace tres horas y una de hace tres días son el mismo número y no
// son el mismo problema — la transportadora tiene el paquete parado, y cada día
// que pasa es un día más cerca de la devolución.
//
// ⛔ LA REGLA DE SIEMPRE, QUE ACÁ PESA DOBLE: un cero NUNCA sustituye a "no se
// pudo medir". Sobre este número el dueño va a hablar con una persona. Si
// ninguna novedad trae fecha legible —la columna vino vacía, el sync está
// atrasado— la respuesta es `null` y la barra no reclama nada. Decir "0 vencidas"
// sobre datos que no se leyeron es la mentira que este proyecto ya pagó tres
// veces («no hubo cancelaciones» sobre un mes con 345, «todos atendidos» sobre
// 39 esperando, y el panel de inactividad en cero porque solo contaba clics).
//
// Puro: sin red, sin React, sin reloj implícito.

/** La vara del dueño: pasadas estas horas, la novedad es un reclamo. */
export const HORAS_NOVEDAD_VENCIDA = 24;

export interface NovedadMedible {
  /** Última vez que el pedido se movió. Es lo más cercano a "desde cuándo está
   *  parado" que hay en la fila. `null` = esta novedad no se puede medir. */
  lastMovementAt?: string | null;
}

/**
 * Cuántas pasaron la vara.
 *
 * @returns el conteo, o `null` cuando NINGUNA novedad trae fecha legible —
 *          o sea, cuando no se midió nada y por lo tanto no se afirma nada.
 *          Con la cola vacía devuelve 0: ahí sí se sabe, y la respuesta es
 *          "ninguna", que es justo el estado que el dueño quiere ver.
 */
export function contarNovedadesVencidas(
  items: readonly NovedadMedible[] | null | undefined,
  ahoraMs: number,
  horas: number = HORAS_NOVEDAD_VENCIDA,
): number | null {
  const lista = items ?? [];
  if (lista.length === 0) return 0;
  const corte = ahoraMs - Math.max(0, horas) * 3_600_000;
  let vencidas = 0;
  let medidas = 0;
  for (const o of lista) {
    if (!o?.lastMovementAt) continue;
    const ms = new Date(o.lastMovementAt).getTime();
    // Una fecha rota no cuenta como medida: NaN no es un dato.
    if (!Number.isFinite(ms)) continue;
    medidas++;
    if (ms <= corte) vencidas++;
  }
  // Ni una sola fecha legible con la cola llena = no se midió. No se afirma.
  return medidas === 0 ? null : vencidas;
}

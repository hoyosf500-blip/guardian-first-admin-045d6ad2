// src/lib/cadenciaSync.ts
//
// ¿Cada cuánto se revisa DE VERDAD esta tienda contra Dropi?
//
// ── Por qué existe ──────────────────────────────────────────────────────────
// El banner de frescura decía, en texto fijo, «se actualiza solo cada 5 min».
// Medido el 21-ago-2026 sobre `sync_logs` en producción: el cron corre **cada
// 10 min**, y como reparte su presupuesto entre tiendas, a cada tienda le toca
// una corrida sí y otra no — o sea **~20 min por tienda**, cuatro veces lo que
// prometía la pantalla. Esa promesa es justamente la que hace que un pedido se
// vea "desactualizado": la asesora espera el cambio en cinco minutos, no llega,
// y concluye que Guardian está roto.
//
// Nada de esto se arregla cambiando el número por otro número fijo. El cron ya
// cambió de cadencia varias veces (5 → 15 → 10 min), el reparto depende de
// cuántas tiendas haya, y las migraciones del repo NO mandan sobre lo que está
// agendado en la base. Un texto fijo vuelve a mentir el día que alguien
// reagende el cron. Así que la cadencia **se mide** sobre las corridas reales.
//
// ── La regla ────────────────────────────────────────────────────────────────
// Si no hay corridas suficientes para medir, se devuelve `null` y la pantalla
// NO dice nada. Una frase ausente no engaña a nadie; un número inventado sí.
//
// Puro: sin red, sin React. El reloj entra por parámetro.

export interface CorridaSync {
  status: string;
  created_at: string;
}

/**
 * Minutos que suelen pasar entre una sincronización y la siguiente.
 *
 * Mide la MEDIANA de los huecos entre corridas exitosas —no el promedio— para
 * que una pausa larga (la noche, un incidente) no estire el número.
 *
 * Solo cuentan las corridas con `status='success'`: una postergación por
 * rotación entre tiendas es un intento que no sincronizó nada, y contarla haría
 * parecer la cadencia más rápida de lo que es.
 *
 * @returns minutos redondeados, o `null` si no hay con qué medir.
 */
export function cadenciaSyncMin(
  logs: readonly CorridaSync[] | null | undefined,
  now: number = Date.now(),
): number | null {
  if (!logs || logs.length === 0) return null;

  const tiempos = logs
    .filter((l) => l.status === 'success')
    .map((l) => new Date(l.created_at).getTime())
    .filter((t) => Number.isFinite(t))
    // Solo el pasado reciente: un hueco contra una corrida de hace semanas
    // describiría una operación que ya no existe.
    .filter((t) => t <= now && now - t < 24 * 60 * 60_000)
    .sort((a, b) => b - a);

  // Tres corridas = dos huecos = la mediana ya significa algo. Con dos corridas
  // habría un solo hueco y cualquier casualidad pasaría por "la cadencia".
  if (tiempos.length < 3) return null;

  const huecos: number[] = [];
  for (let i = 0; i < tiempos.length - 1; i++) {
    huecos.push((tiempos[i] - tiempos[i + 1]) / 60_000);
  }
  huecos.sort((a, b) => a - b);
  const mitad = Math.floor(huecos.length / 2);
  const mediana = huecos.length % 2
    ? huecos[mitad]
    : (huecos[mitad - 1] + huecos[mitad]) / 2;

  const min = Math.round(mediana);
  return min > 0 ? min : null;
}

/**
 * La cadencia en palabras, para ponerla al lado de "Sincronizado con Dropi".
 *
 * Devuelve `''` cuando no se pudo medir: la pantalla concatena y no dice nada.
 */
export function textoCadencia(
  logs: readonly CorridaSync[] | null | undefined,
  now: number = Date.now(),
): string {
  const min = cadenciaSyncMin(logs, now);
  if (min === null) return '';
  if (min < 60) return `se revisa sola cada ~${min} min`;
  const horas = Math.round(min / 60);
  return `se revisa sola cada ~${horas} ${horas === 1 ? 'hora' : 'horas'}`;
}

/**
 * Bounds de un rango de días CALENDARIO en hora Bogotá/Quito (UTC-5, sin DST;
 * CO y EC comparten wall-clock).
 *
 * Por qué: `dropi_wallet_movements.fecha` es timestamptz con la hora real del
 * movimiento (el sync convierte hora local → UTC, +5h). Los hooks armaban
 * bounds `T00:00:00Z`/`T23:59:59Z` (UTC), que corresponden a las 7pm del día
 * ANTERIOR en Bogotá → los movimientos de 19:00-24:00 locales caían al día
 * siguiente del filtro (auditoría 2026-07-07).
 */
export function bogotaDayBounds(from: string, to: string): { fromTs: string; toTs: string } {
  return {
    fromTs: `${from}T00:00:00-05:00`,
    toTs: `${to}T23:59:59.999-05:00`,
  };
}

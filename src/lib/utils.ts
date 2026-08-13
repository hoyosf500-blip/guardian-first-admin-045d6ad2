import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Fecha de hoy en Bogotá (YYYY-MM-DD). El servidor usa
// (NOW() AT TIME ZONE 'America/Bogota')::date. Si el cliente usara la zona
// del navegador, un PC con hora mal o TZ distinta descuadra stats y cierre.
//
// ⚠️ LÍMITE CONOCIDO (Guatemala, UTC-6): CO y EC son UTC-5 = misma hora que
// Bogotá, así que el corte de día es correcto. GT es UTC-6: entre las 23:00 y la
// medianoche hora GT, esto ya cuenta el día siguiente. NO se corrige acá a
// América/Guatemala a propósito: el servidor (todas las RPC de reportes/cierre/
// contadores) sigue clavado a 'America/Bogota', y mover SOLO el cliente crearía
// una inconsistencia peor (el cliente marca un día, el servidor otro, para el
// mismo pedido de las 23:30 GT). El fix correcto es coordinado cliente+servidor
// (pasar la TZ de la tienda a esas RPC) — pendiente, ver auditoría 2026-08-13.
export function bogotaToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
}

// ── Moneda por país de la tienda activa (multi-tienda CO/EC) ──
// Mismo patrón module-level que setTrackingCountry (orderUtils): StoreContext
// setea el país UNA vez y todos los call-sites de formatCOP formatean acorde,
// sin threading del countryCode. EC opera en USD CON CENTAVOS — formatearlo
// como COP sin decimales borraba los centavos de cada cifra (auditoría
// 2026-07-02: imposible cuadrar contra Dropi que sí muestra $4.734,53).
// GT opera en quetzales (GTQ, con centavos) — mismo motivo que EC: formatearlo
// como COP entero borraría los centavos y nada cuadraría contra Dropi.
export type PaisMoneda = 'CO' | 'EC' | 'GT';

let _activeCurrencyCountry: PaisMoneda = 'CO';

export function setCurrencyCountry(country?: string | null): void {
  const cc = String(country || '').toUpperCase();
  _activeCurrencyCountry = cc === 'EC' ? 'EC' : cc === 'GT' ? 'GT' : 'CO';
}

export function getCurrencyCountry(): PaisMoneda {
  return _activeCurrencyCountry;
}

/** ¿La moneda del país tiene CENTAVOS (2 decimales)? CO usa pesos enteros; EC
 *  (USD) y GT (GTQ) usan centavos. Fuente única para no repetir el ternario
 *  `=== 'EC'` por todos lados (que dejaba a Guatemala redondeando a entero y
 *  perdiendo los centavos del total a recaudar). */
export function paisUsaCentavos(countryCode?: string | null): boolean {
  const cc = String(countryCode || '').toUpperCase();
  return cc === 'EC' || cc === 'GT';
}

// OLD-4: formatea un número como la moneda de la tienda activa (COP entero para
// CO, USD con 2 decimales para EC, GTQ con 2 decimales para GT). Usar siempre
// este helper en vez de `valor.toLocaleString()` solo — el segundo respeta el
// locale del navegador (en-US imprime "1,500,000" en vez de "$1.500.000").
export function formatCOP(n: number | null | undefined): string {
  if (_activeCurrencyCountry === 'EC') {
    if (n == null || !isFinite(n)) return '$0,00';
    return new Intl.NumberFormat('es-EC', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n);
  }
  if (_activeCurrencyCountry === 'GT') {
    if (n == null || !isFinite(n)) return 'Q0.00';
    return new Intl.NumberFormat('es-GT', {
      style: 'currency',
      currency: 'GTQ',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n);
  }
  if (n == null || !isFinite(n)) return '$0';
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  }).format(n);
}


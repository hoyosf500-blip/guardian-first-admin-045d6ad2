import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Fecha de hoy en Bogotá (YYYY-MM-DD). El servidor usa
// (NOW() AT TIME ZONE 'America/Bogota')::date. Si el cliente usara la zona
// del navegador, un PC con hora mal o TZ distinta descuadra stats y cierre.
export function bogotaToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
}

// ── Moneda por país de la tienda activa (multi-tienda CO/EC) ──
// Mismo patrón module-level que setTrackingCountry (orderUtils): StoreContext
// setea el país UNA vez y todos los call-sites de formatCOP formatean acorde,
// sin threading del countryCode. EC opera en USD CON CENTAVOS — formatearlo
// como COP sin decimales borraba los centavos de cada cifra (auditoría
// 2026-07-02: imposible cuadrar contra Dropi que sí muestra $4.734,53).
let _activeCurrencyCountry: 'CO' | 'EC' = 'CO';

export function setCurrencyCountry(country?: string | null): void {
  _activeCurrencyCountry = country === 'EC' ? 'EC' : 'CO';
}

export function getCurrencyCountry(): 'CO' | 'EC' {
  return _activeCurrencyCountry;
}

// OLD-4: formatea un número como la moneda de la tienda activa (COP entero para
// CO, USD con 2 decimales para EC). Usar siempre este helper en vez de
// `valor.toLocaleString()` solo — el segundo respeta el locale del navegador
// (en-US imprime "1,500,000" en vez de "$1.500.000" para COP).
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
  if (n == null || !isFinite(n)) return '$0';
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  }).format(n);
}

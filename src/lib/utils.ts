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

// OLD-4: formatea un número como peso colombiano. Usar siempre este helper
// en vez de `valor.toLocaleString()` solo — el segundo respeta el locale
// del navegador (en-US imprime "1,500,000" en vez de "$1.500.000" para COP).
export function formatCOP(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return '$0';
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  }).format(n);
}

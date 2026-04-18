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

/**
 * Logos REALES de transportadoras, empaquetados en el build (src/assets/
 * carriers/*.png, bajados de los sitios oficiales el 2026-07-29). Nada se
 * pide a internet en runtime: si mañana un sitio cambia o se cae, el CRM ni
 * se entera. Transportadora sin logo (p.ej. VELOCES, interna de Dropi, sin
 * sitio público) → la UI cae a las iniciales de siempre.
 *
 * `fit` dice cómo va el logo dentro del badge:
 *  - 'contain': marca con fondo transparente → centrada sobre círculo blanco.
 *  - 'cover': ícono cuadrado con fondo propio (Gintracom negro) → llena el
 *    círculo completo, como los badges redondos del panel de Dropi.
 *  - 'wide': wordmark horizontal (Laar) → chip redondeado ancho, no círculo.
 */
import servientrega from '@/assets/carriers/servientrega.png';
import laarcourier from '@/assets/carriers/laarcourier.png';
import gintracom from '@/assets/carriers/gintracom.png';
import interrapidisimo from '@/assets/carriers/interrapidisimo.png';
import coordinadora from '@/assets/carriers/coordinadora.png';
import envia from '@/assets/carriers/envia.png';
import tcc from '@/assets/carriers/tcc.png';
import domina from '@/assets/carriers/domina.png';

export interface CarrierLogo {
  src: string;
  fit: 'contain' | 'cover' | 'wide';
}

const LOGOS: Record<string, CarrierLogo> = {
  SERVIENTREGA: { src: servientrega, fit: 'contain' },
  LAARCOURIER: { src: laarcourier, fit: 'wide' },
  GINTRACOM: { src: gintracom, fit: 'cover' },
  INTERRAPIDISIMO: { src: interrapidisimo, fit: 'cover' },
  COORDINADORA: { src: coordinadora, fit: 'contain' },
  ENVIA: { src: envia, fit: 'contain' },
  TCC: { src: tcc, fit: 'contain' },
  DOMINA: { src: domina, fit: 'contain' },
};

/** Normaliza para matchear: sin acentos, mayúsculas, solo A-Z0-9. Así
 *  "Inter Rapidísimo" y "INTERRAPIDISIMO" caen en la misma clave. */
function norm(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/** Logo de la transportadora, o null si no tenemos (→ iniciales). */
export function carrierLogo(name: string | null | undefined): CarrierLogo | null {
  if (!name) return null;
  const n = norm(name);
  if (!n) return null;
  for (const key of Object.keys(LOGOS)) {
    if (n.includes(key)) return LOGOS[key];
  }
  return null;
}

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Guardián de contraste de los tokens de color.
 *
 * Existe porque el tema claro se rompió EN SILENCIO: nadie lo miraba (los
 * operadores trabajan en oscuro), y `text-warning` sobre blanco llegó a estar
 * en 1.98:1 — ilegible — con 184 usos en la app. Un test que lee el CSS de
 * verdad es lo único que avisa cuando alguien afina un token "a ojo".
 *
 * Lee `src/index.css` en lugar de duplicar los valores acá: si se copiaran,
 * el test podría pasar mientras la app se ve mal, que es exactamente el
 * problema que vino a resolver.
 */

const CSS = readFileSync(resolve(__dirname, '../index.css'), 'utf-8');

type Hsl = [number, number, number];
type Rgb = [number, number, number];

/** Aísla el cuerpo de un bloque `:root {…}` / `.dark {…}` contando llaves. */
function bloque(selector: string): string {
  const i = CSS.indexOf(selector);
  if (i === -1) throw new Error(`No se encontró el selector ${selector} en index.css`);
  let profundidad = 0;
  let inicio: number | null = null;
  for (let j = i; j < CSS.length; j++) {
    if (CSS[j] === '{') {
      profundidad++;
      if (inicio === null) inicio = j;
    } else if (CSS[j] === '}') {
      profundidad--;
      if (profundidad === 0) return CSS.slice(inicio!, j);
    }
  }
  throw new Error(`Bloque ${selector} sin cerrar`);
}

function tokens(texto: string): Record<string, Hsl> {
  const out: Record<string, Hsl> = {};
  const re = /--([a-z0-9-]+):\s*(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(texto)) !== null) {
    out[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])];
  }
  return out;
}

function hslToRgb([h, s, l]: Hsl): Rgb {
  const sn = s / 100;
  const ln = l / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = ln - c / 2;
  let rgb: Rgb;
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return [rgb[0] + m, rgb[1] + m, rgb[2] + m];
}

function luminancia([r, g, b]: Rgb): number {
  const f = (v: number) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contraste(a: Hsl, b: Hsl): number {
  const l1 = luminancia(hslToRgb(a));
  const l2 = luminancia(hslToRgb(b));
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** Mezcla `color` al `alpha` indicado sobre `fondo` — simula `bg-success/16`. */
function tinte(color: Hsl, fondo: Hsl, alpha: number): Rgb {
  const c = hslToRgb(color);
  const f = hslToRgb(fondo);
  return [0, 1, 2].map(i => c[i] * alpha + f[i] * (1 - alpha)) as Rgb;
}

function contrasteRgb(a: Rgb, b: Rgb): number {
  const l1 = luminancia(a);
  const l2 = luminancia(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

const CLARO = tokens(bloque('  :root {'));
const OSCURO = tokens(bloque('  .dark {'));

const AA = 4.5;
// El tinte más fuerte que usa la app (los chips `bg-<estado>/16`), que es el
// caso más duro: el fondo se acerca al color del texto y el contraste baja.
const ALPHA_CHIP = 0.16;

const ESTADOS = ['success', 'warning', 'danger', 'info', 'attention', 'cyan', 'ai', 'accent', 'primary'];

describe('contraste de los tokens de tema', () => {
  it('los dos bloques de tokens se leen desde index.css', () => {
    expect(Object.keys(CLARO).length).toBeGreaterThan(20);
    expect(Object.keys(OSCURO).length).toBeGreaterThan(20);
    // Si esto falla, el parser dejó de encajar con el CSS y el resto del
    // archivo estaría dando falsos OK sobre un objeto vacío.
    expect(CLARO.background).toBeDefined();
    expect(OSCURO.background).toBeDefined();
  });

  describe.each([
    ['claro', CLARO],
    ['oscuro', OSCURO],
  ])('tema %s', (_nombre, T) => {
    it('el texto base y el secundario pasan AA sobre el fondo de página', () => {
      expect(contraste(T.foreground, T.background)).toBeGreaterThanOrEqual(AA);
      expect(contraste(T['muted-foreground'], T.background)).toBeGreaterThanOrEqual(AA);
      // --subtle viste .hud-label, que son 10px: sin excepción de texto grande.
      expect(contraste(T.subtle, T.background)).toBeGreaterThanOrEqual(AA);
    });

    it.each(ESTADOS)('text-%s pasa AA sobre la página y sobre una card', estado => {
      if (!T[estado]) return;
      expect(contraste(T[estado], T.background)).toBeGreaterThanOrEqual(AA);
      expect(contraste(T[estado], T.card)).toBeGreaterThanOrEqual(AA);
    });

    it.each(ESTADOS)('text-%s pasa AA sobre su propio chip tintado', estado => {
      if (!T[estado]) return;
      const color = hslToRgb(T[estado]);
      // El chip se dibuja tanto sobre la página como sobre una card.
      expect(contrasteRgb(color, tinte(T[estado], T.background, ALPHA_CHIP))).toBeGreaterThanOrEqual(AA);
      expect(contrasteRgb(color, tinte(T[estado], T.card, ALPHA_CHIP))).toBeGreaterThanOrEqual(AA);
    });

    it.each(ESTADOS)('bg-%s pasa AA contra el -foreground que tiene declarado', estado => {
      const fg = T[`${estado}-foreground`];
      if (!T[estado] || !fg) return;
      expect(contraste(T[estado], fg)).toBeGreaterThanOrEqual(AA);
    });
  });
});

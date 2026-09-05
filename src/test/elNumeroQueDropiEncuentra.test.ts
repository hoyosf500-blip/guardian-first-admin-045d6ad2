import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * GUARDIÁN: Guardian no le puede dar al equipo un número que Dropi no encuentra.
 *
 * ── Medido el 4-sep-2026 contra el panel real de Dropi (cuenta de Ecuador) ──
 * `textToSearch` es coincidencia por SUBCADENA sobre lo que Dropi guarda (9
 * dígitos limpios), así que cualquier prefijo devuelve CERO:
 *
 *     967107198     → 2 pedidos        +593967107198 → 0
 *     67107198      → 2 pedidos        0967107198    → 0
 *     nombre        → 2 pedidos        096 710 7198  → 0
 *
 * ── Por qué es un bug de Guardian y no de Dropi ────────────────────────────
 * El operador lo dijo con todas las letras: *"los cargo en dropi… pero antes de
 * subirlos, verifico que no estén ya en dropi para evitar duplicados"*. Ese
 * chequeo es correcto — el problema es que Guardian le daba el número EN EL
 * FORMATO QUE NO SIRVE: medido en /confirmar ese día, **15 de los 16 teléfonos
 * en pantalla eran `+593…`**. Copiaba de acá, pegaba allá, no aparecía nada, y
 * cargaba el duplicado sobre uno que ya existía.
 *
 * De los 21 duplicados de la quincena, 5 son exactamente esa forma: Guardian ya
 * lo había creado y la persona no lo vio.
 */

const raiz = resolve(__dirname, '../..');
const leer = (p: string) => readFileSync(resolve(raiz, p), 'utf8');

const PANEL = 'src/components/confirmar/ShopifyPendingPanel.tsx';
const LIB = 'src/lib/busquedaTelefono.ts';

describe('el botón de copiar entrega lo que Dropi encuentra', () => {
  it('⛔ copia la forma canónica, no el `+593…` que se ve', () => {
    const s = leer(PANEL);
    expect(s).toContain('telefonoParaBuscarEnDropi');
    expect(
      /const paraDropi = telefonoParaBuscarEnDropi\(phone\)/.test(s),
      'copiar el teléfono crudo le da al equipo un término de búsqueda que devuelve cero',
    ).toBe(true);
    expect(/copiarAlPortapapeles\(paraDropi\)/.test(s)).toBe(true);
  });

  it('copiar algo distinto de lo que se ve NO puede ser una sorpresa', () => {
    const s = leer(PANEL);
    // El title lo anticipa…
    expect(/title=\{telefonoParaBuscarEnDropi\(p\.phone\) !== p\.phone/.test(s)).toBe(true);
    // …y al copiar se dice qué se copió, solo cuando difiere.
    expect(/if \(paraDropi !== phone\)[\s\S]{0,220}toast\.success/.test(s)).toBe(true);
  });

  it('si no se pudo copiar, el número a transcribir es el BUENO', () => {
    const s = leer(PANEL);
    expect(/No se pudo copiar el teléfono[\s\S]{0,140}\$\{paraDropi\}/.test(s)).toBe(true);
  });

  it('la franja del duplicado da los dígitos exactos, no solo el consejo', () => {
    const s = leer(PANEL);
    const i = s.indexOf('Buscá en Dropi con estos dígitos');
    expect(i).toBeGreaterThan(-1);
    expect(s.slice(i, i + 400)).toContain('telefonoParaBuscarEnDropi(p.phone)');
  });
});

describe('la regla vive en un solo lado y está medida', () => {
  it('el helper existe y documenta lo que se midió contra Dropi', () => {
    const s = leer(LIB);
    expect(s).toContain('export function telefonoParaBuscarEnDropi');
    // Las mediciones que justifican la regla quedan escritas: sin ellas, el
    // próximo que lea esto va a pensar que es una preferencia de formato.
    expect(s).toContain('967107198');
    expect(s).toMatch(/\+593967107198\s+→ 0/);
  });

  it('⛔ reusa normalizePhone: no hay una normalización nueva', () => {
    const s = leer(LIB);
    expect(s).toMatch(/import \{ normalizePhone \} from '\.\/phone'/);
    expect(
      /telefonoParaBuscarEnDropi[\s\S]{0,300}normalizePhone\(phone\)/.test(s),
      'este proyecto ya tiene 15 normalizaciones de teléfono; la 16 no ayuda a nadie',
    ).toBe(true);
  });

  it('nunca devuelve vacío si hay dígitos: mostrar nada es peor que mostrar el crudo', () => {
    const s = leer(LIB);
    expect(/return canonico\.length >= 7 \? canonico : String\(phone \?\? ''\)\.replace/.test(s)).toBe(true);
  });
});

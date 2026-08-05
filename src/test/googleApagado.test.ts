import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { GOOGLE_PLACES_ENABLED } from '@/lib/featureFlags';

/**
 * Guardián: que Google no se vuelva a prender solo.
 *
 * El dueño apagó Google el 22-may-2026. Durante MÁS DE DOS MESES se siguió
 * pagando igual, y nadie podía verlo desde adentro de la app: el flag del
 * navegador cortaba dos caminos (`CallView`, `CrmCallView`) pero no el tercero
 * —`useAddressValidation`, que usa el badge de dirección que va DENTRO de esas
 * mismas pantallas—. El CLAUDE.md afirmaba en cuatro lugares que la función
 * estaba "dormida". No lo estaba.
 *
 * La factura de Google llega un mes tarde: para cuando se nota, ya se pagó. Por
 * eso esto se vigila con una prueba y no con un comentario.
 *
 * Un archivo NUEVO que llame a las edge functions de Google sin preguntar por el
 * flag hace fallar esta prueba. Si alguna vez se quiere prender de verdad, se
 * cambia `GOOGLE_PLACES_ENABLED` a true y esta prueba se hace a un lado sola.
 */

const RAIZ = 'src';
const EDGE_DE_GOOGLE = ['dropi-validate-address', 'google-places-proxy'];

function archivos(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) archivos(p, out);
    else if ((e.endsWith('.ts') || e.endsWith('.tsx')) && !e.includes('.test.')) out.push(p);
  }
  return out;
}

/** Quita comentarios de línea y de bloque: los nombres de las funciones
 *  aparecen en la documentación de varios archivos y no son llamadas. */
function sinComentarios(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('Google apagado: que nadie lo prenda sin querer', () => {
  it('el flag sigue apagado (si se prende a propósito, esta prueba deja de aplicar)', () => {
    expect(GOOGLE_PLACES_ENABLED).toBe(false);
  });

  it('ningún archivo llama a las edge functions de Google sin mirar el flag', () => {
    if (GOOGLE_PLACES_ENABLED) return;  // prendido a propósito: no hay nada que vigilar
    const culpables: string[] = [];
    for (const f of archivos(RAIZ)) {
      const code = sinComentarios(readFileSync(f, 'utf8'));
      const llama = EDGE_DE_GOOGLE.some((fn) => code.includes(`'${fn}'`) || code.includes(`"${fn}"`));
      if (!llama) continue;
      if (!code.includes('GOOGLE_PLACES_ENABLED')) {
        culpables.push(f.replace(/\\/g, '/'));
      }
    }
    expect(culpables).toEqual([]);
  });

  // El caso REAL, para que la prueba demuestre que sabe cazarlo: así estaba
  // escrito `useAddressValidation` hasta el 4-ago-2026.
  it('sí detecta el patrón que estuvo cobrando dos meses', () => {
    const codigoViejo = `
      const { data } = await supabase.functions.invoke('dropi-validate-address', { body });
    `;
    const code = sinComentarios(codigoViejo);
    const llama = EDGE_DE_GOOGLE.some((fn) => code.includes(`'${fn}'`));
    expect(llama && !code.includes('GOOGLE_PLACES_ENABLED')).toBe(true);
  });
});

describe('el candado del servidor existe y está cerrado', () => {
  // Segundo candado, independiente del navegador: aunque un Publish vuelva a
  // llamar a estas funciones, sin `GOOGLE_ENABLED=true` en los secretos no se
  // gasta un centavo.
  it('las dos edge functions preguntan por GOOGLE_ENABLED', () => {
    for (const fn of EDGE_DE_GOOGLE) {
      const src = readFileSync(`supabase/functions/${fn}/index.ts`, 'utf8');
      expect(src, `${fn} no tiene el candado`).toContain('GOOGLE_ENABLED');
    }
  });

  it('el candado se abre solo con "true" explícito, no con cualquier valor', () => {
    for (const fn of EDGE_DE_GOOGLE) {
      const src = readFileSync(`supabase/functions/${fn}/index.ts`, 'utf8');
      // Comparación contra la cadena "true": una variable presente pero vacía
      // (o con cualquier otro valor) tiene que dejarlo APAGADO.
      expect(src, `${fn} no compara contra "true"`).toMatch(/GOOGLE_ENABLED[\s\S]{0,120}?"true"/);
    }
  });
});

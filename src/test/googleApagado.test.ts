import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
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
 *  aparecen en la documentación de varios archivos y no son llamadas.
 *
 *  El `(?<!:)` NO es un detalle de estilo. Sin él, el `//` de `https://` se
 *  tomaba por comentario y se borraba el resto de la línea — con lo cual
 *  `https://addressvalidation.googleapis.com/...` quedaba en `https:` y una
 *  comprobación de "no debe contener googleapis.com" pasaba en verde CON el
 *  código de Google presente. La prueba se creía guardiana y no vigilaba nada. */
function sinComentarios(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/[^\n]*/g, '');
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

// ═══════════════════════════════════════════════════════════════════════════
// 6-ago-2026 — SE PASÓ DE APAGAR A BORRAR.
//
// Hasta hoy esto vigilaba que Google estuviera APAGADO: un flag de cliente más
// un candado server-side (`GOOGLE_ENABLED`). Eran dos interruptores, y un
// interruptor es un PEDIDO: seguía existiendo un camino a la tarjeta (un secreto
// mal puesto, un prompt a Lovable, un archivo nuevo).
//
// El dueño pidió sacarla definitivamente. Ahora se vigila la AUSENCIA del
// código, que no depende de que ninguna configuración esté bien.
// ═══════════════════════════════════════════════════════════════════════════

describe('Google ELIMINADO: que no vuelva a existir el camino', () => {
  it('la edge function google-places-proxy ya no existe', () => {
    // Era un proxy PURO a Google: toda llamada que entraba era plata que salía.
    expect(existsSync('supabase/functions/google-places-proxy')).toBe(false);
  });

  it('ninguna edge function llama a Google ni a Anthropic', () => {
    const dir = 'supabase/functions';
    const culpables: string[] = [];
    for (const fn of readdirSync(dir)) {
      const idx = join(dir, fn, 'index.ts');
      if (!statSync(join(dir, fn)).isDirectory() || !existsSync(idx)) continue;
      const code = sinComentarios(readFileSync(idx, 'utf8'));
      // `ai-order-assistant` y `wa-ai-responder` usan IA a propósito y con
      // presupuesto del dueño; lo que se vigila acá es el validador de
      // direcciones, que gastaba sin que nadie lo hubiera pedido.
      if (fn === 'ai-order-assistant' || fn === 'wa-ai-responder' || fn === 'wa-webhook') continue;
      if (/googleapis\.com|GOOGLE_MAPS_API_KEY|api\.anthropic\.com/.test(code)) {
        culpables.push(fn);
      }
    }
    expect(culpables).toEqual([]);
  });

  it('el validador de direcciones corre 100% gratis', () => {
    const src = sinComentarios(
      readFileSync('supabase/functions/dropi-validate-address/index.ts', 'utf8'),
    );
    // Nada pago…
    expect(src).not.toContain('googleapis.com');
    expect(src).not.toContain('GOOGLE_MAPS_API_KEY');
    expect(src).not.toContain('api.anthropic.com');
    expect(src).not.toContain('consume_google_quota');
    // …pero el camino gratis sigue en pie: sin esto el semáforo se quedaría sin
    // geocoding y "eliminar el gasto" habría significado romper la validación.
    expect(src).toContain('nominatim.openstreetmap.org');
  });

  it('el cliente no puede llamar a Google: el hook es inerte', () => {
    const src = sinComentarios(readFileSync('src/hooks/useGooglePlaces.ts', 'utf8'));
    expect(src).not.toContain('google-places-proxy');
    expect(src).not.toContain('functions.invoke');
    expect(src).toContain('available: false');
  });
});

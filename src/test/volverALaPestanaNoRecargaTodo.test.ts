import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * GUARDIÁN: volver a la pestaña no recarga todo Seguimiento, y Productividad
 * no hace cuatro viajes en fila donde alcanzan dos.
 *
 * ── Lo que se encontró leyendo el código (5-sep-2026) ──────────────────────
 * «Seguimiento, Productividad y demás se demoran en cargar.»
 *
 *  1. `useDataLoader` tenía su poll de 15 min con `runOnVisible: true` y SIN
 *     piso: CADA vuelta a la pestaña —la asesora alterna con WhatsApp Web y
 *     Dropi decenas de veces por hora— relanzaba la carga COMPLETA de la cola
 *     de Seguimiento (páginas de 1.000 pedidos en fila + devoluciones + sin
 *     estado, ~500 KB por vuelta en Ecuador), desde CUALQUIER página, porque el
 *     loader vive en OrderContext y la barra «Lo que sigue» lo dispara en
 *     todas. El realtime ya mantiene la cola al día entre medio; la recarga al
 *     volver es una red de seguridad, no la fuente. Ahora tiene piso.
 *
 *  2. `ProductivityDashboard.load()` hacía: set_active_store → 4 RPCs en
 *     paralelo → contador de order_results → cierres de turno. Cuatro esperas
 *     en fila; las dos últimas no dependen de nada de lo anterior. Van en el
 *     mismo `Promise.all` que las RPCs.
 */

const RAIZ = join(__dirname, '..', '..');
const leer = (rel: string) => readFileSync(join(RAIZ, rel), 'utf8');
function sinComentarios(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

/** Del `(` que sigue a `desde` hasta su `)` de cierre, con anidamiento. */
function llamadaBalanceada(texto: string, desde: number): string {
  const abre = texto.indexOf('(', desde);
  let nivel = 0;
  for (let i = abre; i < texto.length; i++) {
    const c = texto[i];
    if (c === '(' || c === '[' || c === '{') nivel++;
    else if (c === ')' || c === ']' || c === '}') {
      nivel--;
      if (nivel === 0) return texto.slice(desde, i + 1);
    }
  }
  return texto.slice(desde);
}

describe('volver a la pestaña no recarga todo', () => {
  it('pollWhenVisible acepta un piso para la corrida al volver, y lo aplica solo ahí', () => {
    const p = sinComentarios(leer('src/lib/pollWhenVisible.ts'));
    expect(p).toMatch(/pisoVisibleMs/);
    // El piso gobierna la rama de visibilidad; el intervalo periódico no lo mira.
    const visible = p.slice(p.indexOf('const onVisibility'));
    expect(visible).toMatch(/runOnVisible && Date\.now\(\) - ultimaCorrida >= pisoVisibleMs/);
  });

  it('el poll de la cola de Seguimiento vuelve con piso de por lo menos 2 minutos', () => {
    const d = sinComentarios(leer('src/hooks/useDataLoader.ts'));
    const m = d.match(/const PISO_VOLVER_MS = (\d+) \* 60_000/);
    expect(m, 'el piso tiene que estar escrito en minutos, como constante').not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(2);
    const i = d.indexOf('pollWhenVisible(');
    expect(i).toBeGreaterThan(-1);
    const llamada = llamadaBalanceada(d, i);
    expect(llamada).toMatch(/runOnVisible: true/);
    expect(llamada).toMatch(/pisoVisibleMs: PISO_VOLVER_MS/);
  });
});

describe('Productividad: dos viajes, no cuatro', () => {
  const tab = sinComentarios(leer('src/components/admin/ProductivityDashboard.tsx'));

  it('el contador de acciones y los cierres de turno salen en el MISMO Promise.all que las RPCs', () => {
    const i = tab.indexOf('await Promise.all([');
    expect(i).toBeGreaterThan(-1);
    const bloque = llamadaBalanceada(tab, tab.indexOf('Promise.all', i));
    expect(bloque).toMatch(/'operator_productivity_stats'/);
    expect(bloque).toMatch(/\.from\('order_results'\)/);
    expect(bloque).toMatch(/\.from\('operator_daily_reports'\)/);
  });

  it('y ninguna de las dos se espera aparte después', () => {
    const despues = tab.slice(tab.indexOf('await Promise.all(['));
    // Un `await supabase\n .from('order_results')` suelto sería el viaje de más.
    expect(despues).not.toMatch(/await supabase\s*\.from\('order_results'\)/);
    expect(despues).not.toMatch(/await supabase\s*\.from\('operator_daily_reports'\)/);
  });
});

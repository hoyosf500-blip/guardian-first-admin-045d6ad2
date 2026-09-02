import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * PRUEBA GUARDIANA — el panel "sin pasar a Dropi" de Confirmar.
 *
 * Sale de tres síntomas que reportó el dueño el 2-sep-2026, con plata y con
 * gente de por medio:
 *
 *  1. "no me salían, me tocó actualizar" — el panel refrescaba cada 15 min y con
 *     `runOnVisible: false`, así que al volver de otra pestaña NO se refrescaba
 *     nunca. Un pedido nuevo podía quedar invisible un cuarto de hora.
 *  2. "eso siempre debe estar visible sin ocultarse" — la lista nacía cerrada en
 *     cada recarga.
 *  3. "el asesor marca ya lo metí y no me sale, ayer regañé a uno injustamente" —
 *     lo marcado se guardaba en `shopify_manual_marks` pero NUNCA se leía de
 *     vuelta: el panel escondía filas solo con el `done` de localStorage, que es
 *     de ESE navegador. La asesora marcaba y en la pantalla del dueño seguía en
 *     rojo.
 *
 * Si una de estas se pone roja, el problema es tu cambio, no la prueba.
 */

const PANEL = join(process.cwd(), 'src/components/confirmar/ShopifyPendingPanel.tsx');
const src = readFileSync(PANEL, 'utf8');

/** Quita comentarios de línea sin confundir el `//` de `https://`. */
function sinComentarios(t: string): string {
  return t.replace(/(?<!:)\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}
const codigo = sinComentarios(src);

describe('panel de pendientes de Shopify: se ve y se comparte', () => {
  it('el poll de pendientes se refresca al volver a la pestaña', () => {
    const poll = codigo.match(/pollWhenVisible\([^;]*?\)/s);
    expect(poll, 'el panel debe seguir usando pollWhenVisible').not.toBeNull();
    expect(
      /runOnVisible:\s*false/.test(poll![0]),
      'runOnVisible:false deja la cola congelada al volver de otra pestaña — fue el bug del 2-sep-2026',
    ).toBe(false);
  });

  it('no vuelve a un intervalo largo que esconda ventas nuevas', () => {
    const m = codigo.match(/pollWhenVisible\([^,]+,\s*(\d+)\s*\*\s*60_?000/);
    expect(m, 'el intervalo del poll debe estar escrito en minutos').not.toBeNull();
    const minutos = Number(m![1]);
    expect(
      minutos,
      `el poll está en ${minutos} min; arriba de 5 el dueño vuelve a tener que apretar Actualizar`,
    ).toBeLessThanOrEqual(5);
  });

  it('la lista de pendientes arranca abierta', () => {
    expect(
      /function loadExpanded/.test(codigo),
      'debe existir loadExpanded para recordar/abrir la lista',
    ).toBe(true);
    // Sin preferencia guardada, abierta.
    expect(/v === null \? true/.test(codigo)).toBe(true);
    expect(
      /useState\(false\)[^\n]*\n?/.test(codigo) && /const \[expanded, setExpanded\] = useState\(false\)/.test(codigo),
      'expanded no puede volver a nacer en false a secas',
    ).toBe(false);
  });

  it('lo que marca una asesora se esconde también para los demás', () => {
    expect(
      /markedIds/.test(codigo),
      'el panel debe leer las marcas guardadas en la base (shopify_manual_marks)',
    ).toBe(true);
    // El filtro de lo visible tiene que mirar AMBOS: el local y el de la base.
    const filtro = codigo.match(/const visible = useMemo\([\s\S]{0,220}?\);/);
    expect(filtro, 'no se encontró el cálculo de `visible`').not.toBeNull();
    expect(
      /done\.has\(p\.id\)/.test(filtro![0]) && /markedIds\.has\(p\.id\)/.test(filtro![0]),
      '`visible` debe excluir lo marcado en la base, no solo el localStorage de este navegador',
    ).toBe(true);
  });

  it('las marcas de la base se refrescan junto con la cola', () => {
    expect(
      /refetchMarks/.test(codigo),
      'sin refrescar las marcas, el dueño ve la marca de la asesora recién al recargar',
    ).toBe(true);
  });
});

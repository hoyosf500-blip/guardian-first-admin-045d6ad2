import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ⛔ GUARDIÁN — la bitácora registra TODO lo que hace la asesora, en TODAS las colas.
 *
 * El 4-sep-2026 se encontró que `marco`, `edito` y `leyo_chat` estaban en el
 * vocabulario (`eventosPedido.ts`) y NADIE los emitía, y que `usePedidoALaVista`
 * solo estaba montado en Novedades. Resultado: /actividad le decía a la que
 * resolvió 30 novedades "abrió 30 · gestionó 0", y la confirmadora que pasó
 * 8 h llamando salía con la lista vacía. Sobre esos números el dueño habla con
 * una persona.
 *
 * Esta prueba lee el fuente y exige que cada acción tenga su emisor. Si alguien
 * la pone en rojo, el problema es su cambio: una acción dejó de dejar rastro.
 */

const SRC = join(process.cwd(), 'src');
const leer = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const sinComentarios = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/(?<!:)\/\/.*$/, ''))
    .join('\n');

describe('⛔ la bitácora registra todo lo que hace la asesora', () => {
  it('marcar un resultado y deshacerlo dejan rastro (OrderContext)', () => {
    const src = sinComentarios(leer('contexts/OrderContext.tsx'));
    expect(src, 'markResult ya no emite marco').toMatch(/bitacoraRef\.current\(\s*'marco'/);
    expect(src, 'undoLast ya no emite deshizo').toMatch(/bitacoraRef\.current\(\s*'deshizo'/);
    // El DELETE va PRIMERO y el rastro dice lo que pasó (revisión 3-sep-2026):
    // con el estado optimista aplicado antes de borrar, un DELETE rechazado
    // dejaba el pedido "sin resultado" en pantalla y la asesora lo marcaba dos
    // veces. Se exige: el borrado antes de cualquier setWorkQueue del undo, y
    // DOS deshizo — uno con ok:false en la rama del error y uno con ok:true.
    const iUndo = src.indexOf('const undoLast');
    const cuerpo = src.slice(iUndo, src.indexOf('const resetOrders', iUndo));
    const iDelete = cuerpo.indexOf("from('order_results').delete()");
    const iOptimista = cuerpo.indexOf('setWorkQueue(');
    expect(iUndo).toBeGreaterThan(-1);
    expect(iDelete, 'undoLast ya no borra el resultado').toBeGreaterThan(-1);
    expect(iOptimista, 'undoLast ya no limpia el resultado en pantalla').toBeGreaterThan(-1);
    expect(iDelete, 'el estado optimista se aplica ANTES de borrar en la base').toBeLessThan(iOptimista);
    const deshizos = cuerpo.match(/bitacoraRef\.current\(\s*'deshizo'/g) ?? [];
    expect(deshizos.length, 'undoLast tiene que dejar rastro tanto si borró como si no pudo').toBeGreaterThanOrEqual(2);
    expect(cuerpo).toMatch(/ok:\s*false/);
    expect(cuerpo).toMatch(/ok:\s*true/);
  });

  it('editar el pedido deja rastro (OrderEditorDialog)', () => {
    const src = sinComentarios(leer('components/confirmar/OrderEditorDialog.tsx'));
    expect(src).toMatch(/bitacora\(\s*'edito'/);
  });

  it('leer la conversación deja rastro (PanelConversacion)', () => {
    const src = sinComentarios(leer('components/seguimiento/PanelConversacion.tsx'));
    expect(src).toMatch(/bitacora\(\s*'leyo_chat'/);
  });

  it.each([
    'components/CallView.tsx',
    'components/CrmCallView.tsx',
    'components/NovedadView.tsx',
    'pages/InboxPage.tsx',
  ])('%s tiene el pedido a la vista en la bitácora (abrió / cerró / saltó)', (rel) => {
    const src = sinComentarios(leer(rel));
    expect(src, `${rel} no monta usePedidoALaVista`).toMatch(/usePedidoALaVista\(/);
  });

  it('las gestiones de Seguimiento van con el número de pedido', () => {
    for (const rel of ['components/CrmTable.tsx', 'components/seguimiento/SegBoard.tsx']) {
      const src = sinComentarios(leer(rel));
      // Cualquier llamada a recordGestion con 4 argumentos (el último, el pedido).
      expect(src, `${rel} llama a recordGestion sin externalId`)
        .toMatch(/recordGestion\([^)]*,[^)]*,[^)]*,\s*[^)]*externalId\s*\)/);
    }
  });

  it('el vocabulario tiene deshizo y la pantalla sabe nombrarlo', () => {
    const src = leer('lib/eventosPedido.ts');
    expect(src).toMatch(/\|\s*'deshizo'/);
    expect(src).toMatch(/deshizo:\s*'/);
  });
});

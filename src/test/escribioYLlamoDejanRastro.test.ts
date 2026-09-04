import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ⛔ GUARDIÁN — escribir por WhatsApp y llamar dejan rastro CON el pedido.
 *
 * Encontrado el 4-sep-2026: mandar un WhatsApp o una plantilla desde Guardian
 * solo emitía la gestión local (`emitirGestion`); el touchpoint lo insertaba la
 * edge function y NADIE anotaba `escribio` en `order_events`. Y las llamadas
 * del tablero y la lista iban sin número de pedido, así que no aparecían en la
 * ficha y "llamó y pasó al siguiente" quedaba anotado como `salto`.
 *
 * Sobre esos números el dueño habla con una persona. Si esto se pone en rojo,
 * el problema es el cambio: una acción dejó de dejar rastro, o lo dejó sin pedido.
 */
const SRC = join(process.cwd(), 'src');
const leer = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const sinComentarios = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/(?<!:)\/\/.*$/, ''))
    .join('\n');

describe('⛔ escribir y llamar dejan rastro con el pedido', () => {
  it.each([
    'hooks/useEnviarWhatsapp.ts',
    'hooks/usePlantillasMeta.ts',
  ])('%s anota escribio en la bitácora con el externalId', (rel) => {
    const src = sinComentarios(leer(rel));
    expect(src, `${rel} no monta useBitacoraPedido`).toMatch(/useBitacoraPedido\(\)/);
    expect(src, `${rel} no anota escribio`).toMatch(/bitacora\(\s*'escribio'\s*,\s*\{\s*externalId/);
  });

  it('la plantilla NO anota escribio cuando el servidor dijo ya_enviado', () => {
    const src = sinComentarios(leer('hooks/usePlantillasMeta.ts'));
    const i = src.indexOf("bitacora('escribio'");
    expect(i).toBeGreaterThan(-1);
    // La reja tiene que estar en las líneas inmediatamente anteriores.
    expect(src.slice(Math.max(0, i - 200), i)).toMatch(/if \(!r\.ya_enviado\)/);
  });

  it.each([
    'components/seguimiento/BotonLlamar.tsx',
    'components/seguimiento/SegBoard.tsx',
    'components/CrmTable.tsx',
  ])('%s registra la LLAMADA con el número de pedido', (rel) => {
    const src = sinComentarios(leer(rel));
    const llamadas = src.match(/record(?:Gestion|Contacto)\(\s*[^)]*'LLAMADA'[^)]*\)/g) ?? [];
    expect(llamadas.length, `${rel} no registra ninguna llamada`).toBeGreaterThan(0);
    for (const l of llamadas) {
      expect(l, `${rel}: llamada sin externalId → ${l}`).toMatch(/externalId\s*\)$/);
    }
  });

  it('SegCounterBar escucha la gestión local (no solo el realtime de touchpoints)', () => {
    const src = sinComentarios(leer('components/SegCounterBar.tsx'));
    expect(src).toMatch(/onGestion\(/);
  });
});

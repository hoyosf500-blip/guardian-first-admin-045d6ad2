import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ⛔ GUARDIÁN — Guardian mira el número que el cliente escribe.
 *
 * El caso (4-sep-2026, Ecuador): el bot de ImporChat le dijo al cliente «con
 * este número no me aparece un pedido confirmado» y después «¿es 0986255535 o
 * 986255535?». El pedido EXISTE: #6853503, guardado con phone = '986255535'.
 * Falla por el cero inicial que escribe cualquier ecuatoriano.
 *
 * Guardian tampoco pudo ayudar: `importchat-responder` cruzaba SOLO por
 * `importchat_chat_id`. Cuando el cliente mandaba su número, lo clasificaba como
 * disparador "numero" y NUNCA lo leía. Los dos ciegos a la vez, y el cliente
 * esperando 13 horas.
 *
 * Censo sobre 12.000 pedidos de Ecuador: 11.988 en 9 dígitos limpios y NINGUNO
 * con cero inicial. El dato guardado está sano — el problema era la búsqueda.
 * Por eso acá no se toca ninguna ingesta.
 */
const RAIZ = process.cwd();
const edge = readFileSync(join(RAIZ, 'supabase', 'functions', 'importchat-responder', 'index.ts'), 'utf8');
const listar = readFileSync(join(RAIZ, 'supabase', 'functions', '_shared', 'imporchatListar.ts'), 'utf8');
const cruce = readFileSync(join(RAIZ, 'supabase', 'functions', '_shared', 'importchatCruce.ts'), 'utf8');

const sinComentarios = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/(?<!:)\/\/.*$/, ''))
    .join('\n');

describe('⛔ el respondedor mira el número que el cliente escribe', () => {
  const src = sinComentarios(edge);

  it('la consulta de pedidos NO se filtra por chat enlazado', () => {
    // Esa línea exacta ERA el bug: un chat sin pedido enlazado se descartaba
    // entero, aunque el cliente acabara de escribir su teléfono.
    expect(src, 'volvió el filtro que dejaba ciego a Guardian')
      .not.toMatch(/\.not\("importchat_chat_id",\s*"is",\s*null\)/);
  });

  it('no vuelve el continue que descartaba los chats sin pedido enlazado', () => {
    expect(src, 'volvió `if (!porChat.has(chatId)) continue;` — el bug')
      .not.toMatch(/if \(!porChat\.has\(chatId\)\)\s*continue/);
  });

  it('resuelve el pedido con las tres vías y le pasa el texto del cliente', () => {
    expect(src).toMatch(/candidatosParaChat\(idx,\s*\{/);
    expect(src, 'el texto del cliente no llega al cruce: el número escrito se vuelve a ignorar')
      .toMatch(/textoCliente:\s*c\.u\.texto/);
    expect(src, 'el celular del chat no llega al cruce').toMatch(/celularChat:\s*c\.u\.celular/);
  });

  it('el listado LEE el celular del cliente en vez de tirarlo', () => {
    expect(listar, 'ImporChat manda el celular de quien escribe y Guardian lo volvió a descartar')
      .toMatch(/"celular_cliente"/);
    expect(sinComentarios(listar)).toMatch(/celular:/);
  });

  it('el cruce normaliza con la función probada, no con un slice a mano', () => {
    expect(cruce).toMatch(/normalizePhoneForCountry/);
    // Un `.slice(-9)` acá volvería a mezclar formatos y países.
    expect(sinComentarios(cruce), 'apareció una normalización casera en el cruce')
      .not.toMatch(/slice\(-9\)/);
  });

  it('el resumen deja medir el arreglo en vez de suponerlo', () => {
    // Sin esto no se puede saber si la foto de pedidos quedó recortada, y un
    // silencio por truncamiento se lee igual que "no había nada que hacer".
    expect(src).toMatch(/pedidos_truncado/);
    expect(src).toMatch(/enviados_sin_chat/);
  });

  it('la marca de versión subió con el arreglo', () => {
    expect(src).toMatch(/const VERSION = "importchat-responder 2026-09-04\.4 /);
  });
});

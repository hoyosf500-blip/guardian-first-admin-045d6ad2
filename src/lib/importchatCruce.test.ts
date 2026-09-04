import { describe, it, expect } from 'vitest';
import { indexarPedidos, candidatosParaChat, telefonoDelTexto, motivoSinPedido } from './importchatCruce';

/**
 * El caso REAL que originó esto (4-sep-2026, Ecuador): el cliente escribió
 * `0986255535` y el bot contestó "con este número no me aparece un pedido
 * confirmado". El pedido existe: `#6853503`, guardado con `phone = '986255535'`.
 */
const NESTOR = { external_id: '6853503', phone: '986255535', importchat_chat_id: null, estado: 'PENDIENTE CONFIRMACION' };
const OTRO = { external_id: '6860920', phone: '983176212', importchat_chat_id: '793809', estado: 'PENDIENTE' };

const idxEC = (ps: typeof NESTOR[]) => indexarPedidos(ps, 'EC');

describe('telefonoDelTexto — el cero inicial que rompía todo', () => {
  it('acepta las cuatro formas en que se escribe el mismo celular', () => {
    for (const t of ['0986255535', '986255535', '+593 98 625 5535', '593986255535', ' 0986255535 ']) {
      expect(telefonoDelTexto(t, 'EC'), t).toBe('986255535');
    }
  });

  it('un número de PEDIDO no se confunde con un teléfono', () => {
    expect(telefonoDelTexto('6853503', 'EC')).toBeNull();
  });

  it('texto que no es un número devuelve null', () => {
    expect(telefonoDelTexto('hola, ¿dónde está mi pedido?', 'EC')).toBeNull();
    expect(telefonoDelTexto('', 'EC')).toBeNull();
  });
});

describe('candidatosParaChat — las tres etapas', () => {
  it('⛔ el caso de Néstor: sin chat enlazado, lo ubica por el número que escribió', () => {
    const r = candidatosParaChat(idxEC([NESTOR, OTRO]), {
      chatId: '999999', textoCliente: '0986255535', celularChat: null, cc: 'EC',
    });
    expect(r.via, 'este es el bug: el número que el cliente escribe nunca se leía').toBe('telefono_mensaje');
    expect(r.candidatos.map((p) => p.external_id)).toEqual(['6853503']);
  });

  it('el enlace del chat MANDA sobre el teléfono', () => {
    const r = candidatosParaChat(idxEC([NESTOR, OTRO]), {
      chatId: '793809', textoCliente: '0986255535', celularChat: null, cc: 'EC',
    });
    expect(r.via).toBe('chat');
    expect(r.candidatos.map((p) => p.external_id)).toEqual(['6860920']);
  });

  it('cae al celular del chat cuando el cliente no escribe ningún número', () => {
    const r = candidatosParaChat(idxEC([NESTOR]), {
      chatId: '999999', textoCliente: '¿dónde está mi pedido?', celularChat: '593986255535', cc: 'EC',
    });
    expect(r.via).toBe('celular_chat');
    expect(r.candidatos.map((p) => p.external_id)).toEqual(['6853503']);
  });

  it('sin ninguna vía devuelve vacío, y el motivo distingue si el cliente dio su número', () => {
    const r = candidatosParaChat(idxEC([OTRO]), {
      chatId: '999999', textoCliente: '0986255535', celularChat: null, cc: 'EC',
    });
    expect(r.candidatos).toEqual([]);
    expect(r.via).toBeNull();
    expect(motivoSinPedido(null, { escrito: true })).toContain('dio un número');
    expect(motivoSinPedido(null, { escrito: false })).toContain('ni por enlace ni por teléfono');
  });

  it('⛔ los motivos NO llevan las palabras que descarta necesitaPersona', () => {
    // `necesitaPersona` (src/lib/promesasPendientes.ts) descarta por subcadena
    // todo lo que diga `sin_pedidos` o `sin_vivos`: con esas palabras el caso
    // no llegaría nunca a una cola humana.
    for (const m of [motivoSinPedido(null, { escrito: true }), motivoSinPedido(null, { escrito: false })]) {
      expect(m).not.toContain('sin_pedidos');
      expect(m).not.toContain('sin_vivos');
    }
  });

  it('varios pedidos del mismo teléfono se devuelven TODOS: quién decide es elegirPedidoParaResponder', () => {
    const gemelo = { ...NESTOR, external_id: '6853504' };
    const r = candidatosParaChat(idxEC([NESTOR, gemelo]), {
      chatId: '999999', textoCliente: '0986255535', celularChat: null, cc: 'EC',
    });
    expect(r.candidatos).toHaveLength(2);
  });
});

describe('indexarPedidos', () => {
  it('un pedido sin chat enlazado igual entra al índice por teléfono', () => {
    const idx = idxEC([NESTOR]);
    expect(idx.porChat.size).toBe(0);
    expect(idx.porTelefono.get('986255535')).toHaveLength(1);
  });

  it('cuenta los teléfonos que no normalizan en vez de adivinarlos', () => {
    const roto = { external_id: 'x', phone: '12345678', importchat_chat_id: null, estado: 'PENDIENTE' };
    expect(idxEC([NESTOR, roto]).sinTelefonoNormalizable).toBe(1);
  });

  it('⛔ no cruza países: un celular EC no matchea en una tienda CO', () => {
    const idxCO = indexarPedidos([NESTOR], 'CO');
    const r = candidatosParaChat(idxCO, { chatId: 'x', textoCliente: '0986255535', celularChat: null, cc: 'CO' });
    expect(r.candidatos, 'mezclar países está prohibido en esta operación').toEqual([]);
  });
});

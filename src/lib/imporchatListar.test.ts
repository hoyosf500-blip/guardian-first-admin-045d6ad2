import { describe, it, expect } from 'vitest';
import {
  fechaListar,
  interpretarFila,
  extraerFilas,
  rolListar,
  traerUltimosMensajes,
} from '../../supabase/functions/_shared/imporchatListar';

describe('listado liviano de ImporChat', () => {
  it('la fecha local de Ecuador se pasa a UTC (+5 h) y la ISO con zona se respeta', () => {
    expect(fechaListar('2026-09-03 18:30:00', 'EC')?.toISOString()).toBe('2026-09-03T23:30:00.000Z');
    expect(fechaListar('2026-09-03 18:30:00', 'GT')?.toISOString()).toBe('2026-09-04T00:30:00.000Z');
    expect(fechaListar('2026-09-03T23:30:00.000Z', 'EC')?.toISOString()).toBe('2026-09-03T23:30:00.000Z');
    expect(fechaListar('', 'EC')).toBeNull();
    expect(fechaListar('basura', 'EC')).toBeNull();
  });

  it('el rol acepta el número del socket y el texto del XLSX', () => {
    expect(rolListar(0)).toBe('Cliente');
    expect(rolListar('Cliente')).toBe('Cliente');
    expect(rolListar(1)).toBe('Propietario');
    expect(rolListar('Propietario')).toBe('Propietario');
    expect(rolListar(3)).toBe('otro');
    expect(rolListar(undefined)).toBe('otro');
  });

  it('interpretarFila exige id + fecha; el resto tiene defaults', () => {
    const u = interpretarFila({ id: 77, ultimo_mensaje_at: '2026-09-03 10:00:00', ultimo_rol_mensaje: 0, ultimo_mensaje: 'CONFIRMAR PEDIDO', ultimo_tipo_mensaje: 'button' }, 'EC');
    expect(u).toMatchObject({ chatId: '77', rol: 'Cliente', tipo: 'button', texto: 'CONFIRMAR PEDIDO' });
    expect(u?.at.toISOString()).toBe('2026-09-03T15:00:00.000Z');
    expect(interpretarFila({ id: 1 }, 'EC')).toBeNull();
    expect(interpretarFila({ ultimo_mensaje_at: '2026-09-03 10:00:00' }, 'EC')).toBeNull();
    expect(interpretarFila(null, 'EC')).toBeNull();
  });

  it('extraerFilas entiende data.rows, data[] y rows[] y calcula páginas', () => {
    expect(extraerFilas({ data: { rows: [{ id: 1 }], total_pages: 3 } }, 1, 200)).toEqual({ filas: [{ id: 1 }], totalPaginas: 3 });
    expect(extraerFilas({ data: [{ id: 1 }, { id: 2 }] }, 1, 2)).toEqual({ filas: [{ id: 1 }, { id: 2 }], totalPaginas: 2 });
    expect(extraerFilas({ rows: [{ id: 1 }] }, 4, 200)).toEqual({ filas: [{ id: 1 }], totalPaginas: 4 });
    expect(extraerFilas('nada', 1, 200)).toEqual({ filas: [], totalPaginas: 1 });
  });

  it('traerUltimosMensajes pagina hasta encontrar los chats buscados y no tira', async () => {
    const paginas: Record<string, unknown>[][] = [
      [{ id: 'a', ultimo_mensaje_at: '2026-09-03 10:00:00', ultimo_rol_mensaje: 1 }],
      [{ id: 'b', ultimo_mensaje_at: '2026-09-03 09:00:00', ultimo_rol_mensaje: 0 }],
      [{ id: 'c', ultimo_mensaje_at: '2026-09-03 08:00:00', ultimo_rol_mensaje: 0 }],
    ];
    const pedidas: string[] = [];
    const fetchFn = (async (url: string) => {
      pedidas.push(url);
      const page = Number(new URL(url).searchParams.get('page'));
      return new Response(JSON.stringify({ data: { rows: paginas[page - 1] ?? [], total_pages: 3 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await traerUltimosMensajes('https://x/api/v1/', 'tok', 5, 'EC', Date.now() + 60_000, new Set(['b']), { fetchFn });
    expect(r?.porChat.get('b')?.rol).toBe('Cliente');
    expect(pedidas.length).toBe(2); // paró al encontrar 'b'
    expect(r?.parcial).toBe(false);

    const rota = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    expect(await traerUltimosMensajes('https://x/api/v1/', 'tok', 5, 'EC', Date.now() + 60_000, new Set(['b']), { fetchFn: rota })).toBeNull();

    const rara = (async () => new Response(JSON.stringify({ data: { rows: [{ foo: 1, bar: 2 }] } }), { status: 200 })) as unknown as typeof fetch;
    const r2 = await traerUltimosMensajes('https://x/api/v1/', 'tok', 5, 'EC', Date.now() + 60_000, new Set(), { fetchFn: rara });
    expect(r2?.porChat.size).toBe(0);
    expect(r2?.ignoradas).toBe(1);
    expect(r2?.muestraKeys).toEqual(['foo', 'bar']);
  });
});

describe('la fila REAL de producción (probe_listar, 4-sep-2026)', () => {
  // Copiada tal cual de la respuesta de `clientes_chat_center/listar` (sin datos
  // personales). Antes `ultimo_texto` no estaba en la lista de claves y el texto
  // salía vacío: el responder automático no encontraba ninguna consulta.
  const fila = {
    id: 753860, id_configuracion: 277, id_etiqueta: null, estado_cliente: 1,
    created_at: '2026-08-27T04:25:38.000Z', updated_at: '2026-08-27T04:25:38.000Z', chat_cerrado: 0,
    ultimo_mensaje_at: '2026-09-04 00:09:58',
    ultimo_texto: 'Perfecto 😊 Ya paso su caso al equipo para que le confirmen la guía en el transcurso del día.',
    ultimo_tipo_mensaje: 'text', ultimo_rol_mensaje: '1', ultimo_msg_id: 5529077,
    ultimo_producto_ad: null, productos_imporsuit: null,
  };
  it('lee id, fecha (local EC → UTC), rol, tipo y TEXTO', () => {
    const u = interpretarFila(fila, 'EC')!;
    expect(u.chatId).toBe('753860');
    expect(u.at.toISOString()).toBe('2026-09-04T05:09:58.000Z');
    expect(u.rol).toBe('Propietario');
    expect(u.tipo).toBe('text');
    expect(u.texto).toContain('le confirmen la guía');
  });
  it('un mensaje del cliente ("0") se distingue del negocio', () => {
    const u = interpretarFila({ ...fila, ultimo_rol_mensaje: '0', ultimo_texto: '0960915765' }, 'EC')!;
    expect(u.rol).toBe('Cliente');
    expect(u.texto).toBe('0960915765');
  });
  it('extraerFilas entiende {status, data:[…], totalPages}', () => {
    const r = extraerFilas({ status: 'success', data: [fila], total: 6520, page: 1, limit: 200, totalPages: 33 }, 1, 200);
    expect(r.filas).toHaveLength(1);
    expect(r.totalPaginas).toBe(33);
  });
});

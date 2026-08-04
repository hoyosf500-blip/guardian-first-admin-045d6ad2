import { describe, it, expect, vi } from 'vitest';
import { paginarQuery, type Paginable } from './paginarQuery';

/** Query falsa sobre un arreglo, con el mismo corte que hace PostgREST. */
function queryFalsa<T>(todas: T[], opts?: { fallaEnPagina?: number }) {
  const llamadas: Array<[number, number]> = [];
  let n = 0;
  const hacer = (): Paginable<T> => ({
    range: (desde, hasta) => {
      llamadas.push([desde, hasta]);
      if (opts?.fallaEnPagina === n++) {
        return Promise.resolve({ data: null, error: { message: 'se cayó la red' } });
      }
      return Promise.resolve({ data: todas.slice(desde, hasta + 1), error: null });
    },
  });
  return { hacer, llamadas };
}

const filasDe = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i }));

describe('paginarQuery — traer TODO, no las primeras mil', () => {
  it('junta las páginas hasta que una viene incompleta', async () => {
    const { hacer, llamadas } = queryFalsa(filasDe(2500));
    const r = await paginarQuery(hacer, { tamanoPagina: 1000 });
    expect(r.filas).toHaveLength(2500);
    expect(r.error).toBeNull();
    expect(r.truncado).toBe(false);
    expect(llamadas).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  // El bug que motivó el módulo: con 1200 pendientes se veían 1000 y los otros
  // 200 clientes no los llamaba nadie. La respuesta llegaba 200 OK.
  it('no se queda en las primeras 1000', async () => {
    const { hacer } = queryFalsa(filasDe(1200));
    const r = await paginarQuery(hacer, { tamanoPagina: 1000 });
    expect(r.filas).toHaveLength(1200);
  });

  it('una página exacta pide la siguiente y para ahí', async () => {
    const { hacer, llamadas } = queryFalsa(filasDe(1000));
    const r = await paginarQuery(hacer, { tamanoPagina: 1000 });
    expect(r.filas).toHaveLength(1000);
    expect(llamadas).toHaveLength(2);  // no puede saber que terminó sin preguntar
  });

  it('sin filas devuelve vacío sin error', async () => {
    const { hacer } = queryFalsa(filasDe(0));
    const r = await paginarQuery(hacer, { tamanoPagina: 1000 });
    expect(r).toEqual({ filas: [], error: null, truncado: false });
  });
});

describe('cuando algo sale mal, lo dice', () => {
  it('un error en la PRIMERA página no se disfraza de "no hay nada"', async () => {
    const { hacer } = queryFalsa(filasDe(500), { fallaEnPagina: 0 });
    const r = await paginarQuery(hacer, { tamanoPagina: 1000 });
    expect(r.filas).toEqual([]);
    expect(r.error).toBe('se cayó la red');
  });

  // Lo leído se conserva —sirve para mostrar algo— pero marcado: una lista
  // parcial presentada como completa es peor que una lista vacía con aviso.
  it('un error a mitad devuelve lo leído Y el error', async () => {
    const { hacer } = queryFalsa(filasDe(2500), { fallaEnPagina: 1 });
    const r = await paginarQuery(hacer, { tamanoPagina: 1000 });
    expect(r.filas).toHaveLength(1000);
    expect(r.error).toBe('se cayó la red');
  });

  it('al llegar al tope duro lo marca (no calla)', async () => {
    const { hacer } = queryFalsa(filasDe(5000));
    const r = await paginarQuery(hacer, { tamanoPagina: 1000, topeDuro: 2000 });
    expect(r.filas).toHaveLength(2000);
    expect(r.truncado).toBe(true);
    expect(r.error).toBeNull();
  });
});

describe('cancelación', () => {
  // Cambiar de tienda a mitad del paginado: seguir trayendo páginas de la
  // tienda vieja y aterrizarlas mezclaría Colombia con Ecuador.
  it('corta apenas el llamador dice que ya no le sirve', async () => {
    const { hacer, llamadas } = queryFalsa(filasDe(5000));
    let vueltas = 0;
    const r = await paginarQuery(hacer, {
      tamanoPagina: 1000,
      cancelado: () => vueltas++ >= 2,
    });
    expect(llamadas).toHaveLength(2);
    expect(r.filas).toHaveLength(2000);
  });

  it('cancelado desde el arranque no consulta nada', async () => {
    const { hacer, llamadas } = queryFalsa(filasDe(5000));
    const r = await paginarQuery(hacer, { cancelado: () => true });
    expect(llamadas).toHaveLength(0);
    expect(r.filas).toEqual([]);
  });
});

describe('el orden estable es responsabilidad del llamador', () => {
  // No se puede verificar desde acá que la query traiga .order(), pero sí que
  // el paginador use OFFSET creciente — que es justo lo que rompe sin orden:
  // Postgres puede repetir una fila en dos páginas y saltear otra.
  it('avanza el offset de a una página, sin solaparse', async () => {
    const { hacer, llamadas } = queryFalsa(filasDe(3000), {});
    await paginarQuery(hacer, { tamanoPagina: 500 });
    for (let i = 1; i < llamadas.length; i++) {
      expect(llamadas[i][0]).toBe(llamadas[i - 1][1] + 1);
    }
  });

  it('no re-usa la query: pide una nueva por página', async () => {
    const spy = vi.fn(() => queryFalsa(filasDe(2500)).hacer());
    await paginarQuery(spy as unknown as () => Paginable<unknown>, { tamanoPagina: 1000 });
    expect(spy.mock.calls.length).toBeGreaterThan(1);
  });
});

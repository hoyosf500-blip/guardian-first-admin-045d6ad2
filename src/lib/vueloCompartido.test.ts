import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { crearVueloCompartido } from './vueloCompartido';

/**
 * El vuelo compartido nació de una medición: tres instancias del mismo hook
 * pidiendo el mismo barrido de 90 días de `touchpoints` = 6 peticiones, y la
 * copia que llegaba tarde arrastraba otros cuatro viajes al cambiar la cola.
 *
 * Lo que se fija acá es lo que hace que compartir NO mienta: que el fallo no se
 * cachee (un mapa vacío cacheado afirmaría "nadie cerró nada" durante todo el
 * TTL) y que el TTL de verdad expire.
 */
describe('vueloCompartido', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const ok = <T,>(valor: T) => async () => ({ valor, ok: true });

  it('tres que piden a la vez = UNA sola carga', async () => {
    const v = crearVueloCompartido<number>(30_000);
    const cargar = vi.fn(ok(7));
    const [a, b, c] = await Promise.all([
      v.pedir('EC', cargar, () => 0),
      v.pedir('EC', cargar, () => 0),
      v.pedir('EC', cargar, () => 0),
    ]);
    expect(cargar).toHaveBeenCalledTimes(1);
    expect([a, b, c]).toEqual([7, 7, 7]);
  });

  it('claves distintas NO se comparten — una tienda no puede recibir el dato de otra', () => {
    const v = crearVueloCompartido<string>(30_000);
    const cargar = vi.fn(async () => ({ valor: 'x', ok: true }));
    void v.pedir('EC', cargar, () => '');
    void v.pedir('CO', cargar, () => '');
    expect(cargar).toHaveBeenCalledTimes(2);
  });

  it('dentro del TTL reusa; pasado el TTL vuelve a cargar', async () => {
    const v = crearVueloCompartido<number>(30_000);
    const cargar = vi.fn(ok(1));
    await v.pedir('EC', cargar, () => 0);
    vi.advanceTimersByTime(29_000);
    await v.pedir('EC', cargar, () => 0);
    expect(cargar).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_000);
    await v.pedir('EC', cargar, () => 0);
    expect(cargar).toHaveBeenCalledTimes(2);
  });

  it('⛔ ok:false NO se cachea: el siguiente reintenta', async () => {
    // Cachear un resultado roto sería afirmar durante 30 s algo que nunca se
    // pudo leer. En el caso real eso es "nadie cerró nada", y `closed` es lo que
    // saca de la cola los pedidos ya resueltos: volverían a llamar al cliente.
    const v = crearVueloCompartido<number>(30_000);
    const cargar = vi.fn(async () => ({ valor: -1, ok: false }));
    const r = await v.pedir('EC', cargar, () => 0);
    expect(r).toBe(-1);            // se entrega igual a quien esperaba
    await v.pedir('EC', cargar, () => 0);
    expect(cargar).toHaveBeenCalledTimes(2); // pero NO quedó cacheado
  });

  it('los que ya estaban esperando un fallo reciben el mismo valor', async () => {
    const v = crearVueloCompartido<number>(30_000);
    const cargar = vi.fn(async () => ({ valor: -1, ok: false }));
    const [a, b] = await Promise.all([
      v.pedir('EC', cargar, () => 0),
      v.pedir('EC', cargar, () => 0),
    ]);
    expect(cargar).toHaveBeenCalledTimes(1);
    expect([a, b]).toEqual([-1, -1]);
  });

  it('si el cargador TIRA, se devuelve el respaldo y tampoco se cachea', async () => {
    const v = crearVueloCompartido<string>(30_000);
    const cargar = vi.fn(async () => { throw new Error('red caída'); });
    expect(await v.pedir('EC', cargar, () => 'vacío')).toBe('vacío');
    await v.pedir('EC', cargar, () => 'vacío');
    expect(cargar).toHaveBeenCalledTimes(2);
  });

  it('limpiar() fuerza una carga nueva', async () => {
    const v = crearVueloCompartido<number>(30_000);
    const cargar = vi.fn(ok(1));
    await v.pedir('EC', cargar, () => 0);
    v.limpiar();
    await v.pedir('EC', cargar, () => 0);
    expect(cargar).toHaveBeenCalledTimes(2);
  });
});

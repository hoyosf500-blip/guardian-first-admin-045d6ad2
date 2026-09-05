import { describe, it, expect } from 'vitest';
import { matchesQuery } from './textSearch';

/**
 * El buscador tiene que encontrar al cliente aunque escriba su número como lo
 * escribe cualquiera.
 *
 * ── El caso real (4-sep-2026, Ecuador) ─────────────────────────────────────
 * Néstor Isaías Ayme escribió `0986255535` por WhatsApp. Su pedido existe
 * (#6853503) y está guardado como `986255535`. El bot le contestó que no le
 * aparecía ningún pedido, y la asesora tampoco lo encontraba copiando y pegando
 * ese mismo número en Guardian.
 *
 * La comparación por subcadena es ASIMÉTRICA y ahí está toda la trampa:
 *   '986255535'.includes('0986255535')  →  false
 *   '0986255535'.includes('986255535')  →  true
 * O sea que buscar la forma larga cuando está guardada la corta no devuelve
 * nada. Y el censo de 12.000 pedidos de Ecuador dice que 11.988 están en 9
 * dígitos limpios y NINGUNO con cero inicial: el dato está sano, lo que fallaba
 * era la búsqueda.
 *
 * ⛔ Eso se arregló ese día en la búsqueda del SERVIDOR (`useOrderSearch`), y
 * ahí quedó a medias: el filtro que corre en el navegador sobre lo ya
 * descargado —el que responde primero, el que la asesora ve moverse mientras
 * teclea— siguió comparando crudo casi un día más. Un arreglo puesto en un
 * camino y no en el otro es peor que ninguno, porque el buscador encuentra o no
 * encuentra según la pantalla.
 */
describe('el buscador encuentra el número que copia la asesora', () => {
  const cliente = ['Néstor Isaías Ayme', '986255535', 'Quito', '', '', '6853503'];

  it('con el cero inicial que escribe cualquier ecuatoriano', () => {
    expect(matchesQuery(cliente, '0986255535')).toBe(true);
  });

  it('con el número tal como está guardado', () => {
    expect(matchesQuery(cliente, '986255535')).toBe(true);
  });

  it('con el prefijo internacional pegado', () => {
    expect(matchesQuery(cliente, '+593986255535')).toBe(true);
    expect(matchesQuery(cliente, '593986255535')).toBe(true);
  });

  it('y también en el sentido que ya funcionaba: guardado con cero, buscado sin él', () => {
    expect(matchesQuery(['Ana', '0986255535', 'Quito'], '986255535')).toBe(true);
  });

  it('un número de OTRO cliente sigue sin matchear (no se aflojó el filtro)', () => {
    expect(matchesQuery(cliente, '0999888777')).toBe(false);
    expect(matchesQuery(cliente, '986255536')).toBe(false);
  });

  it('Colombia: el número con y sin +57', () => {
    const co = ['Juan', '3001112222', 'Bogotá'];
    expect(matchesQuery(co, '+573001112222')).toBe(true);
    expect(matchesQuery(co, '3001112222')).toBe(true);
  });

  it('lo que no es teléfono se compara igual que siempre', () => {
    // Sin tildes (esto ya andaba y no se puede romper).
    expect(matchesQuery(cliente, 'nestor')).toBe(true);
    expect(matchesQuery(cliente, 'quito')).toBe(true);
    expect(matchesQuery(['Ana', '', 'Bogotá'], 'bogota')).toBe(true);
    expect(matchesQuery(['Ana', '', 'DURÁN'], 'duran')).toBe(true);
    // Y el AND de tokens sigue siendo AND.
    expect(matchesQuery(cliente, 'nestor quito')).toBe(true);
    expect(matchesQuery(cliente, 'nestor bogota')).toBe(false);
  });

  it('un número corto NO se canoniza: 0800 no puede volverse 800 y traer de más', () => {
    // `pareceTelefono` exige un mínimo de dígitos justamente para esto: un
    // token corto canonizado ensancharía la búsqueda en vez de arreglarla.
    expect(matchesQuery(['Ana', '800', 'Quito'], '0800')).toBe(false);
  });
});

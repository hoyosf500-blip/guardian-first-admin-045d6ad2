import { describe, it, expect } from 'vitest';
import { resumirSinVuelta, textoSinVuelta, type SelloMinimo } from './plantillasSinVuelta';

const colgado = (phone: string) => ({ phone, salienteAt: 1_700_000_000_000 });

/** El sello: quién tocó por último cada teléfono. */
const sellos = (m: Record<string, string>) =>
  (phone: string): SelloMinimo | null =>
    m[phone] ? { operatorId: m[phone], createdAt: '2026-09-03T14:00:00.000Z' } : null;

describe('a quién le quedó colgado el cliente', () => {
  it('cada colgado va a quien lo tocó por última vez', () => {
    const r = resumirSinVuelta(
      [colgado('1'), colgado('2'), colgado('3')],
      sellos({ '1': 'ana', '2': 'ana', '3': 'beto' }),
      true,
    );
    expect(r.porAsesora.get('ana')).toBe(2);
    expect(r.porAsesora.get('beto')).toBe(1);
    expect(r.total).toBe(3);
    expect(r.sinAtribuir).toBe(0);
  });

  /**
   * ⛔ LO QUE NO SE PUEDE ATRIBUIR NO SE LE CUELGA A NADIE. Un cliente al que
   * le escribió el bot y ninguna persona tocó no es culpa de ninguna asesora.
   * Sumárselo a la última que pasó cerca sería inventar un responsable, y sobre
   * este número el dueño habla con una persona.
   */
  it('sin sello, el colgado va aparte — no se le achaca a nadie', () => {
    const r = resumirSinVuelta(
      [colgado('1'), colgado('2')],
      sellos({ '1': 'ana' }),
      true,
    );
    expect(r.porAsesora.get('ana')).toBe(1);
    expect(r.sinAtribuir).toBe(1);
    expect(r.total).toBe(2);
  });

  it('un teléfono vacío no se le asigna a nadie', () => {
    const r = resumirSinVuelta(
      [{ phone: '', salienteAt: 1 }],
      sellos({ '': 'ana' }),
      true,
    );
    expect(r.porAsesora.size).toBe(0);
    expect(r.sinAtribuir).toBe(1);
  });

  /**
   * ⛔ EL CERO QUE SALE DE NO HABER PODIDO LEER. Sin sellos, TODOS los colgados
   * parecerían "de nadie" y cada tarjeta diría 0 — que se lee como una buena
   * noticia sobre alguien que tiene cinco clientes esperando. Es el mismo error
   * que ya costó caro con «no hubo cancelaciones» y «todos atendidos».
   */
  it('si no se pudo medir, NO se afirma nada: ni un cero por asesora', () => {
    const r = resumirSinVuelta(
      [colgado('1'), colgado('2')],
      sellos({ '1': 'ana', '2': 'ana' }),
      false,
    );
    expect(r.porAsesora.size).toBe(0);
    expect(r.sinAtribuir).toBe(0);
    expect(r.total).toBe(0);
  });

  it('sin colgados no inventa filas', () => {
    expect(resumirSinVuelta([], sellos({}), true).total).toBe(0);
    expect(resumirSinVuelta(null, sellos({}), true).total).toBe(0);
    expect(resumirSinVuelta(undefined, sellos({}), true).total).toBe(0);
  });
});

describe('la frase de la tarjeta', () => {
  it('en cero no dice nada: una línea de más tapa a las que sí importan', () => {
    expect(textoSinVuelta(0)).toBeNull();
    expect(textoSinVuelta(-3)).toBeNull();
    expect(textoSinVuelta(Number.NaN)).toBeNull();
  });

  it('singular y plural', () => {
    expect(textoSinVuelta(1)).toBe('1 cliente sin respuesta y sin 2º intento');
    expect(textoSinVuelta(7)).toBe('7 clientes sin respuesta y sin 2º intento');
  });
});

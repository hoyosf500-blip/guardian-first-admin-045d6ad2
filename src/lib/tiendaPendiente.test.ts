import { describe, it, expect, beforeEach } from 'vitest';
import { guardarTiendaPendiente, leerTiendaPendiente, olvidarTiendaPendiente } from '@/lib/tiendaPendiente';

/**
 * El puente entre "me registré" y "entré por primera vez".
 *
 * Lo que se lee acá se convierte, sin que nadie lo revise, en una tienda creada
 * automáticamente. Por eso lee desconfiando: cualquier duda devuelve null y el
 * dueño cae en la pantalla de crear tienda, que siempre sigue existiendo.
 */

const CLAVE = 'guardian.tiendaPendiente';

describe('tienda anotada en el registro', () => {
  beforeEach(() => localStorage.clear());

  it('guarda y devuelve lo que el dueño escribió', () => {
    guardarTiendaPendiente({ nombre: 'Tienda de Carlos', pais: 'EC' });
    expect(leerTiendaPendiente()).toEqual({ nombre: 'Tienda de Carlos', pais: 'EC' });
  });

  it('sin nada anotado devuelve null (no inventa una tienda)', () => {
    expect(leerTiendaPendiente()).toBeNull();
  });

  it('olvidar la deja en null', () => {
    guardarTiendaPendiente({ nombre: 'Tienda de Ana', pais: 'CO' });
    olvidarTiendaPendiente();
    expect(leerTiendaPendiente()).toBeNull();
  });

  it('un JSON roto no revienta ni crea nada', () => {
    localStorage.setItem(CLAVE, '{esto no es json');
    expect(leerTiendaPendiente()).toBeNull();
  });

  it('un nombre vacío se descarta: nadie quiere una tienda sin nombre creada sola', () => {
    localStorage.setItem(CLAVE, JSON.stringify({ nombre: '   ', pais: 'CO' }));
    expect(leerTiendaPendiente()).toBeNull();
  });

  it('un país desconocido cae a Colombia en vez de romper', () => {
    localStorage.setItem(CLAVE, JSON.stringify({ nombre: 'Tienda X', pais: 'ZZ' }));
    expect(leerTiendaPendiente()).toEqual({ nombre: 'Tienda X', pais: 'CO' });
  });

  it('recorta los espacios de los costados', () => {
    localStorage.setItem(CLAVE, JSON.stringify({ nombre: '  Mi Tienda  ', pais: 'GT' }));
    expect(leerTiendaPendiente()).toEqual({ nombre: 'Mi Tienda', pais: 'GT' });
  });
});

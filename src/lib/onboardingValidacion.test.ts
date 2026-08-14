import { describe, it, expect } from 'vitest';
import {
  validarNombreTienda, validarPais, validarApiKey, validarEmail,
  validarPassword, validarUrl, validarSetup, hayErrores,
} from '@/lib/onboardingValidacion';

// El camino del dueño NUEVO no se puede ejercitar en el navegador del dueño
// actual (ya tiene tienda y credenciales). Por eso se prueba acá.

describe('paso 1 — crear tienda', () => {
  it('exige un nombre de al menos 2 letras', () => {
    expect(validarNombreTienda('').ok).toBe(false);
    expect(validarNombreTienda('  a ').ok).toBe(false);
    expect(validarNombreTienda('Tienda de Carlos').ok).toBe(true);
  });

  it('corta el nombre demasiado largo', () => {
    expect(validarNombreTienda('x'.repeat(61)).ok).toBe(false);
  });

  it('solo acepta CO o EC — mezclar países descuadra los pedidos', () => {
    expect(validarPais('CO').ok).toBe(true);
    expect(validarPais('EC').ok).toBe(true);
    expect(validarPais('PE').ok).toBe(false);
    expect(validarPais('').ok).toBe(false);
  });
});

describe('paso 2 — API Key de Dropi', () => {
  const KEY_OK = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmnop';

  it('acepta un JWT de tres bloques', () => {
    expect(validarApiKey(KEY_OK).ok).toBe(true);
    expect(validarApiKey(`  ${KEY_OK}  `).ok).toBe(true);
  });

  it('rechaza texto suelto, clave cortada o con espacios adentro', () => {
    expect(validarApiKey('mi-clave-secreta').ok).toBe(false);
    expect(validarApiKey('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0').ok).toBe(false);
    expect(validarApiKey('eyJhbGci OiJIUzI1NiJ9.aaaa.bbbb').ok).toBe(false);
    expect(validarApiKey('').ok).toBe(false);
  });

  it('da un mensaje que dice qué hacer, no un código', () => {
    expect(validarApiKey('nada').error).toMatch(/tres bloques/i);
  });
});

describe('paso 2 — correo y clave de la cuenta Dropi', () => {
  it('valida el correo', () => {
    expect(validarEmail('dueno@tienda.com').ok).toBe(true);
    expect(validarEmail('dueno@tienda').ok).toBe(false);
    expect(validarEmail('sin arroba.com').ok).toBe(false);
  });

  it('exige la clave y explica por qué (si no, la billetera se muere)', () => {
    expect(validarPassword('').ok).toBe(false);
    expect(validarPassword('').error).toMatch(/billetera/i);
    expect(validarPassword('123').ok).toBe(false);
    expect(validarPassword('clave-larga').ok).toBe(true);
  });
});

describe('paso 2 — URLs', () => {
  it('la URL de integración es obligatoria y con dominio real', () => {
    expect(validarUrl('', true, 'la URL').ok).toBe(false);
    expect(validarUrl('mitienda', true, 'la URL').ok).toBe(false);
    expect(validarUrl('https://localhost', true, 'la URL').ok).toBe(false);
    expect(validarUrl('https://mitienda.com/', true, 'la URL').ok).toBe(true);
  });

  it('el logo puede ir vacío pero no roto', () => {
    expect(validarUrl('', false, 'el logo').ok).toBe(true);
    expect(validarUrl('ftp://x.com/a.png', false, 'el logo').ok).toBe(false);
    expect(validarUrl('https://x.com/a.png', false, 'el logo').ok).toBe(true);
  });
});

describe('validarSetup — habilitación del paso 2 completo', () => {
  const completo = {
    name: 'Tienda de Carlos',
    dropi_api_key: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmnop',
    dropi_login_email: 'dueno@tienda.com',
    dropi_login_password: 'clave-larga',
    dropi_store_url: 'https://mitienda.com/',
    brand_logo_url: '',
  };

  it('no deja avanzar con el formulario vacío y marca cada campo', () => {
    const e = validarSetup({});
    expect(hayErrores(e)).toBe(true);
    for (const k of ['name', 'dropi_api_key', 'dropi_login_email', 'dropi_login_password', 'dropi_store_url']) {
      expect(e[k as keyof typeof e]).toBeTruthy();
    }
  });

  it('deja avanzar cuando está todo bien', () => {
    expect(hayErrores(validarSetup(completo))).toBe(false);
  });

  it('un solo campo malo alcanza para frenar el guardado', () => {
    const e = validarSetup({ ...completo, dropi_api_key: 'pegue-cualquier-cosa' });
    expect(hayErrores(e)).toBe(true);
    expect(Object.keys(e)).toEqual(['dropi_api_key']);
  });

  it('el logo vacío NO frena nada', () => {
    expect(hayErrores(validarSetup({ ...completo, brand_logo_url: '' }))).toBe(false);
  });
});

describe('volver a editar: el acceso a Dropi viaja en PAR o no viaja', () => {
  // "Corregir datos" blanquea los secretos a propósito. Verificado en vivo el
  // 2026-08-13 con una tienda de prueba: guardar el par vacío BORRABA el correo
  // y CONSERVABA la clave. La tienda quedaba con medio acceso, el auto-login no
  // arrancaba y la billetera se congelaba sin un solo aviso — la misma muerte
  // silenciosa que Colombia arrastró dos meses. Y el disparador era arreglar
  // una coma en la URL.
  const yaGuardado = { hasApiKey: true, hasLogin: true };
  const soloLoVisible = {
    name: 'Mi Tienda',
    dropi_api_key: '',
    dropi_login_email: '',
    dropi_login_password: '',
    dropi_store_url: 'https://mitienda.com/',
  };

  it('los dos en blanco = "no toqué el acceso": deja guardar', () => {
    expect(hayErrores(validarSetup(soloLoVisible, yaGuardado))).toBe(false);
  });

  it('solo el correo NO alcanza: pide también la clave', () => {
    const e = validarSetup(
      { ...soloLoVisible, dropi_login_email: 'yo@mitienda.com' },
      yaGuardado,
    );
    expect(e.dropi_login_password).toBeTruthy();
  });

  it('solo la clave NO alcanza: pide también el correo', () => {
    const e = validarSetup(
      { ...soloLoVisible, dropi_login_password: 'MiClave123' },
      yaGuardado,
    );
    expect(e.dropi_login_email).toBeTruthy();
  });

  it('cambiar el par completo se permite', () => {
    const e = validarSetup(
      { ...soloLoVisible, dropi_login_email: 'yo@mitienda.com', dropi_login_password: 'MiClave123' },
      yaGuardado,
    );
    expect(hayErrores(e)).toBe(false);
  });

  it('en un alta NUEVA los dos siguen siendo obligatorios', () => {
    const e = validarSetup(soloLoVisible, {});
    expect(e.dropi_login_email).toBeTruthy();
    expect(e.dropi_login_password).toBeTruthy();
  });
});

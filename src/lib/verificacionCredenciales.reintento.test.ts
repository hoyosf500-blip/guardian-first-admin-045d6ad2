import { describe, it, expect } from 'vitest';
import { mensajeReintento, interpretarChequeos } from './verificacionCredenciales';

// El dueño NO puede ejercitar este camino en su navegador (su tienda ya está
// configurada), así que el mensaje de reintento se prueba acá o no se prueba.

const TODO_OK = interpretarChequeos([
  { clave: 'api_key', ok: true, muestra: 3 },
  { clave: 'login', ok: true },
  { clave: 'billetera', ok: true },
]);

const CLAVE_MALA = interpretarChequeos([
  { clave: 'api_key', ok: false, httpStatus: 401 },
  { clave: 'login', ok: false, httpStatus: 401 },
  { clave: 'billetera', ok: false, omitido: true },
]);

const DROPI_LENTO = interpretarChequeos([
  { clave: 'api_key', ok: false, httpStatus: 429 },
  { clave: 'login', ok: false, httpStatus: 429 },
  { clave: 'billetera', ok: false, httpStatus: 429 },
]);

describe('mensajeReintento', () => {
  it('no dice nada cuando está todo en verde', () => {
    expect(mensajeReintento(1, '', TODO_OK)).toBe('');
  });

  it('si la prueba ni corrió, no insinúa que la clave esté mal', () => {
    const m = mensajeReintento(1, 'network error', CLAVE_MALA);
    expect(m).toContain('no es tu clave');
    expect(m).toContain('guardados');
  });

  it('al tercer fallo de la prueba misma, deja de pedir reintentos ciegos', () => {
    expect(mensajeReintento(3, 'network error', CLAVE_MALA)).toContain('escribinos');
  });

  it('con Dropi lento pide esperar y NO cambiar las claves', () => {
    expect(mensajeReintento(1, '', DROPI_LENTO)).toContain('no cambies las claves');
  });

  it('al tercer intento con el mismo error manda a corregir, no a reintentar', () => {
    const m = mensajeReintento(3, '', CLAVE_MALA);
    expect(m).toContain('corregí');
    expect(m).toContain('rojo');
  });

  it('en los primeros intentos avisa que nada se habilita sin verde', () => {
    expect(mensajeReintento(1, '', CLAVE_MALA)).toContain('verde');
  });
});

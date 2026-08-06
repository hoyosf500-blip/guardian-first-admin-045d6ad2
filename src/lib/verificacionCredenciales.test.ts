import { describe, it, expect } from 'vitest';
import {
  interpretarChequeos,
  puedeContinuar,
  estaCompleto,
  resumen,
  type ChequeoCrudo,
} from './verificacionCredenciales';

// Estas pruebas ejercitan el camino del CLIENTE NUEVO, que es justamente el que
// el dueño no puede probar en su navegador: sus dos tiendas ya están
// configuradas. Sin esto, la única forma de saber si el asistente se comporta
// bien con credenciales malas sería crear tiendas rotas a mano.

const OK_API: ChequeoCrudo = { clave: 'api_key', ok: true, httpStatus: 200, muestra: 3 };
const OK_LOGIN: ChequeoCrudo = { clave: 'login', ok: true, httpStatus: 200 };
const OK_WALLET: ChequeoCrudo = { clave: 'billetera', ok: true, httpStatus: 200, muestra: 60 };

describe('verificación de credenciales — todo bien', () => {
  it('con las tres verdes dice que está completo y deja continuar', () => {
    const r = interpretarChequeos([OK_API, OK_LOGIN, OK_WALLET]);
    expect(r.every((c) => c.estado === 'ok')).toBe(true);
    expect(estaCompleto(r)).toBe(true);
    expect(puedeContinuar(r)).toBe(true);
    expect(resumen(r)).toBe('Todo conectado y verificado.');
  });

  it('una cuenta nueva sin pedidos todavía sigue siendo válida', () => {
    // Un cliente que recién abre no tiene pedidos hoy. Marcar eso en rojo lo
    // haría cambiar una API Key que estaba perfecta.
    const r = interpretarChequeos([
      { clave: 'api_key', ok: true, httpStatus: 200, muestra: 0 },
      OK_LOGIN,
      OK_WALLET,
    ]);
    expect(r[0].estado).toBe('ok');
    expect(r[0].detalle).toMatch(/normal en una cuenta nueva/);
  });
});

describe('verificación de credenciales — API Key', () => {
  it('un 401 bloquea: sin pedidos el CRM está vacío', () => {
    const r = interpretarChequeos([
      { clave: 'api_key', ok: false, httpStatus: 401, mensaje: 'Unauthorized' },
      OK_LOGIN,
      OK_WALLET,
    ]);
    expect(r[0].estado).toBe('falla');
    expect(r[0].bloqueante).toBe(true);
    expect(puedeContinuar(r)).toBe(false);
    expect(resumen(r)).toMatch(/antes de poder usar Guardian/);
  });

  it('un 429 NO es una credencial mala y lo dice explícitamente', () => {
    // El punto de esta prueba: que el mensaje le PIDA no cambiar la clave. Un
    // cliente que lee "credencial inválida" ante un throttle rompe lo que
    // funcionaba.
    const r = interpretarChequeos([
      { clave: 'api_key', ok: false, httpStatus: 429 },
      OK_LOGIN,
      OK_WALLET,
    ]);
    expect(r[0].estado).toBe('aviso');
    expect(r[0].comoArreglar).toMatch(/No cambies la clave/i);
    expect(puedeContinuar(r)).toBe(true);
  });

  it('un 503 tampoco culpa a la credencial', () => {
    const r = interpretarChequeos([
      { clave: 'api_key', ok: false, httpStatus: 503 },
      OK_LOGIN,
      OK_WALLET,
    ]);
    expect(r[0].estado).toBe('aviso');
  });
});

describe('verificación de credenciales — login (el caso de Colombia)', () => {
  it('sin correo ni clave avisa que la billetera se muere, pero deja entrar', () => {
    // Esto es EXACTAMENTE lo que le pasó a Colombia: configurada sin login, la
    // billetera murió el 28-jul y nadie lo supo hasta el 6-ago.
    const r = interpretarChequeos([
      OK_API,
      { clave: 'login', ok: false, omitido: true },
      { clave: 'billetera', ok: false, omitido: true },
    ]);
    expect(r[1].estado).toBe('aviso');
    expect(r[1].detalle).toMatch(/No cargaste el correo/);
    expect(r[1].comoArreglar).toMatch(/deja de actualizarse en una hora/);
    expect(puedeContinuar(r)).toBe(true);
    // Pero NO puede decir "listo": esa indulgencia es la que costó dos meses.
    expect(estaCompleto(r)).toBe(false);
  });

  it('detecta la verificación en dos pasos y dice qué hacer', () => {
    const r = interpretarChequeos([
      OK_API,
      { clave: 'login', ok: false, httpStatus: 403, mensaje: 'El login falló: 2FA activo' },
      { clave: 'billetera', ok: false, omitido: true },
    ]);
    expect(r[1].estado).toBe('falla');
    expect(r[1].detalle).toMatch(/dos pasos/);
    expect(r[1].comoArreglar).toMatch(/Desactivá/);
  });

  it('una clave mala NO se confunde con 2FA', () => {
    const r = interpretarChequeos([
      OK_API,
      { clave: 'login', ok: false, httpStatus: 401, mensaje: 'Credenciales incorrectas' },
      { clave: 'billetera', ok: false, omitido: true },
    ]);
    expect(r[1].detalle).toMatch(/rechazó el correo o la clave/);
    expect(r[1].comoArreglar).not.toMatch(/dos pasos/);
  });

  it('el login roto NO impide entrar al CRM', () => {
    // Los pedidos entran con la API Key, no con el login. Cerrarle la puerta
    // por esto sería castigarlo por algo que no le impide trabajar.
    const r = interpretarChequeos([
      OK_API,
      { clave: 'login', ok: false, httpStatus: 401 },
      { clave: 'billetera', ok: false, omitido: true },
    ]);
    expect(puedeContinuar(r)).toBe(true);
  });
});

describe('verificación de credenciales — billetera', () => {
  it('si el login falló, la billetera se omite en vez de gritar dos veces', () => {
    const r = interpretarChequeos([
      OK_API,
      { clave: 'login', ok: false, httpStatus: 401 },
      { clave: 'billetera', ok: false, omitido: true },
    ]);
    expect(r[2].estado).toBe('omitido');
    expect(r[2].comoArreglar).toBe('');
  });

  it('si falla por su cuenta avisa que los costos quedan en cero', () => {
    const r = interpretarChequeos([
      OK_API,
      OK_LOGIN,
      { clave: 'billetera', ok: false, httpStatus: 500, mensaje: 'XLSX ilegible' },
    ]);
    expect(r[2].estado).toBe('aviso');
    expect(r[2].detalle).toMatch(/XLSX ilegible/);
    expect(r[2].comoArreglar).toMatch(/en cero/);
  });
});

describe('verificación de credenciales — contrato general', () => {
  it('siempre devuelve los tres chequeos en el mismo orden, aunque falten', () => {
    // La edge function puede morir a mitad de camino; la pantalla igual tiene
    // que dibujar los tres renglones y no una lista a medias.
    const r = interpretarChequeos([OK_API]);
    expect(r.map((c) => c.clave)).toEqual(['api_key', 'login', 'billetera']);
    expect(r).toHaveLength(3);
  });

  it('sin ningún resultado no dice que está listo', () => {
    const r = interpretarChequeos([]);
    expect(estaCompleto(r)).toBe(false);
  });

  it('ignora chequeos desconocidos sin romperse', () => {
    const r = interpretarChequeos([
      OK_API, OK_LOGIN, OK_WALLET,
      { clave: 'inventado' as never, ok: false },
    ]);
    expect(r).toHaveLength(3);
    expect(estaCompleto(r)).toBe(true);
  });
});

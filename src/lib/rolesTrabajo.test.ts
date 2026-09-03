import { describe, it, expect } from 'vitest';
import { trabajaLaCola, soloObserva, seLeBloqueaLaPantalla } from './rolesTrabajo';

/**
 * Las cuatro personas reales de esta operación, con sus flags tal como los
 * arman `AuthContext` (admin global) y `StoreContext` (rol en la tienda).
 */
const FABIAN = { isAdmin: true, isOwnerOfActive: true, isManagerOfActive: true };   // dueño-admin
const ROBERTO = { isAdmin: false, isOwnerOfActive: false, isManagerOfActive: true }; // supervisor
const ESTEFANO = { isAdmin: false, isOwnerOfActive: false, isManagerOfActive: false }; // operadora
/** Dueño de una tienda cliente: NO es admin de la plataforma, pero tampoco atiende. */
const CLIENTE_DUENO = { isAdmin: false, isOwnerOfActive: true, isManagerOfActive: true };

describe('quién trabaja la cola', () => {
  it('el SUPERVISOR trabaja — es un rango más que la operadora, no un jefe aparte', () => {
    expect(trabajaLaCola(ROBERTO)).toBe(true);
    expect(soloObserva(ROBERTO)).toBe(false);
  });

  it('la operadora trabaja', () => {
    expect(trabajaLaCola(ESTEFANO)).toBe(true);
  });

  it('el dueño-admin SOLO OBSERVA: entrar a un pedido no le puede costar nada', () => {
    expect(trabajaLaCola(FABIAN)).toBe(false);
    expect(soloObserva(FABIAN)).toBe(true);
  });

  it('el dueño de una tienda cliente también observa, aunque no sea admin global', () => {
    expect(trabajaLaCola(CLIENTE_DUENO)).toBe(false);
    expect(soloObserva(CLIENTE_DUENO)).toBe(true);
  });

  it('observar y trabajar son excluyentes y cubren todo el mundo', () => {
    for (const p of [FABIAN, ROBERTO, ESTEFANO, CLIENTE_DUENO]) {
      expect(trabajaLaCola(p)).toBe(!soloObserva(p));
    }
  });
});

describe('a quién se le traba la pantalla', () => {
  it('a la operadora sí', () => {
    expect(seLeBloqueaLaPantalla(ESTEFANO)).toBe(true);
  });

  it('al SUPERVISOR también — decisión del dueño, 3-sep-2026', () => {
    // ⛔ ESTO CAMBIÓ, y el cambio fue deliberado. Hasta el 3-sep Roberto quedaba
    // exento: se le medía (nudge suave, botón de pausa, reparto, jornada) pero
    // no se le trababa la pantalla, porque es quien destraba al equipo.
    //
    // El dueño lo revirtió con un caso encima de la mesa: el supervisor manda
    // plantillas de un clic, hace UN intento y no vuelve a mirar si contestaron.
    // «A los supervisores también se les cuenta porque trabajan menos.» Un aviso
    // que no traba a quien menos rinde es un adorno.
    //
    // Si esta prueba se pone roja porque alguien volvió a eximir al supervisor,
    // que sea con el dato de cuántas veces el equipo quedó esperándolo —
    // no de memoria.
    expect(trabajaLaCola(ROBERTO)).toBe(true);
    expect(seLeBloqueaLaPantalla(ROBERTO)).toBe(true);
  });

  it('al dueño nunca — mirar la operación no puede costarle una pantalla trabada', () => {
    expect(seLeBloqueaLaPantalla(FABIAN)).toBe(false);
    expect(seLeBloqueaLaPantalla(CLIENTE_DUENO)).toBe(false);
  });

  it('nadie a quien no se le mide puede quedar trabado', () => {
    for (const p of [FABIAN, ROBERTO, ESTEFANO, CLIENTE_DUENO]) {
      if (seLeBloqueaLaPantalla(p)) expect(trabajaLaCola(p)).toBe(true);
    }
  });
});

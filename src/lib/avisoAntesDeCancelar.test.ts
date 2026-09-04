import { describe, it, expect } from 'vitest';
import { avisoAntesDeCancelar, describirEdad, DIAS_SIN_PREGUNTA } from './avisoAntesDeCancelar';
import type { AttemptRow } from './attemptFormat';

const ahora = new Date('2026-09-04T15:00:00Z');
const hace = (horas: number) => new Date(ahora.getTime() - horas * 3_600_000).toISOString();
const noresp = (n: number): AttemptRow[] => Array.from({ length: n }, (_, i) => ({ result: 'noresp', id: String(i) }));

describe('avisoAntesDeCancelar', () => {
  it('frena un pedido que llegó hoy sin ningún intento', () => {
    const a = avisoAntesDeCancelar({ createdAt: hace(5), motivo: 'Se arrepintió', intentos: [], ahora });
    expect(a.frena).toBe(true);
    expect(a.lineas[0]).toBe('Este pedido llegó hoy, hace 5 h.');
    expect(a.lineas[1]).toBe('No hay ni un intento de llamada registrado.');
    expect(a.lineas.at(-1)).toContain('queda registrada a tu nombre');
    expect(a.lineas.at(-1)).toContain('Se arrepintió');
  });

  it('"No contesta" con 1 intento: dice cuántos pide la operación', () => {
    const a = avisoAntesDeCancelar({ createdAt: hace(30), motivo: 'No contesta', intentos: noresp(1), ahora });
    expect(a.frena).toBe(true);
    expect(a.titulo).toBe('¿Lo cancelás por no contestar?');
    expect(a.lineas[0]).toBe('Este pedido llegó ayer.');
    expect(a.lineas[1]).toBe('Se lo llamó 1 vez sin respuesta (la operación pide 3).');
    expect(a.alternativa).toBe('Volver a intentarlo');
  });

  it('un pedido de 2 días con los 3 intentos todavía pregunta (es joven), pero sin reproche por los intentos', () => {
    const a = avisoAntesDeCancelar({ createdAt: hace(50), motivo: 'No contesta', intentos: noresp(3), ahora });
    expect(a.frena).toBe(true);
    expect(a.lineas[0]).toBe('Este pedido lleva solo 2 días.');
    expect(a.lineas[1]).toBe('Se lo llamó 3 veces sin respuesta.');
  });

  it('un pedido trabajado varios días NO se frena', () => {
    const a = avisoAntesDeCancelar({ createdAt: hace(24 * DIAS_SIN_PREGUNTA), motivo: 'Se arrepintió', intentos: [], ahora });
    expect(a.frena).toBe(false);
  });

  it('las ediciones no cuentan como llamadas', () => {
    const intentos: AttemptRow[] = [{ result: 'edicion_orden' }, { result: 'cambio_transportadora' }];
    const a = avisoAntesDeCancelar({ createdAt: hace(3), motivo: 'Se arrepintió', intentos, ahora });
    expect(a.lineas[1]).toBe('No hay ni un intento de llamada registrado.');
  });

  it('motivos objetivos (duplicado, teléfono malo, zona) no preguntan', () => {
    for (const motivo of ['Duplicado', 'Teléfono malo', 'No llega a su zona']) {
      expect(avisoAntesDeCancelar({ createdAt: hace(1), motivo, intentos: [], ahora }).frena).toBe(false);
    }
  });

  it('no se repregunta por el mismo pedido', () => {
    const a = avisoAntesDeCancelar({ createdAt: hace(1), motivo: 'Se arrepintió', intentos: [], yaDecidio: true, ahora });
    expect(a.frena).toBe(false);
  });

  it('si el historial no se pudo leer, no afirma "cero intentos"', () => {
    const a = avisoAntesDeCancelar({ createdAt: hace(2), motivo: 'No contesta', intentos: [], intentosNoLeidos: true, ahora });
    expect(a.frena).toBe(true);
    expect(a.lineas[1]).toBe('No se pudo leer cuántas veces se lo llamó.');
  });

  it('usa la fecha del pedido (DD/MM/YYYY) cuando no hay createdAt', () => {
    const a = avisoAntesDeCancelar({ fecha: '03/09/2026', motivo: 'Se arrepintió', intentos: [], ahora });
    expect(a.frena).toBe(true);
    expect(a.lineas[0]).toBe('Este pedido llegó ayer.');
  });

  it('sin fecha y con los 3 intentos hechos no pregunta; sin fecha y sin intentos sí', () => {
    expect(avisoAntesDeCancelar({ motivo: 'No contesta', intentos: noresp(3), ahora }).frena).toBe(false);
    const a = avisoAntesDeCancelar({ motivo: 'No contesta', intentos: [], ahora });
    expect(a.frena).toBe(true);
    expect(a.lineas[0]).toBe('No hay ni un intento de llamada registrado.');
  });
});

describe('describirEdad', () => {
  it('describe en el idioma de la operación', () => {
    expect(describirEdad(new Date(ahora.getTime() - 20 * 60_000), ahora).texto).toBe('llegó hace menos de una hora');
    expect(describirEdad(new Date(hace(7)), ahora).texto).toBe('llegó hoy, hace 7 h');
    expect(describirEdad(new Date(hace(26)), ahora).texto).toBe('llegó ayer');
    expect(describirEdad(new Date(hace(49)), ahora).texto).toBe('lleva solo 2 días');
  });
});

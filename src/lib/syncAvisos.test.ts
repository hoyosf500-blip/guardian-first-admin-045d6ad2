import { describe, it, expect } from 'vitest';
import { esAvisoQueSeResuelveSolo, partirAvisos } from './syncAvisos';

const POSTERGADA = 'Postergada en esta corrida (rotación de presupuesto entre tiendas); se sincroniza en la próxima corrida del cron.';

describe('avisos de sync: problema vs se-resuelve-solo', () => {
  it('la postergación por rotación NO es una falla', () => {
    expect(esAvisoQueSeResuelveSolo({ status: 'warn', error_message: POSTERGADA })).toBe(true);
  });

  it('un error NUNCA es benigno, diga lo que diga el mensaje', () => {
    expect(esAvisoQueSeResuelveSolo({ status: 'error', error_message: POSTERGADA })).toBe(false);
  });

  it('el throttle de Dropi sigue pidiendo atención', () => {
    expect(esAvisoQueSeResuelveSolo({
      status: 'warn',
      error_message: 'Dropi throttle (429): el refresh de estatus quedó incompleto — Reintenta solo.',
    })).toBe(false);
  });

  it('un warn desconocido se trata como problema — ante la duda, avisar', () => {
    expect(esAvisoQueSeResuelveSolo({ status: 'warn', error_message: 'algo nuevo que nadie clasificó' })).toBe(false);
    expect(esAvisoQueSeResuelveSolo({ status: 'warn', error_message: '' })).toBe(false);
    expect(esAvisoQueSeResuelveSolo({})).toBe(false);
  });

  it('parte las filas sin perder ninguna', () => {
    const rows = [
      { status: 'warn', error_message: POSTERGADA },
      { status: 'error', error_message: 'api key inválida' },
      { status: 'warn', error_message: POSTERGADA },
    ];
    const { problemas, normales } = partirAvisos(rows);
    expect(normales).toHaveLength(2);
    expect(problemas).toHaveLength(1);
    expect(problemas.length + normales.length).toBe(rows.length);
  });
});

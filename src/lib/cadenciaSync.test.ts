import { describe, it, expect } from 'vitest';
import { cadenciaSyncMin, textoCadencia, type CorridaSync } from './cadenciaSync';

const AHORA = new Date('2026-08-21T21:00:00Z').getTime();

/** Corridas cada `cadaMin` minutos hacia atrás desde AHORA. */
const corridas = (cuantas: number, cadaMin: number, status = 'success'): CorridaSync[] =>
  Array.from({ length: cuantas }, (_, i) => ({
    status,
    created_at: new Date(AHORA - i * cadaMin * 60_000).toISOString(),
  }));

describe('cadenciaSyncMin — la cadencia se mide, no se promete', () => {
  it('mide el hueco típico entre corridas exitosas', () => {
    expect(cadenciaSyncMin(corridas(6, 20), AHORA)).toBe(20);
  });

  it('una pausa larga no estira el número (mediana, no promedio)', () => {
    // Cinco corridas cada 10 min y un hueco nocturno de 8 horas: el promedio
    // daría ~100 min y describiría una operación que no existe.
    const logs: CorridaSync[] = [
      ...corridas(5, 10),
      { status: 'success', created_at: new Date(AHORA - 8 * 60 * 60_000).toISOString() },
    ];
    expect(cadenciaSyncMin(logs, AHORA)).toBe(10);
  });

  it('las postergaciones NO cuentan como corridas', () => {
    // Rotación entre tiendas: intentos que no sincronizaron nada. Contarlos
    // haría parecer la cadencia el doble de rápida de lo que es.
    const logs: CorridaSync[] = [];
    for (let i = 0; i < 6; i++) {
      logs.push({ status: 'success', created_at: new Date(AHORA - i * 20 * 60_000).toISOString() });
      logs.push({ status: 'warn', created_at: new Date(AHORA - (i * 20 + 10) * 60_000).toISOString() });
    }
    expect(cadenciaSyncMin(logs, AHORA)).toBe(20);
  });
});

// ── GUARDIÁN ──────────────────────────────────────────────────────────
// Esta frase existe porque la anterior era un texto fijo («cada 5 min») que la
// operación desmintió cuatro veces. Si no se puede medir, la pantalla se calla:
// una frase ausente no engaña a nadie, un número inventado sí.
describe('GUARDIÁN: sin con qué medir, no se promete nada', () => {
  it('sin corridas, null y texto vacío', () => {
    expect(cadenciaSyncMin([], AHORA)).toBeNull();
    expect(cadenciaSyncMin(null, AHORA)).toBeNull();
    expect(textoCadencia([], AHORA)).toBe('');
  });

  it('con menos de tres corridas no alcanza para hablar de cadencia', () => {
    expect(cadenciaSyncMin(corridas(2, 15), AHORA)).toBeNull();
    expect(textoCadencia(corridas(2, 15), AHORA)).toBe('');
  });

  it('solo postergaciones = no se midió nada', () => {
    expect(cadenciaSyncMin(corridas(8, 10, 'warn'), AHORA)).toBeNull();
  });

  it('corridas viejas (+24 h) no describen la operación de hoy', () => {
    const viejas = corridas(6, 20).map((c) => ({
      ...c,
      created_at: new Date(new Date(c.created_at).getTime() - 3 * 24 * 60 * 60_000).toISOString(),
    }));
    expect(cadenciaSyncMin(viejas, AHORA)).toBeNull();
  });

  it('el texto respeta la escala', () => {
    expect(textoCadencia(corridas(6, 20), AHORA)).toBe('se revisa sola cada ~20 min');
    expect(textoCadencia(corridas(6, 120), AHORA)).toBe('se revisa sola cada ~2 horas');
  });
});

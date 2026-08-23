import { describe, it, expect } from 'vitest';
import { partirRango, partirALaMitad } from './rangoPorTramos';

describe('partirRango', () => {
  it('cubre el rango completo con los dos extremos incluidos', () => {
    const t = partirRango('2026-08-01', '2026-08-22', 7);
    expect(t[0][0]).toBe('2026-08-01');
    expect(t[t.length - 1][1]).toBe('2026-08-22');
  });

  it('los tramos son CONTIGUOS y DISJUNTOS: ni huecos ni días repetidos', () => {
    // Un día en dos tramos se contaría dos veces al sumar los totales y la tasa
    // de cancelación saldría inflada — error silencioso y creíble.
    const t = partirRango('2026-01-01', '2026-03-15', 7);
    for (let i = 1; i < t.length; i++) {
      const finAnterior = new Date(`${t[i - 1][1]}T00:00:00Z`).getTime();
      const inicioActual = new Date(`${t[i][0]}T00:00:00Z`).getTime();
      expect(inicioActual - finAnterior, `hueco o solape entre ${t[i - 1][1]} y ${t[i][0]}`)
        .toBe(86400000);
    }
  });

  it('cuenta exactamente los días del rango', () => {
    const t = partirRango('2026-08-01', '2026-08-22', 7);
    const dias = t.reduce((n, [a, b]) => {
      const d = (new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86400000 + 1;
      return n + d;
    }, 0);
    expect(dias).toBe(22);
  });

  it('un rango de un solo día da un tramo', () => {
    expect(partirRango('2026-08-22', '2026-08-22', 7)).toEqual([['2026-08-22', '2026-08-22']]);
  });

  it('no inventa tramos con entradas malas', () => {
    expect(partirRango('', '2026-08-22', 7)).toEqual([]);
    expect(partirRango('2026-08-22', '2026-08-01', 7)).toEqual([]);
    expect(partirRango('basura', 'peor', 7)).toEqual([]);
  });

  it('no se cuelga con paso 0 o negativo', () => {
    const t = partirRango('2026-08-01', '2026-08-05', 0);
    expect(t.length).toBe(5);
  });

  it('el último tramo se recorta, no se pasa del final', () => {
    const t = partirRango('2026-08-01', '2026-08-10', 7);
    expect(t).toEqual([['2026-08-01', '2026-08-07'], ['2026-08-08', '2026-08-10']]);
  });
});

describe('partirALaMitad', () => {
  it('parte en dos mitades contiguas', () => {
    expect(partirALaMitad('2026-08-01', '2026-08-08'))
      .toEqual([['2026-08-01', '2026-08-04'], ['2026-08-05', '2026-08-08']]);
  });

  it('un impar deja el día de más en la segunda mitad', () => {
    const p = partirALaMitad('2026-08-01', '2026-08-07');
    expect(p).toEqual([['2026-08-01', '2026-08-03'], ['2026-08-04', '2026-08-07']]);
  });

  it('un solo día NO se puede partir: null, no un tramo vacío', () => {
    // El que llama usa el null para dejar de reintentar y CONTAR el hueco en vez
    // de dar vueltas para siempre.
    expect(partirALaMitad('2026-08-01', '2026-08-01')).toBeNull();
    expect(partirALaMitad('2026-08-05', '2026-08-01')).toBeNull();
  });
});

describe('cuanto cuesta leer un rango', () => {
  // Medido en produccion el 23-ago-2026 sobre una tienda de EC: cada lote de
  // dos tramos de 5 dias tarda ~3 s. De ahi salen los topes.
  it('los rangos de trabajo entran holgados', () => {
    expect(partirRango('2026-08-01', '2026-08-23', 5).length).toBe(5);   // mes en curso
    expect(partirRango('2026-07-01', '2026-07-31', 5).length).toBe(7);   // el mes pasado
    expect(partirRango('2026-07-25', '2026-08-23', 5).length).toBe(6);   // 30d
  });

  it('los rangos largos son los que hay que frenar', () => {
    // 90d = 18 consultas (~27 s) · 365d = 73 (~2 min). Antes del troceo estos
    // fallaban rapido; con tramos muelen la base mientras el equipo trabaja.
    expect(partirRango('2026-05-26', '2026-08-23', 5).length).toBe(18);
    expect(partirRango('2025-08-24', '2026-08-23', 5).length).toBe(73);
  });
});

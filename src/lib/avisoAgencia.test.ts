import { describe, it, expect } from 'vitest';
import {
  esAvisoAgencia,
  estadoAvisoAgencia,
  diasDesdeAviso,
  resumenAvisos,
  AVISO_AGENCIA_ACTION,
} from './avisoAgencia';
import { metodosParaEstado } from './segMetodosEstado';

const H = 3600_000;
const D = 24 * H;
const AHORA = Date.UTC(2026, 7, 22, 15, 0, 0);

describe('esAvisoAgencia', () => {
  it('reconoce el método tal como lo escribe la botonera', () => {
    expect(esAvisoAgencia(`SEG: ${AVISO_AGENCIA_ACTION}`)).toBe(true);
    expect(esAvisoAgencia(AVISO_AGENCIA_ACTION)).toBe(true);
  });

  it('reconoce el histórico escrito sin acentos ni dos puntos', () => {
    // Un aviso que no se reconoce se lee como "nunca se avisó" y manda a
    // repetir una llamada ya hecha.
    expect(esAvisoAgencia('SEG: Avise: en oficina')).toBe(true);
    expect(esAvisoAgencia('avise en oficina')).toBe(true);
    expect(esAvisoAgencia('SEG: AVISÉ: EN OFICINA')).toBe(true);
  });

  it('no confunde los otros métodos de la botonera', () => {
    for (const a of [
      'SEG: Llamé', 'SEG: WhatsApp', 'SEG: Avisé que llega hoy',
      'SEG: Avisé que va en camino', 'SEG: Cliente recoge', 'SEG: Resuelto',
    ]) {
      expect(esAvisoAgencia(a), a).toBe(false);
    }
    expect(esAvisoAgencia(null)).toBe(false);
    expect(esAvisoAgencia('')).toBe(false);
  });
});

describe('el aviso cuenta solo si es de ESTA estadía', () => {
  const llegadaMs = AHORA - 3 * D;

  it('un aviso posterior a la llegada vale', () => {
    expect(estadoAvisoAgencia({ llegadaMs, avisoMs: AHORA - 2 * D })).toBe('avisado');
  });

  it('un aviso ANTERIOR a la llegada NO vale', () => {
    // Los touchpoints matchean por teléfono: es el aviso de un pedido previo
    // del mismo cliente. Darlo por bueno saca de la cola, en silencio, a un
    // paquete que nadie avisó.
    expect(estadoAvisoAgencia({ llegadaMs, avisoMs: AHORA - 40 * D })).toBe('sin_avisar');
  });

  it('sin aviso es trabajo pendiente', () => {
    expect(estadoAvisoAgencia({ llegadaMs, avisoMs: null })).toBe('sin_avisar');
  });

  it('sin reloj de llegada NO se afirma nada', () => {
    // Ni "avisado" ni "sin avisar": no hay contra qué validar el aviso.
    expect(estadoAvisoAgencia({ llegadaMs: null, avisoMs: AHORA - D })).toBe('sin_dato');
    expect(estadoAvisoAgencia({})).toBe('sin_dato');
  });

  it('el empate exacto cuenta como avisado', () => {
    expect(estadoAvisoAgencia({ llegadaMs, avisoMs: llegadaMs })).toBe('avisado');
  });
});

describe('diasDesdeAviso', () => {
  it('cuenta días enteros desde el aviso', () => {
    const llegadaMs = AHORA - 6 * D;
    expect(diasDesdeAviso({ llegadaMs, avisoMs: AHORA - 2 * D - H }, AHORA)).toBe(2);
    expect(diasDesdeAviso({ llegadaMs, avisoMs: AHORA - 3 * H }, AHORA)).toBe(0);
  });

  it('null cuando no hay aviso válido — no cero', () => {
    expect(diasDesdeAviso({ llegadaMs: AHORA - D, avisoMs: null }, AHORA)).toBeNull();
    expect(diasDesdeAviso({ llegadaMs: null, avisoMs: AHORA - D }, AHORA)).toBeNull();
  });
});

describe('resumenAvisos', () => {
  it('los tres estados se cuentan por separado', () => {
    const llegadaMs = AHORA - 4 * D;
    const r = resumenAvisos([
      { llegadaMs, avisoMs: AHORA - D },        // avisado
      { llegadaMs, avisoMs: null },             // sin avisar
      { llegadaMs, avisoMs: AHORA - 50 * D },   // aviso viejo → sin avisar
      { llegadaMs: null, avisoMs: null },       // sin dato
    ]);
    expect(r).toEqual({ avisados: 1, sinAvisar: 2, sinDato: 1, total: 4 });
  });

  it('los tres suman el total: nada se pierde por el camino', () => {
    const entradas = [
      { llegadaMs: AHORA - D, avisoMs: AHORA },
      { llegadaMs: null },
      { llegadaMs: AHORA - 2 * D },
    ];
    const r = resumenAvisos(entradas);
    expect(r.avisados + r.sinAvisar + r.sinDato).toBe(r.total);
  });

  it('sin datos no inventa ni trabajo hecho ni trabajo pendiente', () => {
    const r = resumenAvisos([{ llegadaMs: null }, { llegadaMs: null }]);
    expect(r.avisados).toBe(0);
    expect(r.sinAvisar).toBe(0);
    expect(r.sinDato).toBe(2);
  });
});

describe('el botón y el detector no se pueden separar', () => {
  // Auditoría 23-ago-2026. El texto vive DOS veces: como opción de botón en
  // `segMetodosEstado.ts` y como literal dentro de `esAvisoAgencia`. Si alguien
  // renombra el botón (p. ej. a «Avisé que está en oficina»), la asesora sigue
  // pudiendo marcarlo pero el detector deja de reconocerlo: TODOS los paquetes
  // quedan "sin avisar" para siempre y la barra «Lo que sigue» manda a avisarle
  // a gente a la que ya se le avisó. Una barra que pide trabajo hecho se
  // aprende a ignorar, así que el fallo sería silencioso Y caro.
  it('la opción que ofrece la fase «oficina» la reconoce el detector', () => {
    const metodos = metodosParaEstado('RECLAME EN OFICINA');
    const avisos = metodos.filter((m) => esAvisoAgencia(m));
    expect(avisos.length).toBeGreaterThan(0);
  });

  it('AVISO_AGENCIA_ACTION es una de las opciones reales de esa fase', () => {
    expect(metodosParaEstado('RECLAME EN OFICINA')).toContain(AVISO_AGENCIA_ACTION);
  });

  it('el detector reconoce el texto tal como se guarda, con prefijo de módulo', () => {
    // `useRecordGestion` guarda `${module}: ${action}` → «SEG: Avisé: en oficina».
    expect(esAvisoAgencia(`SEG: ${AVISO_AGENCIA_ACTION}`)).toBe(true);
  });

  it('no confunde los otros avisos de la botonera', () => {
    expect(esAvisoAgencia('SEG: Avisé que va en camino')).toBe(false);
    expect(esAvisoAgencia('SEG: Avisé que llega hoy')).toBe(false);
  });
});

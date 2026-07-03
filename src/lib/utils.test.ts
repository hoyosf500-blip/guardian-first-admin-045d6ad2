import { describe, it, expect, afterEach } from 'vitest';
import { bogotaToday, formatCOP, setCurrencyCountry, cn } from './utils';

describe('formatCOP', () => {
  it('formatea entero como peso colombiano', () => {
    const formatted = formatCOP(1500000);
    // Locale es-CO usa puntos como separador de miles. El símbolo
    // exacto puede ser "$" o "COP" según versión de Intl, así que
    // chequeamos que tenga el grupo de dígitos esperado.
    expect(formatted).toMatch(/1\.500\.000/);
  });

  it('redondea decimales (COP no usa centavos)', () => {
    const formatted = formatCOP(1500.99);
    expect(formatted).toMatch(/1\.501/);
  });

  it('devuelve $0 para null', () => {
    expect(formatCOP(null)).toBe('$0');
  });

  it('devuelve $0 para undefined', () => {
    expect(formatCOP(undefined)).toBe('$0');
  });

  it('devuelve $0 para NaN', () => {
    expect(formatCOP(NaN)).toBe('$0');
  });

  it('devuelve $0 para Infinity', () => {
    expect(formatCOP(Infinity)).toBe('$0');
  });

  it('formatea cero explícito', () => {
    expect(formatCOP(0)).toMatch(/0/);
  });

  it('formatea negativos sin crashear', () => {
    const formatted = formatCOP(-100);
    expect(formatted).toMatch(/100/);
  });
});

describe('bogotaToday', () => {
  it('devuelve string ISO YYYY-MM-DD', () => {
    const today = bogotaToday();
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('es estable dentro del mismo segundo', () => {
    const a = bogotaToday();
    const b = bogotaToday();
    expect(a).toBe(b);
  });
});

describe('cn (clsx + tailwind-merge)', () => {
  it('combina clases sin conflicto', () => {
    expect(cn('px-4', 'py-2')).toBe('px-4 py-2');
  });

  it('resuelve conflictos de tailwind por especificidad última', () => {
    expect(cn('px-4', 'px-8')).toBe('px-8');
  });

  it('ignora valores falsy', () => {
    expect(cn('px-4', false, null, undefined, 'py-2')).toBe('px-4 py-2');
  });
});

describe('formatCOP multi-país (EC = USD con centavos)', () => {
  afterEach(() => setCurrencyCountry('CO'));

  it('con tienda EC activa formatea USD con 2 decimales', () => {
    setCurrencyCountry('EC');
    const s = formatCOP(4734.53);
    expect(s).toContain('4');
    expect(s).toMatch(/53/); // conserva los centavos que COP entero borraba
  });

  it('EC: null/NaN devuelven $0,00', () => {
    setCurrencyCountry('EC');
    expect(formatCOP(null)).toBe('$0,00');
    expect(formatCOP(NaN)).toBe('$0,00');
  });

  it('al volver a CO se restaura el formato COP entero', () => {
    setCurrencyCountry('EC');
    setCurrencyCountry('CO');
    expect(formatCOP(null)).toBe('$0');
  });
});

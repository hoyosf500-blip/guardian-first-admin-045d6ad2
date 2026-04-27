import { describe, it, expect } from 'vitest';
import {
  dbToOrderData,
  parseDate,
  calcDias,
  cleanPhone,
  formatPhone,
  getWhatsAppPhone,
  isPendiente,
  isDespachado,
  isConfirmado,
  isNovedad,
  isOficina,
  isDevolucion,
  getTrackingUrl,
  truncate,
  getErrorMessage,
} from './orderUtils';

describe('parseDate', () => {
  it('parses ISO format YYYY-MM-DD', () => {
    const d = parseDate('2026-04-15');
    expect(d).not.toBeNull();
    expect(d!.getUTCFullYear()).toBe(2026);
    expect(d!.getUTCMonth()).toBe(3); // April = 3
    expect(d!.getUTCDate()).toBe(15);
  });

  it('parses DD/MM/YYYY format', () => {
    const d = parseDate('15/04/2026');
    expect(d).not.toBeNull();
    expect(d!.getUTCFullYear()).toBe(2026);
    expect(d!.getUTCMonth()).toBe(3);
    expect(d!.getUTCDate()).toBe(15);
  });

  it('parses DD-MM-YYYY format', () => {
    const d = parseDate('15-04-2026');
    expect(d).not.toBeNull();
    expect(d!.getUTCDate()).toBe(15);
  });

  it('handles 2-digit years', () => {
    const d = parseDate('15/04/26');
    expect(d).not.toBeNull();
    expect(d!.getUTCFullYear()).toBe(2026);
  });

  it('returns null for empty/invalid strings', () => {
    expect(parseDate('')).toBeNull();
    expect(parseDate('undefined')).toBeNull();
    expect(parseDate('not-a-date')).toBeNull();
  });
});

describe('calcDias', () => {
  it('returns 0 for today', () => {
    const today = new Date().toISOString().split('T')[0];
    expect(calcDias(today)).toBe(0);
  });

  it('returns 0 for invalid dates', () => {
    expect(calcDias('')).toBe(0);
    expect(calcDias('garbage')).toBe(0);
  });

  it('returns positive days for past dates', () => {
    const past = new Date(Date.now() - 5 * 86400000).toISOString().split('T')[0];
    const dias = calcDias(past);
    expect(dias).toBeGreaterThanOrEqual(4);
    expect(dias).toBeLessThanOrEqual(6);
  });
});

describe('cleanPhone', () => {
  it('strips non-numeric characters', () => {
    expect(cleanPhone('+57 311 234 5678')).toBe('573112345678');
    expect(cleanPhone('(311) 234-5678')).toBe('3112345678');
  });

  it('handles already-clean phones', () => {
    expect(cleanPhone('3112345678')).toBe('3112345678');
  });
});

describe('formatPhone', () => {
  it('formats 10-digit Colombian numbers', () => {
    expect(formatPhone('3112345678')).toBe('311 234 5678');
  });

  it('returns as-is for non-10-digit numbers', () => {
    expect(formatPhone('573112345678')).toBe('573112345678');
    expect(formatPhone('12345')).toBe('12345');
  });
});

describe('getWhatsAppPhone', () => {
  it('prepends 57 to 10-digit numbers', () => {
    expect(getWhatsAppPhone('3112345678')).toBe('573112345678');
  });

  it('keeps 12-digit numbers starting with 57', () => {
    expect(getWhatsAppPhone('573112345678')).toBe('573112345678');
  });

  it('handles numbers with spaces/dashes', () => {
    expect(getWhatsAppPhone('311 234 5678')).toBe('573112345678');
  });
});

describe('status checkers', () => {
  describe('isPendiente', () => {
    it('matches PENDIENTE CONFIRMACION', () => {
      expect(isPendiente('PENDIENTE CONFIRMACION')).toBe(true);
      expect(isPendiente('pendiente confirmacion')).toBe(true);
    });
    it('rejects other states', () => {
      expect(isPendiente('PENDIENTE')).toBe(false);
      expect(isPendiente('ENTREGADO')).toBe(false);
    });
  });

  describe('isDespachado', () => {
    it('matches dispatch-related states', () => {
      expect(isDespachado('EN REPARTO')).toBe(true);
      expect(isDespachado('EN DISTRIBUCION')).toBe(true);
      expect(isDespachado('ADMITIDA')).toBe(true);
      expect(isDespachado('DESPACHADO')).toBe(true);
    });
    it('rejects non-dispatch states', () => {
      expect(isDespachado('PENDIENTE')).toBe(false);
      expect(isDespachado('NOVEDAD')).toBe(false);
    });
  });

  describe('isConfirmado', () => {
    it('matches confirmed-waiting states', () => {
      expect(isConfirmado('PENDIENTE')).toBe(true);
      expect(isConfirmado('ALISTAMIENTO')).toBe(true);
      expect(isConfirmado('EN BODEGA DROPI')).toBe(true);
    });
  });

  describe('isNovedad', () => {
    it('matches novedad and intento de entrega', () => {
      expect(isNovedad('NOVEDAD')).toBe(true);
      expect(isNovedad('INTENTO DE ENTREGA')).toBe(true);
    });
    it('rejects other states', () => {
      expect(isNovedad('ENTREGADO')).toBe(false);
    });
  });

  describe('isOficina', () => {
    it('matches office states', () => {
      expect(isOficina('RECLAME EN OFICINA')).toBe(true);
    });
  });

  describe('isDevolucion', () => {
    it('matches return states', () => {
      expect(isDevolucion('DEVOLUCION')).toBe(true);
      expect(isDevolucion('EN DEVOLUCION')).toBe(true);
    });
  });
});

describe('getTrackingUrl', () => {
  it('returns URL for known carriers', () => {
    const url = getTrackingUrl('TCC', '12345');
    expect(url).not.toBeNull();
    expect(url).toContain('tcc.com.co');
  });

  it('appends guia for carriers with = suffix', () => {
    const url = getTrackingUrl('ENVIA', '12345');
    expect(url).not.toBeNull();
    expect(url).toContain('12345');
  });

  it('returns null for unknown carriers', () => {
    expect(getTrackingUrl('DESCONOCIDA', '12345')).toBeNull();
  });
});

describe('dbToOrderData', () => {
  it('maps DB row fields to OrderData', () => {
    const row = {
      id: 'uuid-123',
      external_id: 'EXT-456',
      nombre: 'Juan',
      phone: '3112345678',
      ciudad: 'Bogotá',
      producto: 'Crema',
      estado: 'PENDIENTE',
      fecha: '2026-04-10',
      fecha_conf: '2026-04-11',
      dias: 5,
      dias_conf: 4,
      valor: 50000,
      flete: 8000,
      costo_prod: 15000,
      costo_dev: 5000,
      cantidad: 2,
      direccion: 'Calle 1 # 2-3',
      novedad: '',
      guia: 'G123',
      transportadora: 'TCC',
      tags: '',
      departamento: 'Cundinamarca',
      tienda: 'Mi tienda',
      novedad_sol: false,
    };
    const order = dbToOrderData(row, 0);
    expect(order.dbId).toBe('uuid-123');
    expect(order.externalId).toBe('EXT-456');
    expect(order.nombre).toBe('Juan');
    expect(order.valor).toBe(50000);
    expect(order.cantidad).toBe(2);
    expect(order.novedadSol).toBe(false);
  });

  it('handles missing fields with defaults', () => {
    const row = { id: 'x', nombre: 'Ana', phone: '311' };
    const order = dbToOrderData(row, 5);
    expect(order.idx).toBe(5);
    expect(order.externalId).toBe('');
    expect(order.estado).toBe('');
    expect(order.valor).toBe(0);
    expect(order.cantidad).toBe(1);
    expect(order.novedadSol).toBe(false);
  });
});

describe('truncate', () => {
  it('truncates long strings', () => {
    expect(truncate('Hello World', 5)).toBe('Hello…');
  });

  it('returns short strings unchanged', () => {
    expect(truncate('Hi', 10)).toBe('Hi');
  });
});

describe('getErrorMessage', () => {
  it('extracts message from Error instance', () => {
    expect(getErrorMessage(new Error('test fail'))).toBe('test fail');
  });

  it('returns string errors as-is', () => {
    expect(getErrorMessage('network down')).toBe('network down');
  });

  it('returns fallback for null', () => {
    expect(getErrorMessage(null)).toBe('Error desconocido');
  });

  it('returns fallback for undefined', () => {
    expect(getErrorMessage(undefined)).toBe('Error desconocido');
  });

  it('returns fallback for numeric errors', () => {
    expect(getErrorMessage(42)).toBe('Error desconocido');
  });

  it('returns fallback for object errors', () => {
    expect(getErrorMessage({ code: 500 })).toBe('Error desconocido');
  });
});

describe('dbToOrderData typed', () => {
  it('handles fully null DB row gracefully', () => {
    const order = dbToOrderData({}, 0);
    expect(order.nombre).toBe('');
    expect(order.phone).toBe('');
    expect(order.valor).toBe(0);
    expect(order.novedadSol).toBe(false);
    expect(order.externalId).toBe('');
    expect(order.dbId).toBeUndefined();
  });

  it('preserves valid DB values', () => {
    const order = dbToOrderData({
      id: 'db-123',
      external_id: 'EXT-456',
      nombre: 'Maria',
      phone: '3101234567',
      valor: 85000,
      estado: 'EN REPARTO',
      transportadora: 'TCC',
      novedad_sol: true,
    }, 5);
    expect(order.dbId).toBe('db-123');
    expect(order.externalId).toBe('EXT-456');
    expect(order.nombre).toBe('Maria');
    expect(order.valor).toBe(85000);
    expect(order.estado).toBe('EN REPARTO');
    expect(order.novedadSol).toBe(true);
    expect(order.idx).toBe(5);
  });
});

// src/lib/buildWhatsAppMessage.test.ts
import { describe, it, expect } from 'vitest';
import { buildWhatsAppMessage } from './buildWhatsAppMessage';

describe('buildWhatsAppMessage', () => {
  it('placa faltante', () => {
    const m = buildWhatsAppMessage({ missing_fields: ['placa'], nombre: 'Carlos' });
    expect(m).toMatch(/Carlos/);
    expect(m).toMatch(/placa|número/i);
  });
  it('barrio faltante', () => {
    const m = buildWhatsAppMessage({ missing_fields: ['barrio'], nombre: 'María' });
    expect(m).toMatch(/María/);
    expect(m).toMatch(/barrio/i);
  });
  it('múltiples campos', () => {
    const m = buildWhatsAppMessage({ missing_fields: ['placa', 'barrio'], nombre: 'Juan' });
    expect(m).toMatch(/placa|número/i);
    expect(m).toMatch(/barrio/i);
  });
  it('saludo genérico si nombre vacío', () => {
    const m = buildWhatsAppMessage({ missing_fields: ['placa'], nombre: '' });
    expect(m.startsWith('Hola')).toBe(true);
  });
  it('campo desconocido genera mensaje genérico', () => {
    const m = buildWhatsAppMessage({ missing_fields: ['xyz'], nombre: 'Pedro' });
    expect(m).toMatch(/dirección/i);
  });
  it('vacío retorna string vacío', () => {
    expect(buildWhatsAppMessage({ missing_fields: [], nombre: 'Pedro' })).toBe('');
  });
  it('incluye producto si se pasa', () => {
    const m = buildWhatsAppMessage({ missing_fields: ['placa'], nombre: 'Ana', producto: 'Reloj' });
    expect(m).toMatch(/Reloj/);
  });
});

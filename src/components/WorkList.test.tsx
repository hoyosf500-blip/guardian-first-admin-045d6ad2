import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { diasReales } from './WorkList';
import type { OrderData } from '@/lib/orderUtils';

/**
 * La edad del pedido decide el color de la fila y los chips "D7+: cancelar" /
 * "D4-6 urgente". Calculada sobre ms transcurridos rodaba a las 00:00 UTC =
 * 19:00 Bogotá: entre las 7pm y la medianoche toda la cola envejecía un día y
 * un D6 (todavía en ventana de rescate) entraba a "cancelar".
 */
const order = (fecha: string, dias?: number) => ({ fecha, dias } as OrderData);

describe('diasReales — edad en calendario Bogotá', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('no envejece el pedido después de las 7pm Bogotá', () => {
    // 2026-08-01T00:30Z = 31-jul 19:30 en Bogotá. Pedido del 25-jul → D6.
    vi.setSystemTime(new Date('2026-08-01T00:30:00Z'));
    expect(diasReales(order('2026-07-25'))).toBe(6);
  });

  it('da el MISMO número a la mañana y a la noche del mismo día Bogotá', () => {
    vi.setSystemTime(new Date('2026-07-31T14:00:00Z')); // 9:00 Bogotá
    const manana = diasReales(order('2026-07-25'));
    vi.setSystemTime(new Date('2026-08-01T04:00:00Z')); // 23:00 Bogotá, mismo día
    expect(diasReales(order('2026-07-25'))).toBe(manana);
  });

  it('cuenta 0 para un pedido de hoy', () => {
    vi.setSystemTime(new Date('2026-08-01T00:30:00Z'));
    expect(diasReales(order('2026-07-31'))).toBe(0);
  });

  it('cae a o.dias si la fecha no parsea', () => {
    vi.setSystemTime(new Date('2026-08-01T00:30:00Z'));
    expect(diasReales(order('sin fecha', 3))).toBe(3);
  });
});

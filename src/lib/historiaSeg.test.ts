import { describe, it, expect } from 'vitest';
import { HISTORIA_KEYS } from '@/components/seguimiento/SegBoard';
import { FASES_VIVAS } from './segPulso';
import type { SegStatusKey } from './segStatus';

/**
 * El tablero de Seguimiento pliega tres columnas por defecto (21-ago-2026) para
 * bajar el ruido: de 14 columnas, tres no le dan trabajo a nadie.
 *
 * Estas pruebas fijan la REGLA DE CORTE, que no es "¿está terminado?" sino
 * "¿alguien puede hacer algo con esto?". Confundirlas esconde trabajo real.
 */
describe('HISTORIA_KEYS — qué se pliega en el tablero', () => {
  it('son exactamente las tres fases sin nada que hacer', () => {
    expect([...HISTORIA_KEYS].sort()).toEqual(['cancelado', 'entregado', 'indemnizada']);
  });

  // ── GUARDIÁN ──────────────────────────────────────────────────────
  // Estas tres son TERMINALES pero tienen trabajo: la llamada de rescate.
  // En julio EC, 32 de 49 pedidos re-emitidos terminaron ENTREGADOS — plegarlas
  // esconde ventas recuperables detrás de un botón que nadie va a tocar.
  it('NO pliega las fases donde todavía se puede rescatar la venta', () => {
    for (const k of ['devolucion', 'devolucion_transito', 'rechazado'] as SegStatusKey[]) {
      expect(HISTORIA_KEYS.has(k), `${k} tiene trabajo de rescate y no se puede plegar`).toBe(false);
    }
  });

  it('nunca pliega una fase VIVA', () => {
    for (const k of FASES_VIVAS) {
      expect(HISTORIA_KEYS.has(k), `${k} es una fase viva`).toBe(false);
    }
  });
});

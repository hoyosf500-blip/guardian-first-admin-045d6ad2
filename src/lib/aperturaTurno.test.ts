import { describe, it, expect } from 'vitest';
import { decidirApertura, VENTANA_APERTURA_MS } from './aperturaTurno';

/**
 * El caso que originó estos tests (dueño, 2026-07-19): "ya hice apertura, pero
 * si cierro el CRM y vuelvo a entrar sin hacer cierre, no me tiene que volver a
 * contar la apertura".
 *
 * En la BASE eso ya estaba bien —se verificó contra la función desplegada: el
 * ON CONFLICT de record_operator_heartbeat no toca first_action_at—. El agujero
 * estaba en la pantalla, que mostraba el reloj local y se guiaba solo por
 * localStorage (por navegador, por equipo, se borra con la caché).
 */

const AHORA = new Date('2026-07-19T14:00:00Z').getTime();
const haceSegundos = (s: number) => new Date(AHORA - s * 1000).toISOString();

describe('decidirApertura', () => {
  it('apertura genuina: marca recién sellada → saluda y muestra ESA hora', () => {
    const marca = haceSegundos(1);
    expect(decidirApertura({ esAdmin: false, marcaEntrada: marca, ahora: AHORA }))
      .toEqual({ saludar: true, horaSellada: marca });
  });

  it('RE-ENTRADA: abrió a la mañana y vuelve 6 horas después → NO saluda', () => {
    // Cerró el CRM sin hacer cierre y volvió a entrar. Es el bug que el dueño
    // pidió blindar: no se puede volver a contar la apertura.
    expect(decidirApertura({
      esAdmin: false,
      marcaEntrada: haceSegundos(6 * 60 * 60),
      ahora: AHORA,
    })).toEqual({ saludar: false, horaSellada: null });
  });

  it('re-entrada corta (5 min) tampoco cuenta como apertura', () => {
    expect(decidirApertura({ esAdmin: false, marcaEntrada: haceSegundos(300), ahora: AHORA }).saludar)
      .toBe(false);
  });

  it('nunca muestra hora que no venga del servidor', () => {
    // Sin marca se saluda igual (la bienvenida no depende de la base), pero el
    // chip queda oculto: inventar una hora que después no cuadra con el reporte
    // del dueño es peor que no mostrarla.
    expect(decidirApertura({ esAdmin: false, marcaEntrada: null, ahora: AHORA }))
      .toEqual({ saludar: true, horaSellada: null });
  });

  it('marca corrupta se trata como ausente, no se adivina', () => {
    expect(decidirApertura({ esAdmin: false, marcaEntrada: 'no-es-fecha', ahora: AHORA }))
      .toEqual({ saludar: true, horaSellada: null });
  });

  it('al admin se lo saluda pero NUNCA se le anuncia turno', () => {
    // No ficha jornada. Ni siquiera con una marca fresca debe salir el chip.
    expect(decidirApertura({ esAdmin: true, marcaEntrada: haceSegundos(1), ahora: AHORA }))
      .toEqual({ saludar: true, horaSellada: null });
    expect(decidirApertura({ esAdmin: true, marcaEntrada: null, ahora: AHORA }))
      .toEqual({ saludar: true, horaSellada: null });
  });

  describe('borde exacto de la ventana', () => {
    it('justo por dentro todavía es apertura', () => {
      const marca = new Date(AHORA - (VENTANA_APERTURA_MS - 1)).toISOString();
      expect(decidirApertura({ esAdmin: false, marcaEntrada: marca, ahora: AHORA }).saludar).toBe(true);
    });

    it('justo al cumplirse ya es re-entrada', () => {
      const marca = new Date(AHORA - VENTANA_APERTURA_MS).toISOString();
      expect(decidirApertura({ esAdmin: false, marcaEntrada: marca, ahora: AHORA }).saludar).toBe(false);
    });
  });

  it('una marca en el futuro (reloj del equipo adelantado) no rompe: sigue siendo apertura', () => {
    // Si el PC de la operadora tiene la hora adelantada, `ahora - t` da
    // negativo. Negativo < ventana → apertura. Es el resultado correcto: la
    // marca es del servidor y acaba de crearse.
    const marca = new Date(AHORA + 60_000).toISOString();
    expect(decidirApertura({ esAdmin: false, marcaEntrada: marca, ahora: AHORA }))
      .toEqual({ saludar: true, horaSellada: marca });
  });
});

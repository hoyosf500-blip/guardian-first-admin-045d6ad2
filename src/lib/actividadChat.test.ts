import { describe, it, expect } from 'vitest';
import {
  derivarActividadChat,
  type MensajeChat,
} from '../../supabase/functions/_shared/senalConfirmacion';
import { veredictoAviso, haceCuantoMs, type ActividadChatOrden } from './actividadChat';

/**
 * "Hay 75 pedidos en oficina, me dicen que ya les escribieron — ¿cómo
 * verifico yo eso?" (dueño, 24-ago-2026). Estas pruebas fijan las dos mitades:
 * qué cuenta como "le escribimos" (derivado del export real de ImporChat) y
 * cómo se compara contra el reloj de llegada sin inventar datos.
 */

const msg = (rol: string, tipo: string, fechaMs: number, plantilla: string | null = null): MensajeChat => ({
  rol, tipo, texto: 'x', plantilla, fecha: new Date(fechaMs),
});

const H = 3_600_000;

describe('derivarActividadChat — ¿le escribimos? ¿nos escribió?', () => {
  it('sin historial no afirma nada (null ≠ "no le escribieron")', () => {
    expect(derivarActividadChat(null)).toEqual({ salienteAt: null, salienteTipo: null, entranteAt: null });
    expect(derivarActividadChat([])).toEqual({ salienteAt: null, salienteTipo: null, entranteAt: null });
  });

  it('toma el ÚLTIMO saliente y su tipo (template → plantilla)', () => {
    const a = derivarActividadChat([
      msg('Propietario', 'template', 1 * H, 'confirmacion_pedido_k1'),
      msg('Propietario', 'text', 5 * H),
      msg('Cliente', 'text', 3 * H),
    ]);
    expect(a.salienteAt?.getTime()).toBe(5 * H);
    expect(a.salienteTipo).toBe('directo');
    expect(a.entranteAt?.getTime()).toBe(3 * H);
  });

  it('si lo último que salió fue una plantilla, lo dice', () => {
    const a = derivarActividadChat([
      msg('Propietario', 'text', 1 * H),
      msg('Propietario', 'template', 9 * H, 'retiro_agencia_recordatorio_k3'),
    ]);
    expect(a.salienteTipo).toBe('plantilla');
    expect(a.salienteAt?.getTime()).toBe(9 * H);
  });

  // "Te has asignado este chat" es tráfico interno del panel: contarlo como
  // "le escribimos al cliente" convertiría cada reasignación en un aviso falso.
  it('las notificaciones internas y los borrados NO cuentan como mensaje', () => {
    const a = derivarActividadChat([
      msg('Notificacion (transferencia)', 'notificacion', 10 * H),
      msg('Propietario', 'revoke', 12 * H),
    ]);
    expect(a.salienteAt).toBeNull();
    expect(a.entranteAt).toBeNull();
  });

  it('un botón apretado cuenta como actividad del cliente', () => {
    const a = derivarActividadChat([msg('Cliente', 'button', 2 * H)]);
    expect(a.entranteAt?.getTime()).toBe(2 * H);
  });
});

describe('veredictoAviso — comparar contra la llegada a la agencia', () => {
  const act = (salienteAt: number | null, tipo: 'plantilla' | 'directo' | null = 'directo'): ActividadChatOrden => ({
    salienteAt, salienteTipo: salienteAt == null ? null : tipo, entranteAt: null, leidoAt: 100 * H,
  });

  it('mensaje DESPUÉS de la llegada = avisado verificado', () => {
    expect(veredictoAviso(act(50 * H), 40 * H)).toBe('escrito_despues');
  });

  it('mensaje solo ANTES de la llegada = nadie le avisó de ESTE paquete', () => {
    expect(veredictoAviso(act(30 * H), 40 * H)).toBe('escrito_antes');
  });

  it('conversación leída y CERO salientes = nunca se le escribió (esto sí se afirma)', () => {
    expect(veredictoAviso(act(null), 40 * H)).toBe('nunca_escrito');
    // …incluso sin reloj de llegada: "jamás le escribieron" no necesita comparación.
    expect(veredictoAviso(act(null), null)).toBe('nunca_escrito');
  });

  it('sin reloj de llegada no se afirma "después": se degrada a escrito_sin_reloj', () => {
    expect(veredictoAviso(act(50 * H), null)).toBe('escrito_sin_reloj');
  });

  it('sin actividad leída no se afirma NADA', () => {
    expect(veredictoAviso(null, 40 * H)).toBe('sin_dato');
    expect(veredictoAviso(undefined, 40 * H)).toBe('sin_dato');
  });
});

describe('haceCuantoMs', () => {
  const ahora = 1000 * H;
  it('minutos, horas y días', () => {
    expect(haceCuantoMs(ahora - 30 * 60_000, ahora)).toBe('hace 30 min');
    expect(haceCuantoMs(ahora - 5 * H, ahora)).toBe('hace 5 h');
    expect(haceCuantoMs(ahora - 72 * H, ahora)).toBe('hace 3 días');
  });
  it('un reloj corrido no inventa "hace -2 h"', () => {
    expect(haceCuantoMs(ahora + H, ahora)).toBe('recién');
  });
});

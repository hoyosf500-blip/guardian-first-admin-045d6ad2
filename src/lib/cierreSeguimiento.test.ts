import { describe, it, expect } from 'vitest';
import { decidirCierre, motivoSuficiente, MOTIVO_MIN_CHARS } from './cierreSeguimiento';

describe('decidirCierre — las dos únicas salidas del día', () => {
  it('cola trabajada entera: cierra sin explicar nada', () => {
    const d = decidirCierre({ cola: 12, gestionados: 12 });
    expect(d.tipo).toBe('en_cero');
    expect(d.puedeCerrar).toBe(true);
    expect(d.exigeMotivo).toBe(false);
    expect(d.faltan).toBe(0);
  });

  it('día sin trabajo accionable también es un cierre en cero', () => {
    // Y lo dice distinto: "no entró trabajo" no es lo mismo que "lo hice todo".
    const d = decidirCierre({ cola: 0, gestionados: 0 });
    expect(d.tipo).toBe('en_cero');
    expect(d.detalle).toMatch(/no entró trabajo/i);
  });

  it('con pendientes exige motivo escrito', () => {
    const d = decidirCierre({ cola: 20, gestionados: 14 });
    expect(d.tipo).toBe('con_pendientes');
    expect(d.faltan).toBe(6);
    expect(d.exigeMotivo).toBe(true);
    expect(d.puedeCerrar).toBe(true);
  });

  it('más gestionados que la cola no da negativos', () => {
    // Puede pasar si una compañera gestionó algo que ya salió de la lista.
    const d = decidirCierre({ cola: 3, gestionados: 5 });
    expect(d.faltan).toBe(0);
    expect(d.tipo).toBe('en_cero');
  });
});

// ── GUARDIÁN ──────────────────────────────────────────────────────────
// Un cierre es un documento firmado: queda escrito, el dueño lo lee y decide
// con eso. Firmar "gestioné 0 de 20" porque una query se cayó es acusar a una
// persona con un dato que nunca existió. Misma regla que `turnoDelEquipo`.
describe('GUARDIÁN: sin poder medir, NO se cierra', () => {
  it('gestionados null bloquea el cierre y lo dice', () => {
    const d = decidirCierre({ cola: 20, gestionados: null });
    expect(d.tipo).toBe('no_medible');
    expect(d.puedeCerrar).toBe(false);
    expect(d.faltan).toBeNull();
    expect(d.exigeMotivo).toBe(false);
    expect(d.titulo).toMatch(/no se pudo leer/i);
  });

  it('no confunde "no se pudo medir" con "no trabajé"', () => {
    const caido = decidirCierre({ cola: 20, gestionados: null });
    const real = decidirCierre({ cola: 20, gestionados: 0 });
    expect(caido.tipo).not.toBe(real.tipo);
    expect(real.puedeCerrar).toBe(true);
    expect(real.exigeMotivo).toBe(true);
  });
});

describe('GUARDIÁN: el motivo tiene que decir algo', () => {
  it('un motivo vacío o de relleno no alcanza', () => {
    // "ok", "listo" y "." dejan la casilla marcada sin explicar nada, y el
    // cierre pasa a ser un trámite en vez de información.
    for (const basura of ['', '   ', 'ok', 'listo', '.', 'nada']) {
      expect(motivoSuficiente(basura, true), basura).toBe(false);
    }
  });

  it('un motivo real alcanza', () => {
    expect(motivoSuficiente('La transportadora no contesta desde ayer', true)).toBe(true);
  });

  it('cuando no se exige, cualquier cosa vale (incluso vacío)', () => {
    expect(motivoSuficiente('', false)).toBe(true);
  });

  it('el mínimo es corto pero no trivial', () => {
    expect(MOTIVO_MIN_CHARS).toBeGreaterThan(5);
    expect(MOTIVO_MIN_CHARS).toBeLessThan(40);
  });
});

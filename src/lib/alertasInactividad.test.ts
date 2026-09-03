import { describe, it, expect } from 'vitest';
import {
  decidirAlertas,
  redactarCorreo,
  type EntradaAlertas,
} from '../../supabase/functions/_shared/alertasInactividad';

const H = { workStartMin: 9 * 60, workEndMin: 17 * 60, lunchStartMin: 13 * 60, lunchEndMin: 14 * 60 };
const AHORA = Date.UTC(2026, 8, 3, 15, 0, 0); // ms cualquiera; lo que importa es la resta

function base(over: Partial<EntradaAlertas> = {}): EntradaAlertas {
  return {
    ahoraMs: AHORA,
    minutoLocal: 10 * 60,
    horario: H,
    miembros: [
      { userId: 'ana', nombre: 'Ana' },
      { userId: 'beto', nombre: 'Beto' },
    ],
    ultimaGestionMs: new Map([['ana', AHORA - 5 * 60_000]]),
    enPausa: new Set(),
    yaAvisado: () => false,
    ...over,
  };
}

describe('alertas al dueño sin estar conectado', () => {
  it('fuera del horario no avisa nada, ni en el almuerzo', () => {
    expect(decidirAlertas(base({ minutoLocal: 8 * 60 + 59 }))).toEqual([]);
    expect(decidirAlertas(base({ minutoLocal: 17 * 60 }))).toEqual([]);
    expect(decidirAlertas(base({ minutoLocal: 13 * 60 + 30, ultimaGestionMs: new Map([['ana', AHORA - 90 * 60_000]]) }))).toEqual([]);
  });

  it('inactiva: última gestión hace ≥30 min y sin pausa', () => {
    const r = decidirAlertas(base({ ultimaGestionMs: new Map([['ana', AHORA - 31 * 60_000]]) }));
    expect(r.find((a) => a.userId === 'ana')).toMatchObject({ tipo: 'inactiva', minutos: 31 });
  });

  it('con pausa declarada abierta NO es inactividad', () => {
    const r = decidirAlertas(base({
      ultimaGestionMs: new Map([['ana', AHORA - 60 * 60_000]]),
      enPausa: new Set(['ana']),
    }));
    expect(r.filter((a) => a.tipo === 'inactiva')).toEqual([]);
  });

  it('el almuerzo se descuenta: última gestión 12:50, ahora 14:20 = 30 min, no 90', () => {
    // 14:20 local; última gestión hace 90 min (12:50). Almuerzo 13-14 = 60 min → 30.
    const r = decidirAlertas(base({
      minutoLocal: 14 * 60 + 20,
      ultimaGestionMs: new Map([['ana', AHORA - 90 * 60_000]]),
      umbralInactividadMin: 31,
    }));
    expect(r.filter((a) => a.tipo === 'inactiva')).toEqual([]);
    const r2 = decidirAlertas(base({
      minutoLocal: 14 * 60 + 20,
      ultimaGestionMs: new Map([['ana', AHORA - 90 * 60_000]]),
      umbralInactividadMin: 30,
    }));
    expect(r2.find((a) => a.userId === 'ana')).toMatchObject({ tipo: 'inactiva', minutos: 30 });
  });

  it('no_entro: solo si alguien más sí entró y pasó la gracia; una vez', () => {
    // 9:30 → gracia 45 no cumplida
    expect(decidirAlertas(base({ minutoLocal: 9 * 60 + 30 })).filter((a) => a.tipo === 'no_entro')).toEqual([]);
    // 10:00 → Beto no entró, Ana sí
    const r = decidirAlertas(base({ minutoLocal: 10 * 60 }));
    expect(r.find((a) => a.userId === 'beto')).toMatchObject({ tipo: 'no_entro', minutos: 60 });
    // nadie entró (domingo): silencio
    expect(decidirAlertas(base({ minutoLocal: 10 * 60, ultimaGestionMs: new Map() }))).toEqual([]);
    // ya avisado hoy
    expect(decidirAlertas(base({ minutoLocal: 10 * 60, yaAvisado: (_u, t) => t === 'no_entro' })).filter((a) => a.tipo === 'no_entro')).toEqual([]);
  });

  it('el correo dice lo que midió, no lo que supone', () => {
    const { asunto, texto } = redactarCorreo('Tienda X', [
      { userId: 'ana', nombre: 'Ana', tipo: 'inactiva', minutos: 40 },
      { userId: 'beto', nombre: 'Beto', tipo: 'no_entro', minutos: 75 },
    ], '10:15', H);
    expect(asunto).toContain('1 sin gestionar');
    expect(asunto).toContain('1 sin entrar');
    expect(texto).toContain('Ana: Guardian no vio ninguna gestión hace 40 min');
    expect(texto).toContain('Beto: 75 min después del inicio del turno');
    expect(texto).toMatch(/Una llamada sin marcar no cuenta/);
  });
});

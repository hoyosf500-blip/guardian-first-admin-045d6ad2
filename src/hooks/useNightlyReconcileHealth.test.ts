import { describe, it, expect } from 'vitest';
import { deriveNightlyStatus, type NightlyRow } from './useNightlyReconcileHealth';

// NOW fijo para tests determinísticos.
const NOW = new Date('2026-07-03T12:00:00Z').getTime();

function row(overrides: Partial<NightlyRow> & { created_at: string }): NightlyRow {
  return {
    divergent_count: 0,
    applied_count: 0,
    orphan_cancelled: 0,
    deleted_check_complete: null,
    error_message: null,
    ...overrides,
  };
}

describe('deriveNightlyStatus', () => {
  it('sin filas → hidden (sin corridas o sin permiso RLS)', () => {
    const r = deriveNightlyStatus([], NOW);
    expect(r.status).toBe('hidden');
    expect(r.lastRunAt).toBeNull();
  });

  it('corrida reciente con barrido completo → verified', () => {
    const r = deriveNightlyStatus([
      row({ created_at: '2026-07-03T03:00:00Z', deleted_check_complete: true, orphan_cancelled: 42, applied_count: 3 }),
    ], NOW);
    expect(r.status).toBe('verified');
    expect(r.lastCancelled).toBe(42);
    expect(r.lastApplied).toBe(3);
    expect(r.consecutiveUnverified).toBe(0);
  });

  it('deleted_check_complete=null (sin candidatos / fila pre-migration) cuenta como verified', () => {
    const r = deriveNightlyStatus([
      row({ created_at: '2026-07-03T03:00:00Z', deleted_check_complete: null }),
    ], NOW);
    expect(r.status).toBe('verified');
  });

  it('fail-safe por throttle (complete=false) → unverified, NO verde falso', () => {
    // El caso que motivó todo: orphan_cancelled=0 con complete=false NO es
    // "todo limpio" — es "no se pudo verificar". Antes era invisible.
    const r = deriveNightlyStatus([
      row({ created_at: '2026-07-03T03:00:00Z', deleted_check_complete: false, orphan_cancelled: 0 }),
      row({ created_at: '2026-07-02T03:00:00Z', deleted_check_complete: false }),
      row({ created_at: '2026-07-01T03:00:00Z', deleted_check_complete: true }),
    ], NOW);
    expect(r.status).toBe('unverified');
    expect(r.consecutiveUnverified).toBe(2);
    expect(r.lastVerifiedAt?.toISOString()).toBe('2026-07-01T03:00:00.000Z');
  });

  it('⛔ 28 h sin verificar es NORMAL: el nightly va por turnos, no todas las noches', () => {
    // El caso REAL que motivó el cambio (31-ago-2026, 06:23 UTC): el nightly
    // corrió a las 03:17 sobre 4 de las 6 tiendas — Colombia entre ellas, sin
    // divergencias. A Ecuador no le tocó turno, quedó en 27,1 h, y el umbral
    // viejo de 27 h pintó «Verificación vs Dropi caída». Rojo por SEIS MINUTOS,
    // con la función sana y el turno de Ecuador agendado para esa misma noche.
    const r = deriveNightlyStatus([
      row({ created_at: '2026-07-02T08:00:00Z', deleted_check_complete: true }), // 28 h
    ], NOW);
    expect(r.status).toBe('verified');
  });

  it('48 h tampoco alarma: con 6 tiendas y ~4 por noche, a una le toca cada 2 noches', () => {
    const r = deriveNightlyStatus([
      row({ created_at: '2026-07-01T12:00:00Z', deleted_check_complete: true }), // 48 h
    ], NOW);
    expect(r.status).toBe('verified');
  });

  it('pasadas las 52 h → stale, y stale NO es error', () => {
    // Con las filas de ESTA tienda no se puede saber si el trabajo murió o si
    // solo no le tocó turno: una tienda postergada no deja fila. Por eso el
    // estado dice lo medido ("hace tanto que no se verifica") y NO afirma una
    // causa. La distinción es la que separa un aviso útil de un lobo.
    const r = deriveNightlyStatus([
      row({ created_at: '2026-07-01T03:00:00Z', deleted_check_complete: true }), // 57 h
    ], NOW);
    expect(r.status).toBe('stale');
    expect(r.lastErrorMessage).toBeNull();
  });

  it('un error MEDIDO manda sobre la antigüedad: viejo + error_message → error', () => {
    // Que haya fallado hace tres días no lo convierte en un problema de turnos.
    const r = deriveNightlyStatus([
      row({ created_at: '2026-06-30T03:00:00Z', error_message: 'boom' }), // 81 h
    ], NOW);
    expect(r.status).toBe('error');
    expect(r.lastErrorMessage).toBe('boom');
  });

  it('error_message en la última corrida → error, y no cuenta como verificada', () => {
    const r = deriveNightlyStatus([
      row({ created_at: '2026-07-03T03:00:00Z', error_message: 'boom' }),
      row({ created_at: '2026-07-02T03:00:00Z', deleted_check_complete: true }),
    ], NOW);
    expect(r.status).toBe('error');
    expect(r.lastErrorMessage).toBe('boom');
    expect(r.lastVerifiedAt?.toISOString()).toBe('2026-07-02T03:00:00.000Z');
  });
});

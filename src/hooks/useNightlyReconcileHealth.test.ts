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

  it('última corrida hace más de 27h → error (el nightly no está corriendo)', () => {
    const r = deriveNightlyStatus([
      row({ created_at: '2026-07-01T03:00:00Z', deleted_check_complete: true }),
    ], NOW);
    expect(r.status).toBe('error');
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

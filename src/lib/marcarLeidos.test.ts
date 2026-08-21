import { describe, it, expect } from 'vitest';
import { marcarLeidos, HORAS_ENTRE_MARCAS } from '../../supabase/functions/_shared/marcarLeidos';

/**
 * El test vive en `src/lib/` y cruza a `supabase/functions/_shared/` a
 * propósito: `vitest.config.ts` solo incluye `src/**`, así que un test al lado
 * de la edge function NO correría nunca. Mismo patrón que `autoPushSelect`.
 */

/** Cliente falso que graba lo que se le pidió. */
function sbFalso(respuesta: { data?: unknown[]; error?: { code?: string; message?: string } | null } = {}) {
  const llamadas: Record<string, unknown>[] = [];
  const sb = {
    from(tabla: string) {
      const call: Record<string, unknown> = { tabla };
      llamadas.push(call);
      const q = {
        update(v: Record<string, unknown>) { call.update = v; return q; },
        eq(col: string, val: unknown) { call[`eq:${col}`] = val; return q; },
        in(col: string, vals: unknown[]) { call[`in:${col}`] = vals; return q; },
        or(expr: string) { call.or = expr; return q; },
        select() {
          return Promise.resolve({ data: respuesta.data ?? [], error: respuesta.error ?? null });
        },
      };
      return q;
    },
  };
  return { sb, llamadas };
}

const AHORA = new Date('2026-08-21T20:00:00Z').getTime();

describe('marcarLeidos — dejar registrado que se miró', () => {
  it('marca los pedidos leídos, siempre acotado a la tienda', () => {
    const { sb, llamadas } = sbFalso({ data: [{ id: '1' }, { id: '2' }] });
    return marcarLeidos(sb, 'tienda-1', ['A', 'B'], AHORA).then((n) => {
      expect(n).toBe(2);
      expect(llamadas[0]['eq:store_id']).toBe('tienda-1');
      expect(llamadas[0]['in:external_id']).toEqual(['A', 'B']);
    });
  });

  it('no re-estampa lo estampado hace poco', () => {
    // El cron pasa cada ~20 min; sin umbral serían miles de UPDATE por hora —con
    // su realtime a cada navegador— para una pregunta que se mide en días.
    const { sb, llamadas } = sbFalso({ data: [] });
    return marcarLeidos(sb, 'tienda-1', ['A'], AHORA).then(() => {
      const corte = new Date(AHORA - HORAS_ENTRE_MARCAS * 3600_000).toISOString();
      expect(llamadas[0].or).toBe(`last_synced_at.is.null,last_synced_at.lt.${corte}`);
    });
  });

  it('deduplica ids repetidos y no llama con lista vacía', async () => {
    const { sb, llamadas } = sbFalso({ data: [{ id: '1' }] });
    await marcarLeidos(sb, 't', ['A', 'A', 'A'], AHORA);
    expect(llamadas[0]['in:external_id']).toEqual(['A']);

    const vacio = sbFalso();
    expect(await marcarLeidos(vacio.sb, 't', [], AHORA)).toBe(0);
    expect(vacio.llamadas).toHaveLength(0);
  });
});

// ── GUARDIÁN ──────────────────────────────────────────────────────────
describe('GUARDIÁN: nunca marca pedidos de otra tienda', () => {
  it('el filtro por store_id es obligatorio en cada lote', async () => {
    // Los external_id de Dropi son por país y desde agosto-2026 son únicos POR
    // TIENDA, no globalmente: sin este filtro se marcarían pedidos ajenos, y
    // mezclar empresas está prohibido en esta operación.
    const { sb, llamadas } = sbFalso({ data: [] });
    const muchos = Array.from({ length: 450 }, (_, i) => `X${i}`);
    await marcarLeidos(sb, 'tienda-1', muchos, AHORA);
    expect(llamadas.length).toBeGreaterThan(1); // se lotea
    for (const c of llamadas) expect(c['eq:store_id']).toBe('tienda-1');
  });
});

describe('GUARDIÁN: la migración pendiente no rompe el sync', () => {
  it('columna inexistente devuelve null, no una excepción', async () => {
    const { sb } = sbFalso({ error: { code: '42703', message: 'column "last_synced_at" does not exist' } });
    expect(await marcarLeidos(sb, 't', ['A'], AHORA)).toBeNull();
  });

  it('otro error no tumba la corrida: devuelve lo que alcanzó a marcar', async () => {
    const { sb } = sbFalso({ error: { code: '08006', message: 'connection failure' } });
    expect(await marcarLeidos(sb, 't', ['A'], AHORA)).toBe(0);
  });
});

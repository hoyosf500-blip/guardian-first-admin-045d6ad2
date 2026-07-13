import { describe, it, expect } from 'vitest';
import { parseInvoke } from './parseInvoke';

// error.context imita el Response que supabase-js v2 cuelga del FunctionsHttpError
// (solo necesita .text(); parseInvoke no toca nada más del objeto).
const ctxWith = (text: string | null, throws = false) => ({
  context: {
    text: async () => {
      if (throws) throw new Error('stream ya consumido');
      return text ?? '';
    },
  },
});

describe('parseInvoke', () => {
  it('sin error devuelve data tal cual', async () => {
    const data = { ok: true, externalId: '123' };
    expect(await parseInvoke(data, null)).toBe(data);
  });

  it('con error non-2xx parsea el body JSON real del context', async () => {
    const body = { ok: false, error: 'Dropi rechazó el cambio [422]', code: 'dropi_rejected', dropiHttpStatus: 422 };
    const r = await parseInvoke<typeof body>(null, ctxWith(JSON.stringify(body)));
    expect(r).toEqual(body);
  });

  it('body no-JSON → ok:false con el texto truncado a 500', async () => {
    const raw = 'x'.repeat(600);
    const r = await parseInvoke<{ ok: boolean; error: string }>(null, ctxWith(raw));
    expect(r.ok).toBe(false);
    expect(r.error).toHaveLength(500);
  });

  it('body vacío → cae al message del error', async () => {
    const err = { ...ctxWith(''), message: 'Edge Function returned a non-2xx status code' };
    const r = await parseInvoke<{ ok: boolean; error: string }>(null, err);
    expect(r).toEqual({ ok: false, error: 'Edge Function returned a non-2xx status code' });
  });

  it('context.text() que explota → cae al message sin romper', async () => {
    const err = { ...ctxWith(null, true), message: 'boom' };
    const r = await parseInvoke<{ ok: boolean; error: string }>(null, err);
    expect(r).toEqual({ ok: false, error: 'boom' });
  });

  it('error sin context ni message → error genérico', async () => {
    const r = await parseInvoke<{ ok: boolean; error: string }>(null, {});
    expect(r).toEqual({ ok: false, error: 'error' });
  });
});

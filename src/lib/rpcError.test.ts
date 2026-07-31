import { describe, it, expect } from 'vitest';
import { isRpcMissing } from './rpcError';

describe('isRpcMissing', () => {
  it('true para PGRST202 (función no encontrada en el schema cache)', () => {
    expect(isRpcMissing({ code: 'PGRST202', message: 'Could not find the function' })).toBe(true);
  });

  it('true para 42883 (undefined_function de Postgres)', () => {
    expect(isRpcMissing({ code: '42883', message: 'function foo(...) does not exist' })).toBe(true);
  });

  it('true por mensaje aunque no venga code', () => {
    expect(isRpcMissing({ message: 'Could not find the function public.x in the schema cache' })).toBe(true);
    expect(isRpcMissing({ message: 'relation "logistica_monthly_costs" does not exist' })).toBe(true);
  });

  it('FALSE para errores transitorios reales (los que deben re-lanzarse y reintentar)', () => {
    // throttle / rate limit
    expect(isRpcMissing({ code: '', message: 'Too Many Requests' })).toBe(false);
    // permiso RLS
    expect(isRpcMissing({ code: '42501', message: 'permission denied for function financial_summary' })).toBe(false);
    // 500 genérico
    expect(isRpcMissing({ code: 'XX000', message: 'internal server error' })).toBe(false);
    // timeout de red
    expect(isRpcMissing({ message: 'network timeout' })).toBe(false);
  });

  it('FALSE para una COLUMNA inexistente: es drift de esquema, no degradación', () => {
    // El incidente de orderColumns: una migración sin aplicar rompe el SELECT de
    // TODAS las pantallas de pedidos. Si esto se traga como "RPC ausente", la
    // pantalla pinta el fallback y nadie se entera de que la query está rota.
    expect(isRpcMissing({ code: '42703', message: 'column orders.suggested_address does not exist' })).toBe(false);
    expect(isRpcMissing({ message: 'column "gestionados_cohorte" does not exist' })).toBe(false);
  });

  it('FALSE para nullish / no-objeto (no confundir "sin error" con "RPC ausente")', () => {
    expect(isRpcMissing(null)).toBe(false);
    expect(isRpcMissing(undefined)).toBe(false);
    expect(isRpcMissing('boom')).toBe(false);
    expect(isRpcMissing({})).toBe(false);
  });
});

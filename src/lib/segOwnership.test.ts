import { describe, it, expect } from 'vitest';
import {
  classifySegOwnership,
  classifySegOwnershipFromTps,
  matchesOwnerFilter,
  type SegOwnerBucket,
} from './segOwnership';

const ME = 'user-mayra';
const OTHER = 'user-silvana';
const ADMIN = 'user-fabian';
const ADMINS = [ADMIN];

const tp = (operator_id: string) => ({ operator_id });

describe('classifySegOwnership', () => {
  it('returns "available" when the phone has no touchpoints', () => {
    expect(classifySegOwnership('300', {}, ME, ADMINS)).toBe('available');
  });

  it('returns "available" when the phone key exists but is empty', () => {
    expect(classifySegOwnership('300', { '300': [] }, ME, ADMINS)).toBe('available');
  });

  it('returns "mine" when I have gestionado the order', () => {
    const map = { '300': [tp(ME)] };
    expect(classifySegOwnership('300', map, ME, ADMINS)).toBe('mine');
  });

  it('returns "mine" even if another operator also gestionó it', () => {
    const map = { '300': [tp(OTHER), tp(ME)] };
    expect(classifySegOwnership('300', map, ME, ADMINS)).toBe('mine');
  });

  it('returns "other" when only another operator gestionó it', () => {
    const map = { '300': [tp(OTHER)] };
    expect(classifySegOwnership('300', map, ME, ADMINS)).toBe('other');
  });

  it('ignores admin touchpoints (admin auditing does not claim the order)', () => {
    const map = { '300': [tp(ADMIN)] };
    // Solo gestión de admin → sigue disponible para la operadora.
    expect(classifySegOwnership('300', map, ME, ADMINS)).toBe('available');
  });

  it('counts the operator touchpoint even when mixed with an admin one', () => {
    const map = { '300': [tp(ADMIN), tp(OTHER)] };
    expect(classifySegOwnership('300', map, ME, ADMINS)).toBe('other');
  });

  it('without a currentUserId, my own touchpoints cannot be "mine"', () => {
    const map = { '300': [tp(ME)] };
    expect(classifySegOwnership('300', map, undefined, ADMINS)).toBe('other');
  });
});

/**
 * ⛔ EL SELLO NO PUEDE QUEDARSE PEGADO DOS MESES.
 *
 * `CrmTable` trae 60 días de touchpoints y esta función NO miraba la fecha: un
 * pedido tocado hace cincuenta días seguía diciendo "Mío" en la vista Lista. El
 * dueño usa esa etiqueta para saber a quién NO regañar; pegada dos meses le
 * afirma que está atendido algo que nadie mira desde marzo.
 */
describe('la ventana del sello (3-sep-2026)', () => {
  const hace = (dias: number) => new Date(Date.now() - dias * 86_400_000).toISOString();
  const SIETE_DIAS = Date.now() - 7 * 86_400_000;

  it('una gestión de hace 50 días ya no dice "Mío"', () => {
    const tps = [{ operator_id: ME, created_at: hace(50) }];
    expect(classifySegOwnershipFromTps(tps, ME, ADMINS)).toBe('mine');           // sin ventana: como antes
    expect(classifySegOwnershipFromTps(tps, ME, ADMINS, SIETE_DIAS)).toBe('available');
  });

  it('una gestión de ayer sigue siendo mía', () => {
    const tps = [{ operator_id: ME, created_at: hace(1) }];
    expect(classifySegOwnershipFromTps(tps, ME, ADMINS, SIETE_DIAS)).toBe('mine');
  });

  it('se queda con la reciente aunque haya una vieja de otra persona', () => {
    const tps = [
      { operator_id: OTHER, created_at: hace(40) },
      { operator_id: ME, created_at: hace(2) },
    ];
    expect(classifySegOwnershipFromTps(tps, ME, ADMINS, SIETE_DIAS)).toBe('mine');
  });

  /**
   * "No sé cuándo fue" NO es "fue hace mucho". Descartar una fila sin fecha
   * convertiría una gestión real en un pedido "que nadie tocó" — que es
   * exactamente el error que hace que alguien reciba un regaño injusto.
   */
  it('una fila sin fecha NO se descarta', () => {
    const tps = [{ operator_id: ME }];
    expect(classifySegOwnershipFromTps(tps, ME, ADMINS, SIETE_DIAS)).toBe('mine');
    const rota = [{ operator_id: ME, created_at: 'cualquier cosa' }];
    expect(classifySegOwnershipFromTps(rota, ME, ADMINS, SIETE_DIAS)).toBe('mine');
  });

  it('sin ventana, el comportamiento es idéntico al de antes', () => {
    const tps = [{ operator_id: OTHER, created_at: hace(90) }];
    expect(classifySegOwnershipFromTps(tps, ME, ADMINS)).toBe('other');
  });
});

describe('matchesOwnerFilter', () => {
  const buckets: SegOwnerBucket[] = ['mine', 'available', 'other'];

  it('"all" passes every bucket', () => {
    buckets.forEach((b) => expect(matchesOwnerFilter(b, 'all')).toBe(true));
  });

  it('"mine" passes only "mine"', () => {
    expect(matchesOwnerFilter('mine', 'mine')).toBe(true);
    expect(matchesOwnerFilter('available', 'mine')).toBe(false);
    expect(matchesOwnerFilter('other', 'mine')).toBe(false);
  });

  it('"available" passes only "available"', () => {
    expect(matchesOwnerFilter('available', 'available')).toBe(true);
    expect(matchesOwnerFilter('mine', 'available')).toBe(false);
    expect(matchesOwnerFilter('other', 'available')).toBe(false);
  });
});

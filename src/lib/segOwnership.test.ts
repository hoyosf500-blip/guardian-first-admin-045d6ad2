import { describe, it, expect } from 'vitest';
import {
  classifySegOwnership,
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

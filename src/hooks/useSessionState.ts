import { useState, useEffect, useRef, Dispatch, SetStateAction } from 'react';

/**
 * Drop-in replacement for `useState` that persists the value in `sessionStorage`.
 *
 * Why this exists:
 * Mobile browsers (especially Chrome Android) aggressively discard background
 * tabs when memory is tight. When the operator clicks "Rastrear" and switches
 * to the tracking page for a while, returning to the CRM tab often triggers a
 * reload — and React state like `view`, `filter`, `callIdx`, `search` is lost,
 * so the operator has to navigate back to where they were. This hook keeps
 * that nav state alive across the reload (same session / same browser tab).
 *
 * Use for small, serializable UI state (strings, numbers, enums, simple
 * objects). Do NOT use for large arrays of orders — those should be refetched
 * from the DB, which is the source of truth.
 *
 * @param key Unique key under which to persist the value. Namespace it
 *            (e.g. `confirmar:view`) so two tabs don't clobber each other.
 * @param initial Fallback initial value when nothing is stored.
 */
export function useSessionState<T>(
  key: string,
  initial: T,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === 'undefined') return initial;
    try {
      const raw = window.sessionStorage.getItem(key);
      if (raw === null) return initial;
      return JSON.parse(raw) as T;
    } catch {
      return initial;
    }
  });

  // Avoid a redundant write on the very first render.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    try {
      window.sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Quota exceeded or storage disabled — nothing we can do, just skip.
    }
  }, [key, value]);

  return [value, setValue];
}

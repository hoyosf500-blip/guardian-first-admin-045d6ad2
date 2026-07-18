import { useEffect, useRef, useState } from 'react';

/** Easing del handoff: arranca rápido y frena al final. */
export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Valor mostrado en un punto del recorrido (0..1). Puro para poder testearlo
 * sin requestAnimationFrame.
 */
export function valueAtProgress(target: number, progress: number, decimals = 0): number {
  const raw = target * easeOutCubic(Math.max(0, Math.min(1, progress)));
  const factor = Math.pow(10, decimals);
  return Math.round(raw * factor) / factor;
}

/**
 * Cuenta desde 0 hasta `value` al montar (~1.1s, ease-out cúbico).
 *
 * Devuelve el valor final de una si duration es 0 o si el usuario pidió
 * prefers-reduced-motion. Reutilizable por cualquier pantalla.
 */
export function useCountUp(value: number, duration = 1100, decimals = 0): number {
  const skip = duration <= 0
    || (typeof window !== 'undefined'
      && !!window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const [shown, setShown] = useState(() => (skip ? value : 0));
  const frameRef = useRef<number>();

  useEffect(() => {
    if (skip) { setShown(value); return; }

    const start = performance.now();
    const tick = (now: number) => {
      const progress = (now - start) / duration;
      if (progress >= 1) { setShown(value); return; }
      setShown(valueAtProgress(value, progress, decimals));
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);

    return () => { if (frameRef.current) cancelAnimationFrame(frameRef.current); };
  }, [value, duration, decimals, skip]);

  return shown;
}

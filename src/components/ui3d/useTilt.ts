import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

/** Inclinación máxima en grados. El handoff pide ≤ 6°. */
const MAX_DEG = 6;
/** Debajo de este ancho consideramos móvil y no inclinamos. */
const MIN_WIDTH_PX = 768;

export interface Rotation { rx: number; ry: number }
interface Rect { left: number; top: number; width: number; height: number }

/**
 * Convierte la posición del puntero en rotación, normalizada al centro del
 * elemento. Pura y exportada para testear la matemática sin DOM.
 * El resultado siempre queda dentro de [-maxDeg, maxDeg].
 */
export function rotationFromPointer(
  clientX: number, clientY: number, rect: Rect, maxDeg: number = MAX_DEG,
): Rotation {
  if (rect.width === 0 || rect.height === 0) return { rx: 0, ry: 0 };
  const clamp = (n: number) => Math.max(-1, Math.min(1, n));
  // Sumar 0 normaliza -0 a 0: en el centro exacto, -py * maxDeg da -0 y
  // se colaría al transform como "rotateX(-0deg)".
  const noNegZero = (n: number) => n + 0;
  // -1 (borde izquierdo/superior) .. +1 (borde derecho/inferior)
  const px = clamp(((clientX - rect.left) / rect.width) * 2 - 1);
  const py = clamp(((clientY - rect.top) / rect.height) * 2 - 1);
  // El eje X se invierte: mouse abajo => la card se inclina hacia atrás.
  return { rx: noNegZero(-py * maxDeg), ry: noNegZero(px * maxDeg) };
}

/**
 * Decide si el tilt 3D aplica y expone ref + handlers.
 *
 * NO usa estado de React para la rotación: escribe el transform DIRECTO al nodo
 * por ref. Si guardara la rotación en useState, cada movimiento del mouse
 * re-renderizaría el árbol entero de la card — en CallView eso significa
 * re-correr el pipeline de validación de dirección, AttemptHistory y los IIFE
 * de duplicados al ritmo del puntero, en la pantalla de más tráfico de la
 * operadora.
 *
 * Se apaga en táctil, con prefers-reduced-motion y en pantallas angostas.
 * Es el ÚNICO lugar donde vive esa decisión.
 */
export function useTilt(maxDeg: number = MAX_DEG) {
  const [enabled, setEnabled] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number>();

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const finePointer = window.matchMedia('(pointer: fine)').matches;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const wideEnough = window.innerWidth >= MIN_WIDTH_PX;
    setEnabled(finePointer && !reducedMotion && wideEnough);
  }, []);

  // Limpia cualquier frame pendiente al desmontar.
  useEffect(() => () => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
  }, []);

  const apply = useCallback((rx: number, ry: number) => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      const node = ref.current;
      if (node) node.style.transform = `rotateX(${rx}deg) rotateY(${ry}deg)`;
    });
  }, []);

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (!enabled) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const { rx, ry } = rotationFromPointer(e.clientX, e.clientY, rect, maxDeg);
    apply(rx, ry);
  }, [enabled, maxDeg, apply]);

  const onPointerLeave = useCallback(() => {
    if (!enabled) return;
    apply(0, 0);
  }, [enabled, apply]);

  return { enabled, ref, tiltProps: { onPointerMove, onPointerLeave } };
}

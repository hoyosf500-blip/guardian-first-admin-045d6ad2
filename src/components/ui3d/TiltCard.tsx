import type { ReactNode } from 'react';
import { useTilt } from './useTilt';

interface TiltCardProps {
  children: ReactNode;
  /** Clases de la card interna (fondo, borde, padding, radio). */
  className?: string;
  /** Distancia de perspectiva del contenedor, en px. */
  perspective?: number;
  /** Clases del contenedor externo (ej. col-span del grid). */
  wrapperClassName?: string;
  /** Barrido holográfico lento — solo para la card hero de cada pantalla. */
  sheen?: boolean;
  /** Brackets cian en las esquinas superiores (card hero). */
  brackets?: boolean;
}

/**
 * Card con inclinación 3D al mover el puntero.
 *
 * La perspective va en el contenedor externo y la rotación en el interno —
 * es la única forma de que rotateX/rotateY se vean en 3D. Si useTilt está
 * deshabilitado (táctil, móvil, reduced-motion) no se aplica ningún transform.
 *
 * Las capas internas se separan en profundidad con .tilt-layer-1/2/3.
 * Presentación pura: no recibe hooks de datos ni el cliente de Supabase.
 */
export default function TiltCard({
  children, className = '', perspective = 900, wrapperClassName = '',
  sheen = false, brackets = false,
}: TiltCardProps) {
  const { enabled, ref, tiltProps } = useTilt();

  return (
    <div className={wrapperClassName} style={{ perspective: `${perspective}px` }}>
      <div
        ref={ref}
        {...(enabled ? tiltProps : {})}
        className={`tilt-3d hairline-top relative overflow-hidden ${className}`}
      >
        {brackets && (
          <>
            <span className="corner-bracket corner-bracket-tl" aria-hidden="true" />
            <span className="corner-bracket corner-bracket-tr" aria-hidden="true" />
          </>
        )}
        {sheen && <span className="sheen animate-gb-sheen" aria-hidden="true" />}
        {children}
      </div>
    </div>
  );
}

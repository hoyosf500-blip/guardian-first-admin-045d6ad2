import type { ReactNode } from 'react';

interface TiltCardProps {
  children: ReactNode;
  /** Clases de la card interna (fondo, borde, padding, radio). */
  className?: string;
  /** Distancia de perspectiva del contenedor, en px. */
  perspective?: number;
  /** Clases del contenedor externo (ej. col-span del grid). */
  wrapperClassName?: string;
  /** Sin efecto desde 2026-08-23 — se conserva la prop para no tocar 50+ call-sites. */
  sheen?: boolean;
  /** Brackets cian en las esquinas superiores (card hero). */
  brackets?: boolean;
}

/**
 * Card hero ESTÁTICA. Hasta el 23-ago-2026 esta card se inclinaba en 3D
 * siguiendo el puntero (useTilt) y podía llevar un barrido "sheen" en loop.
 * El dueño pidió "quitá la animación cuando paso el mouse, dejalo todo
 * quieto" — y el tilt/sheen vivían en ~50 tarjetas vía este componente, así
 * que el apagón va acá, en la RAÍZ, no card por card. Las clases (.tilt-3d,
 * hairline-top, tilt-layer-*) se conservan: sin transform del padre son
 * inertes y quitarlas obligaría a tocar cada call-site. Los corner-brackets
 * quedan (son estáticos). NO reintroducir tiltProps/useTilt sin pedido
 * explícito del dueño.
 */
export default function TiltCard({
  children, className = '', perspective = 900, wrapperClassName = '',
  brackets = false,
}: TiltCardProps) {
  return (
    <div className={wrapperClassName} style={{ perspective: `${perspective}px` }}>
      <div className={`tilt-3d hairline-top relative overflow-hidden ${className}`}>
        {brackets && (
          <>
            <span className="corner-bracket corner-bracket-tl" aria-hidden="true" />
            <span className="corner-bracket corner-bracket-tr" aria-hidden="true" />
          </>
        )}
        {children}
      </div>
    </div>
  );
}

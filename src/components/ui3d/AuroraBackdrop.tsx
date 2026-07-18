/**
 * Capa de fondo decorativa: dos blobs índigo/violeta que flotan y una retícula
 * en perspectiva al pie.
 *
 * Va en position:absolute con pointer-events:none, así que nunca intercepta
 * clicks. El contenedor padre debe ser relative + overflow-hidden.
 */
export default function AuroraBackdrop() {
  return (
    <div aria-hidden="true" className="absolute inset-0 overflow-hidden pointer-events-none">
      <div
        className="aurora-blob animate-gb-float"
        style={{
          left: '-8%', top: '-10%', width: 340, height: 340,
          background: 'radial-gradient(circle, hsl(var(--accent) / .30), transparent 70%)',
        }}
      />
      <div
        className="aurora-blob animate-gb-float"
        style={{
          right: '-6%', top: '20%', width: 300, height: 300,
          background: 'radial-gradient(circle, hsl(var(--accent2) / .24), transparent 70%)',
          animationDirection: 'reverse',
          animationDuration: '14s',
        }}
      />
      <div className="perspective-floor" />
    </div>
  );
}

/**
 * Capa de fondo decorativa: blobs índigo/violeta/cian que flotan y una retícula
 * en perspectiva al pie.
 *
 * Va en position:absolute con pointer-events:none, así que nunca intercepta
 * clicks. El contenedor padre debe ser relative + overflow-hidden.
 *
 * CALIBRACIÓN (2026-07-19). El dueño lo vio "opaco". Eran dos blobs de 340/300px
 * sobre pantallas de 1440+: a esa escala no se leen como luz ambiente sino como
 * dos manchas chicas perdidas en una esquina. Se agrandaron ~1.5×, se subió el
 * alfa y se agregó un tercero (cian, el token frío del DS) abajo a la izquierda,
 * que es la zona que quedaba muerta.
 *
 * El blur sube de 20px a 44px A PROPÓSITO junto con el tamaño: más grande +
 * mismo blur daría círculos reconocibles, que es peor que opaco. Más grande +
 * más blur da luz.
 *
 * TECHO DE INTENSIDAD: las tarjetas van sobre `bg-card/40`, o sea que el fondo
 * SE VE A TRAVÉS de ellas. Subir estos alfas empuja el contraste del texto que
 * va encima. Los valores de acá están calibrados para quedar por debajo de ese
 * umbral; si alguien los sube más, hay que re-verificar contraste sobre tarjeta,
 * no sobre el fondo pelado.
 *
 * La animación la corta `prefers-reduced-motion` en index.css (regla .aurora-blob).
 */
export default function AuroraBackdrop() {
  return (
    <div aria-hidden="true" className="absolute inset-0 overflow-hidden pointer-events-none">
      <div
        className="aurora-blob animate-gb-float"
        style={{
          left: '-10%', top: '-12%', width: 520, height: 520,
          background: 'radial-gradient(circle, hsl(var(--accent) / .38), transparent 70%)',
        }}
      />
      <div
        className="aurora-blob animate-gb-float"
        style={{
          right: '-8%', top: '14%', width: 460, height: 460,
          background: 'radial-gradient(circle, hsl(var(--accent2) / .32), transparent 70%)',
          animationDirection: 'reverse',
          animationDuration: '14s',
        }}
      />
      {/* Tercero: la esquina inferior izquierda quedaba muerta y el fondo se leía
          cargado arriba y vacío abajo. Cian = el token frío del DS, así el degradado
          general va de índigo a violeta a cian en vez de ser un solo tono lavado.
          Alfa más bajo que los otros dos: acá abajo suelen caer tablas densas. */}
      <div
        className="aurora-blob animate-gb-float"
        style={{
          left: '18%', bottom: '-16%', width: 420, height: 420,
          background: 'radial-gradient(circle, hsl(var(--cyan) / .18), transparent 70%)',
          animationDuration: '18s',
        }}
      />
      <div className="perspective-floor" />
    </div>
  );
}

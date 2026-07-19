// Helpers visuales del área /novedades. Van en un archivo aparte de los
// componentes para no romper el fast-refresh de Vite (un módulo que exporta
// componentes NO debe exportar también constantes/funciones).
//
// Presentación pura: nada de acá calcula ni transforma métricas.

/** Entrada escalonada — misma escala de delays que Dashboard/Logística. */
export const fadeUp = (delay = 0) => ({
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35, delay, ease: 'easeOut' as const },
});

/**
 * `hsl(var(--x))` → `hsl(var(--x) / a)`. El idiom `${color}22` solo funciona
 * con hex de 6 dígitos: sobre `hsl(...)` genera CSS inválido y no se pinta.
 */
export const ring = (c: string, a = 0.13) => c.replace(/\)$/, ` / ${a})`);

/** Degradado horizontal de barra: pleno → translúcido. */
export const barGradient = (c: string) =>
  `linear-gradient(90deg, ${c} 0%, ${ring(c, 0.55)} 100%)`;

/** Glow del relleno/trazo. 6px en barras, 8px en líneas y áreas. */
export const barGlow = (c: string) => ({ filter: `drop-shadow(0 0 6px ${c})` });
export const lineGlow = (c: string) => ({ filter: `drop-shadow(0 0 8px ${c})` });

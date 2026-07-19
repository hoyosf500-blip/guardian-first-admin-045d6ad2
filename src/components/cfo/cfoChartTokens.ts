// ─────────────────────────────────────────────────────────────────
// Tokens de dibujo del módulo /cfo — el equivalente local de
// `components/logistics/charts/chartTokens.ts`, con lo que ese archivo no
// cubre: colores de serie, glow del trazo y la entrada escalonada.
//
// Va en .ts (sin JSX) a propósito: mezclar constantes y componentes en el
// mismo archivo rompe el fast-refresh de Vite.
//
// PRESENTACIÓN PURA: acá no se calcula ni se formatea ningún número de
// negocio; sólo se decide con qué color y con qué forma se dibuja.
// ─────────────────────────────────────────────────────────────────

/** Todo color de gráfico sale de una var HSL: dark/light cambian solos. */
export const hsl = (v: string) => `hsl(var(${v}))`;

export const CHART_ACCENT  = hsl('--accent');
export const CHART_ACCENT2 = hsl('--accent2');
export const CHART_CYAN    = hsl('--cyan');
export const CHART_BG      = hsl('--background');
export const CHART_SUCCESS = hsl('--success');
export const CHART_DANGER  = hsl('--danger');
export const CHART_WARNING = hsl('--warning');
export const CHART_INFO    = hsl('--info');
export const CHART_AI      = hsl('--ai');
export const CHART_MUTED   = hsl('--muted-foreground');

/** Glow del trazo: 8px para líneas/áreas, 6px para barras. Firma del DS. */
export const lineGlow = (color: string) => ({ filter: `drop-shadow(0 0 8px ${color})` });
export const barGlow  = (color: string) => ({ filter: `drop-shadow(0 0 6px ${color})` });

/** Entrada escalonada: la pantalla se arma de arriba abajo. */
export const fadeUp = (delay = 0) => ({
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35, delay, ease: 'easeOut' as const },
});

/**
 * `hsl(var(--x))` → `hsl(var(--x) / 0.13)` para el aro suave del dot y para
 * el arranque de los degradados horizontales.
 *
 * El idiom `${color}22` sólo funciona con hex de 6 dígitos: sobre un string
 * `hsl(...)` genera CSS inválido y el color no se pinta.
 */
export function ringOf(color: string | undefined, alpha = 0.13): string | undefined {
  return color ? color.replace(/\)$/, ` / ${alpha})`) : undefined;
}

/**
 * Parte una cifra YA FORMATEADA ("$ 18.400.000") en símbolo + número para
 * poder pintar el símbolo más chico, como en el diseño. Presentación pura:
 * NO reformatea ni recalcula nada, solo separa el prefijo no numérico.
 */
export function splitCurrency(formatted: string): { symbol: string; rest: string } {
  const m = /^([^0-9-]*)(.*)$/.exec(formatted);
  if (!m) return { symbol: '', rest: formatted };
  const symbol = m[1].trim();
  const rest = m[2].trim();
  // Sin símbolo, sin resto, o resto sin dígitos (ej. "—", "63%") → se pinta
  // la cadena tal cual. Nunca se pierde ni un carácter del valor original.
  if (!symbol || !/\d/.test(rest)) return { symbol: '', rest: formatted };
  return { symbol, rest };
}

// Tokens compartidos para todos los charts del módulo Logística.
// Consolida TOOLTIP_STYLE + axis/grid props que estaban duplicados en
// 4+ archivos (LogisticaTab inline, BilleteraTab, finanzas/*).
//
// Cualquier ajuste visual (densidad, color, sombra) se hace acá una sola
// vez y se propaga a todo el módulo. Mantiene tokens semánticos del DS
// (hsl(var(--token))) para que dark/light mode funcione automático.

/** Tooltip style — usar como `contentStyle` en `<RTooltip>`. */
export const CHART_TOOLTIP_STYLE = {
  background: 'hsl(var(--card) / 0.96)',
  border: '1px solid hsl(var(--border-strong))',
  borderRadius: 10,
  color: 'hsl(var(--foreground))',
  fontSize: 12,
  padding: '8px 10px',
  boxShadow: 'var(--shadow-md)',
};

/** Item style del tooltip (texto dentro de cada línea). */
export const CHART_TOOLTIP_ITEM_STYLE = {
  color: 'hsl(var(--foreground))',
  fontSize: 12,
  padding: '2px 0',
};

/** Cursor style (rect que se pinta al hacer hover sobre una barra). */
export const CHART_BAR_CURSOR = { fill: 'hsl(var(--muted) / 0.4)' } as const;

/** Cursor style para line charts (línea vertical de hover). */
export const CHART_LINE_CURSOR = {
  stroke: 'hsl(var(--muted-foreground) / 0.5)',
  strokeWidth: 1,
  strokeDasharray: '4 4',
} as const;

/** Props compartidos para `<CartesianGrid>` — solo horizontal, sutil. */
export const CHART_GRID_PROPS = {
  strokeDasharray: '3 3',
  stroke: 'hsl(var(--border) / 0.55)',
  vertical: false,
} as const;

/** Props compartidos para `<XAxis>` — sin axis line gruesa, ticks pequeños. */
export const CHART_X_AXIS_PROPS = {
  stroke: 'hsl(var(--muted-foreground))',
  fontSize: 10,
  tickLine: false,
  axisLine: { stroke: 'hsl(var(--border))' },
} as const;

/** Props compartidos para `<YAxis>` — sin axis line, sin ticks. */
export const CHART_Y_AXIS_PROPS = {
  stroke: 'hsl(var(--muted-foreground))',
  fontSize: 10,
  tickLine: false,
  axisLine: false,
  width: 50,
} as const;

/** Props compartidos para `<Legend>` — typo pequeño, padding consistente. */
export const CHART_LEGEND_PROPS = {
  wrapperStyle: { fontSize: 11, paddingTop: 8, color: 'hsl(var(--muted-foreground))' },
  iconType: 'circle' as const,
  iconSize: 8,
};

/** Format compacto de números (1.2M, 850K). */
export function fmtCompact(v: number): string {
  return new Intl.NumberFormat('es-CO', { notation: 'compact', maximumFractionDigits: 1 }).format(v);
}

/** Format de fecha YYYY-MM-DD a "DD MMM" (es-CO). Maneja UTC para evitar offset. */
export function fmtDay(s: string): string {
  const d = new Date(s + 'T00:00:00Z');
  return d.toLocaleDateString('es-CO', { day: '2-digit', month: 'short' });
}

/** Format de fecha YYYY-MM-DD a "DD/MM" (compacto para ejes con muchos ticks). */
export function fmtDayShort(s: string): string {
  const d = new Date(s);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Tone semantic → token CSS color. Útil para `<Bar fill={...}>`. */
export const SEMANTIC_COLORS = {
  success: 'hsl(var(--success))',
  danger:  'hsl(var(--danger))',
  warning: 'hsl(var(--warning))',
  info:    'hsl(var(--info))',
  accent:  'hsl(var(--accent))',
  ai:      'hsl(var(--ai))',
  muted:   'hsl(var(--muted-foreground))',
} as const;

/** Paleta cíclica de 6 colores semánticos para series múltiples
 *  (carriers, ciudades, etc). Pensada para que cada índice quede
 *  distinguible incluso en dark mode. */
export const SERIES_PALETTE = [
  SEMANTIC_COLORS.info,
  SEMANTIC_COLORS.success,
  SEMANTIC_COLORS.warning,
  SEMANTIC_COLORS.ai,
  SEMANTIC_COLORS.accent,
  SEMANTIC_COLORS.danger,
];

export function paletteAt(index: number): string {
  return SERIES_PALETTE[index % SERIES_PALETTE.length];
}

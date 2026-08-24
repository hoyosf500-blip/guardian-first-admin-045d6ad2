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

// Poda 24-ago-2026: se borraron CHART_TOOLTIP_ITEM_STYLE, CHART_X_AXIS_PROPS,
// CHART_Y_AXIS_PROPS, CHART_LEGEND_PROPS, fmtDayShort, SERIES_PALETTE y
// paletteAt — cero consumidores (auditoría KPIs). Los axis-props "compartidos"
// además mentían: cada chart define sus ejes inline con otros valores. Si
// algún día se unifican los ejes, recrearlos desde los valores reales en uso.

/** Format compacto de números (1.2M, 850K). */
export function fmtCompact(v: number): string {
  return new Intl.NumberFormat('es-CO', { notation: 'compact', maximumFractionDigits: 1 }).format(v);
}

/** Format de fecha YYYY-MM-DD a "DD MMM" (es-CO). Maneja UTC para evitar offset. */
export function fmtDay(s: string): string {
  const d = new Date(s + 'T00:00:00Z');
  // timeZone:'UTC' obligatorio: se parsea como medianoche UTC, así que renderizar
  // en zona local (Bogotá/Guayaquil = UTC-5) corría el rótulo -1 día — el bucket
  // del 15 salía "14 jul" y la MISMA serie del wallet mostraba dos fechas
  // distintas según el chart (BilleteraTab vs CashFlowChart).
  return d.toLocaleDateString('es-CO', { day: '2-digit', month: 'short', timeZone: 'UTC' });
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


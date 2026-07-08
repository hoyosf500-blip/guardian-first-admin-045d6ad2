// Formateo PURO del historial de intentos por asesor (Fase 2a). Sin React, sin red.
// Cada "intento" = una fila de order_results (conf/canc/noresp con operator_id + hora).
// Se muestra en la ficha de Confirmar para que la asesora vea qué hizo cada quién
// y no repita trabajo — sin abrir la página de detalle.

export interface AttemptRow {
  id?: string;
  result: string;               // 'conf' | 'canc' | 'noresp' | otro
  reason?: string | null;
  operator_id?: string | null;
  result_time?: string | null;  // 'HH:mm' (hora local del asesor al marcar)
  result_date?: string | null;  // 'YYYY-MM-DD'
  created_at?: string | null;    // ISO (fallback)
}

/** Etiqueta corta del resultado. Espeja timelineBuilder ("No respondió la llamada", etc.). */
export function attemptLabel(result: string): string {
  switch (result) {
    case 'conf': return 'confirmó';
    case 'canc': return 'canceló';
    case 'noresp': return 'no contestó';
    default: return result || 'gestión';
  }
}

/** Color semántico para el chip (tokens del design system). */
export function attemptTone(result: string): 'green' | 'red' | 'yellow' | 'muted' {
  switch (result) {
    case 'conf': return 'green';
    case 'canc': return 'red';
    case 'noresp': return 'yellow';
    default: return 'muted';
  }
}

/** Hora legible del intento: prefiere result_time (HH:mm, ya local); si no, la hora de created_at. */
export function attemptClock(row: AttemptRow): string {
  if (row.result_time && /^\d{1,2}:\d{2}/.test(row.result_time)) {
    return row.result_time.slice(0, 5);
  }
  if (row.created_at) {
    const d = new Date(row.created_at);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', hour12: false });
    }
  }
  return '';
}

/**
 * Sufijo de día para un intento que NO es de hoy ("ayer", "2 jul"). Vacío si es hoy o
 * no se puede fechar. `todayStr` = 'YYYY-MM-DD' de hoy (se inyecta para testear).
 */
export function attemptDaySuffix(row: AttemptRow, todayStr: string): string {
  const date = row.result_date || (row.created_at ? row.created_at.slice(0, 10) : '');
  if (!date || date === todayStr) return '';
  // Ayer
  const t = new Date(`${todayStr}T00:00:00`);
  const d = new Date(`${date}T00:00:00`);
  const diffDays = Math.round((t.getTime() - d.getTime()) / 86400000);
  if (diffDays === 1) return 'ayer';
  // Fecha corta "2 jul"
  const meses = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const parts = date.split('-');
  if (parts.length === 3) {
    const mi = Number(parts[1]) - 1;
    const day = Number(parts[2]);
    if (mi >= 0 && mi < 12 && day >= 1) return `${day} ${meses[mi]}`;
  }
  return '';
}

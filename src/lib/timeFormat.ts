/**
 * Helpers de formato de tiempo para la sección Jornada del dashboard
 * de productividad. Mantenidos puros para test fácil.
 */

/**
 * Formatea una cantidad de segundos como "Xh Ym" / "Xm" / "—".
 *
 * Ejemplos:
 *   formatDurationHM(0)     → '—'
 *   formatDurationHM(59)    → '<1m'
 *   formatDurationHM(60)    → '1m'
 *   formatDurationHM(3599)  → '59m'
 *   formatDurationHM(3600)  → '1h 0m'
 *   formatDurationHM(7320)  → '2h 2m'
 */
export function formatDurationHM(totalSeconds: number | null | undefined): string {
  if (totalSeconds == null || !Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return totalSeconds === 0 ? '—' : '—';
  }
  if (totalSeconds < 60) return '<1m';
  const totalMin = Math.floor(totalSeconds / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

/**
 * Formatea un timestamp como hora del día en zona Bogotá ("08:34 a. m.").
 * Devuelve '—' si el input es null/undefined.
 *
 * Usa Intl.DateTimeFormat con 'es-CO' para AM/PM en español. La zona se fija
 * a America/Bogota para que el admin viendo desde otra zona vea hora local
 * de la operadora (que es donde está la operación COD).
 */
export function formatTimeBogota(ts: string | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('es-CO', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/Bogota',
  }).format(d);
}

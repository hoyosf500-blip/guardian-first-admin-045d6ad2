/**
 * Lógica pura de la GESTIÓN de novedades en /novedades.
 *
 * La "marca de gestión" NO usa una tabla nueva: reusa los `touchpoints` que el
 * CRM ya escribe (mismo patrón que segOwnership). Cada gestión es un touchpoint
 * con `action` prefijado `NOVEDAD:` y el resultado codificado en el texto. Este
 * módulo es el único lugar que sabe traducir entre el enum de resultado y ese
 * string — así el writer (useMarkNovedadResolved) y el reader
 * (useNovedadesSeguimiento) nunca se desincronizan.
 *
 * Reconoce además el formato LEGACY ('Volver a ofrecer', 'Devolver al
 * remitente') que ya escribían useNovedades/OrderDetailPage, para que el
 * Seguimiento incluya el histórico ya registrado y no arranque vacío.
 *
 * Todo es puro y determinista (sin Date.now / red) → testeable aislado.
 */

export type NovedadResultTipo = 'resuelta' | 'devolucion' | 'sin_respuesta';

/** Outcome de entrega derivado del estado REAL sincronizado desde Dropi. */
export type DeliveryOutcome = 'entregada' | 'devuelta' | 'en_proceso' | 'otro';

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Etiqueta corta para UI por tipo de resultado. */
export const NOVEDAD_TIPO_LABEL: Record<NovedadResultTipo, string> = {
  resuelta: 'Resuelta',
  devolucion: 'Devolución',
  sin_respuesta: 'Sin respuesta',
};

/**
 * Construye el `action` canónico que se guarda en touchpoints.
 *   resuelta     → 'NOVEDAD: Resuelta — <nota>'  (o sin nota)
 *   devolucion   → 'NOVEDAD: Devolución'
 *   sin_respuesta→ 'NOVEDAD: Sin respuesta'
 */
export function buildNovedadAction(tipo: NovedadResultTipo, nota?: string | null): string {
  if (tipo === 'devolucion') return 'NOVEDAD: Devolución';
  if (tipo === 'sin_respuesta') return 'NOVEDAD: Sin respuesta';
  const clean = (nota || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  return clean ? `NOVEDAD: Resuelta — ${clean}` : 'NOVEDAD: Resuelta';
}

export interface ParsedNovedadAction {
  /** null si el action NO es una gestión de novedad. */
  tipo: NovedadResultTipo | null;
  /** Nota libre (solo aplica a 'resuelta'); null si no hay. */
  nota: string | null;
}

/** ¿Este touchpoint.action es una gestión de novedad? */
export function isNovedadAction(action: string | null | undefined): boolean {
  return !!action && /^\s*novedad\s*:/i.test(stripAccents(action));
}

/**
 * Parsea un `action` de touchpoint a { tipo, nota }. La clasificación se hace
 * SOBRE LA ETIQUETA (lo que va antes del separador "—"), nunca sobre la nota,
 * para que 'NOVEDAD: Resuelta — le devolví la llamada' NO se cuente como
 * devolución.
 */
export function parseNovedadAction(action: string | null | undefined): ParsedNovedadAction {
  if (!isNovedadAction(action)) return { tipo: null, nota: null };
  const body = (action as string).trim().replace(/^novedad\s*:\s*/i, '');

  // Separador etiqueta — nota: espacio + raya (em/en/guion) + espacio.
  let label = body;
  let nota: string | null = null;
  const sep = body.match(/\s[—–-]\s(.+)$/);
  if (sep && sep.index != null) {
    nota = sep[1].trim() || null;
    label = body.slice(0, sep.index).trim();
  }

  const norm = stripAccents(label).toLowerCase();
  if (/devoluc|devolver/.test(norm)) return { tipo: 'devolucion', nota: null };
  if (/sin respuesta|no respond|no contest/.test(norm)) return { tipo: 'sin_respuesta', nota: null };
  if (/resuelt|volver a ofrecer|reofrec|reagend|ofrecer/.test(norm)) return { tipo: 'resuelta', nota };
  // Gestión de novedad con etiqueta desconocida (legacy raro): la contamos como
  // resuelta (fue trabajo real) en vez de descartarla.
  return { tipo: 'resuelta', nota };
}

/**
 * Clasifica el estado REAL del pedido (sincronizado desde Dropi) en un outcome
 * de entrega — para responder "de las resueltas, ¿cuántas se entregaron?".
 */
export function classifyDeliveryOutcome(estado: string | null | undefined): DeliveryOutcome {
  if (!estado) return 'otro';
  const e = stripAccents(estado).toUpperCase();
  if (e.includes('ENTREGAD')) return 'entregada';
  if (e.includes('DEVUELT') || e.includes('DEVOLUC') || e.includes('RECHAZ')) return 'devuelta';
  if (
    e.includes('NOVEDAD') ||
    e.includes('INTENTO DE ENTREGA') ||
    e.includes('REPARTO') ||
    e.includes('TRANSITO') ||
    e.includes('RUTA') ||
    e.includes('PROCESO') ||
    e.includes('DESPACH') ||
    e.includes('GUIA GENERADA') ||
    e.includes('OFICINA')
  ) {
    return 'en_proceso';
  }
  return 'otro';
}

/** Texto de la novedad listo para mostrar (trim + colapsa espacios + corta). */
export function normalizeNovedadLabel(novedad: string | null | undefined): string {
  const t = (novedad || '').replace(/\s+/g, ' ').trim();
  if (!t) return 'Sin descripción';
  return t.slice(0, 120);
}

/** Clave de agrupación (sin acentos, mayúsculas) para el ranking de frecuencia. */
export function novedadGroupKey(novedad: string | null | undefined): string {
  return stripAccents(normalizeNovedadLabel(novedad)).toUpperCase();
}

/**
 * Formatea una duración en ms a algo humano: '<1m', '45m', '1h 20m', '2d 3h'.
 * Negativos o no-finitos → '—'.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !isFinite(ms) || ms < 0) return '—';
  if (ms < 60000) return '<1m';
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

/**
 * Devuelve la fecha 'YYYY-MM-DD' que está `n` días calendario antes de `today`
 * (también 'YYYY-MM-DD'). Usa aritmética en UTC sobre la fecha sola, así que es
 * pura y determinista (no depende de Date.now ni de la TZ del navegador).
 */
export function bogotaDateNDaysAgo(today: string, n: number): string {
  const [y, m, d] = today.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - n);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(dt);
}

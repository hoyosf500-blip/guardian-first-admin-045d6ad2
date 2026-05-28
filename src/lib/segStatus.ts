/**
 * Clasificador único de `estado` de Dropi en categorías de Seguimiento.
 *
 * Lo extrajimos para que CrmTable (que muestra el Kanban) y SeguimientoTab (que
 * muestra las cards de resumen) usen la MISMA lógica. Antes había dos
 * clasificadores duplicados — el de SeguimientoTab no incluía los matchers EC
 * (`INGRESANDO …`, `EN RUTA …`, `PARA RETIRO …`, `RECLAME …`), así que los
 * pedidos EC caían en `otros` y el resumen mostraba solo 3 cards mientras que
 * el Kanban abajo sí mostraba las 5+ columnas reales.
 *
 * Si Dropi agrega una variante nueva (lo hace cada par de meses sin avisar),
 * agregarla al matcher correspondiente acá: ambos consumidores se actualizan.
 */

/**
 * Identidad de cada categoría que mostramos en Seguimiento. La string `key` es
 * la que se persiste en sessionStorage (filtro activo) y la que viajan entre
 * componentes — cambiarla rompe el filtro guardado de los usuarios.
 */
export type SegStatusKey =
  | 'procesamiento'
  | 'guia'
  | 'bodega_trans'
  | 'transito'
  | 'reparto'
  | 'novedad'
  | 'oficina'
  | 'rechazado'
  | 'novedad_sol'
  | 'devolucion_transito'
  | 'devolucion'
  | 'indemnizada'
  | 'entregado'
  | 'cancelado'
  | 'otros';

// ── Matchers ────────────────────────────────────────────────────────────────
// Helpers de clasificación — usamos prefijos/regex para capturar variantes EC
// que Dropi inventa sin avisar (EN RUTA A CENTRO LOGISTICO, EN RUTA A
// CONCESION, INGRESANDO OPERATIVO A, ASIGNADO A <transportadora>, etc.)
// Sin esto, todos los pedidos EC en fase tránsito caen en "Otros" y la
// operadora ve una columna gigante sin priorización real.

const PROCESAMIENTO_EXACT = new Set([
  'PENDIENTE',
  'EN PROCESAMIENTO',
  'ALISTAMIENTO',
  'EN BODEGA DROPI',
  'RECOGIDO POR DROPI',
  'EN PUNTO DROOP', // typo histórico de Dropi
]);

const GUIA_EXACT = new Set([
  'GUIA GENERADA',
  'GUIA_GENERADA',
  'PREPARADO PARA TRANSPORTADORA',
  'ENTREGADO A TRANSPORTADORA',
]);

const BODEGA_TRANS_EXACT = new Set([
  'EN BODEGA TRANSPORTADORA',
  'ADMITIDA',
]);

const TRANSITO_EXACT = new Set([
  'EN TRANSPORTE',
  'EN DESPACHO',
  'EN TRASLADO NACIONAL',
  'EN TERMINAL ORIGEN',
  'EN TERMINAL DESTINO',
  'ENTREGADA A CONEXIONES',
  'EN DISTRIBUCION',
  'EN REEXPEDICION',
  'DESPACHADA',
  'EN ESPERA DE RUTA DOMESTICA',
  'BODEGA DESTINO',
  'EN BODEGA ORIGEN',
]);

const REPARTO_EXACT = new Set([
  'EN REPARTO',
  'TELEMERCADEO',
  'REENVÍO',
  'REENVIO',
]);

/** Tránsito: covers EC variantes (`EN RUTA …`, `INGRESANDO …`, `ASIGNADO …`). */
const matchTransito = (e: string): boolean => {
  if (TRANSITO_EXACT.has(e)) return true;
  if (e.startsWith('EN RUTA')) return true;
  if (e.startsWith('INGRESANDO')) return true;
  if (e.startsWith('ASIGNADO')) return true;
  return false;
};

/** "Reclame en Oficina": cubre CO/EC variantes (`RECLAME EN …`, `PARA RETIRO …`). */
const matchOficina = (e: string): boolean =>
  e.includes('OFICINA') ||
  e.includes('RECLAME') ||
  e.includes('RECLAMAR') ||
  e.includes('EN PUNTO') ||
  e.startsWith('PARA RETIRO') ||
  e.startsWith('RETIRO');

/** Matchers en orden de prioridad. `otros` es el fallback y SIEMPRE va último. */
export const SEG_STATUS_MATCHERS: ReadonlyArray<{ key: SegStatusKey; match: (e: string) => boolean }> = [
  { key: 'procesamiento', match: (e) => PROCESAMIENTO_EXACT.has(e) },
  { key: 'guia', match: (e) => GUIA_EXACT.has(e) },
  { key: 'bodega_trans', match: (e) => BODEGA_TRANS_EXACT.has(e) },
  { key: 'transito', match: matchTransito },
  { key: 'reparto', match: (e) => REPARTO_EXACT.has(e) },
  { key: 'novedad', match: (e) => e === 'NOVEDAD' || e === 'INTENTO DE ENTREGA' },
  { key: 'oficina', match: matchOficina },
  { key: 'rechazado', match: (e) => e === 'RECHAZADO' },
  { key: 'novedad_sol', match: (e) => e === 'NOVEDAD SOLUCIONADA' },
  { key: 'devolucion_transito', match: (e) => e === 'DEVOLUCION EN TRANSITO' },
  { key: 'devolucion', match: (e) => e === 'DEVOLUCION' || e === 'DEVUELTO' },
  { key: 'indemnizada', match: (e) => e.includes('INDEMNIZADA') },
  { key: 'entregado', match: (e) => e === 'ENTREGADO' },
  { key: 'cancelado', match: (e) => e === 'CANCELADO' || e === 'ARCHIVADO_GHOST' },
];

// Alerting de estados nuevos — log una sola vez por estado para no spamear.
// Cuando Dropi agrega una variante ("EN REPARTO ESPECIAL"), cae en `otros` y
// queda visible un warning en la consola del navegador para que el dev lo
// agregue al matcher correspondiente.
const _unclassifiedSeen = new Set<string>();

/**
 * Clasifica un `estado` de Dropi en una `SegStatusKey`. Acepta cualquier casing
 * (uppercasea internamente). Estados desconocidos caen en `'otros'` y emiten un
 * `console.warn` la primera vez que aparecen.
 */
export function classifySegEstado(estado: string): SegStatusKey {
  if (!estado) return 'otros';
  const e = estado.toUpperCase().trim();
  for (const m of SEG_STATUS_MATCHERS) {
    if (m.match(e)) return m.key;
  }
  if (!_unclassifiedSeen.has(e)) {
    _unclassifiedSeen.add(e);
    console.warn(`[segStatus] Estado sin clasificar: "${e}" → cae en 'otros'. Si Dropi agregó esta variante, agregarla a SEG_STATUS_MATCHERS.`);
  }
  return 'otros';
}

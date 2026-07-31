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

// ── Estados de Ecuador vistos EN PRODUCCIÓN el 31-jul-2026 ──
// Se leyeron del tablero en vivo de Rushmira Ecuador, donde caían sin clasificar
// (238 pedidos en total entre los seis). No son adivinanzas: son los rótulos
// exactos que manda Dropi EC.
//   ZONA DE ENTREGA (56) · EN DISTRIBUCIÓN A CLIENTE (16) → va en camino al
//     cliente = En Reparto (avisarle que llega hoy).
//   POR RECOLECTAR (16) → la guía existe pero la transportadora todavía no lo
//     recogió = Guía Generada (y así entra a la alarma de "pendientes de guía",
//     que es donde tiene que verse: llevaban 13 días quietos).
//   EN DISTRIBUCION PARA ENTREGA EN AGENCIA (3) → lo recoge el cliente = Oficina.
//   EN PROCESO DE DEVOLUCION (1) → Dev. en Tránsito.
//   INGRESO A CONFIRMACION (1) → arranque del flujo = En Procesamiento.
const PROCESAMIENTO_EXACT = new Set([
  'PENDIENTE',
  'EN PROCESAMIENTO',
  'ALISTAMIENTO',
  'EN BODEGA DROPI',
  'RECOGIDO POR DROPI',
  'INGRESO A CONFIRMACION',
  // Tramo pre-guía: el pedido ya se confirmó pero la guía todavía no existe.
  // Vivían solo en segLists.ESTADOS_PRE_GUIA; al unificar el clasificador
  // tienen que estar acá o el pedido cae en 'otros' y se pierde la alarma de
  // indemnización por guía que nunca se generó.
  'CONFIRMADO',
  'GENERADO',
  // 'EN PUNTO DROOP' NO va acá: "droop" = drop point, un punto de retiro donde
  // el CLIENTE debe ir a recoger (igual que segLists.ESTADOS_OFICINA lo trata).
  // Tenerlo en procesamiento le escondía la urgencia a la operadora en el
  // Kanban mientras el paquete vencía en el punto (auditoría 2026-07-31).
  // Lo captura matchOficina vía `includes('EN PUNTO')`.
]);

const GUIA_EXACT = new Set([
  'GUIA GENERADA',
  'GUIA_GENERADA',
  'PREPARADO PARA TRANSPORTADORA',
  'ENTREGADO A TRANSPORTADORA',
  'POR RECOLECTAR',
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
  // Los dos que el SQL desplegado (_estado_bucket) ya trataba como tránsito y
  // que solo vivían en segLists. Exactos a propósito: 'EN DISTRIBUCION PARA
  // ENTREGA EN AGENCIA' NO es tránsito — es retiro del cliente (oficina).
  'EN BODEGA',
  'DISTRIBUCION PARA ENTREGA',
]);

const REPARTO_EXACT = new Set([
  'EN REPARTO',
  'TELEMERCADEO',
  'REENVÍO',
  'REENVIO',
  'ZONA DE ENTREGA',
  // Exacto y no `startsWith('EN DISTRIBUCION')`: 'EN DISTRIBUCION' pelado es
  // tránsito y 'EN DISTRIBUCION PARA ENTREGA EN AGENCIA' es oficina.
  'EN DISTRIBUCION A CLIENTE',
]);

/**
 * Tránsito: covers EC variantes (`EN RUTA …`, `INGRESANDO …`, `ASIGNADO …`).
 *
 * Se exporta porque `STALLED_LABEL_TO_MATCH` en CrmTable.tsx también lo
 * necesita — el commit 05f6363 lo dejó como const privado y eso crasheaba
 * /seguimiento con "matchTransito is not defined" cuando el módulo cargaba.
 */
export const matchTransito = (e: string): boolean => {
  if (TRANSITO_EXACT.has(e)) return true;
  if (e.startsWith('EN RUTA')) return true;
  if (e.startsWith('INGRESANDO')) return true;
  if (e.startsWith('ASIGNADO')) return true;
  // Las dos formas más obvias de "va en camino" no estaban: llegaban de EC y
  // caían al cajón "Otros", que por eso era la columna más grande del tablero.
  // Van como prefijo porque Dropi les cuelga destino atrás ("EN TRANSITO A UIO").
  if (e.startsWith('EN TRANSITO')) return true;
  if (e.startsWith('EN CAMINO')) return true;
  return false;
};

/**
 * "Reclame en Oficina": cubre CO/EC variantes (`RECLAME EN …`, `PARA RETIRO …`).
 *
 * Se exporta — mismo motivo que `matchTransito`.
 */
export const matchOficina = (e: string): boolean =>
  e.includes('OFICINA') ||
  e.includes('RECLAME') ||
  e.includes('RECLAMAR') ||
  e.includes('EN PUNTO') ||
  // Cualquier variante de "entrega en agencia": el paquete espera al CLIENTE en
  // un punto, no va a su puerta. Cubre 'EN DISTRIBUCION PARA ENTREGA EN AGENCIA'
  // y las de retiro que ya existían.
  e.includes('AGENCIA') ||
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
  // SOLUCION APROBADA = variante EC de "novedad solucionada". Antes caía en
  // 'otros' (vista en consola Rushmira Ecuador 2026-05-28).
  { key: 'novedad_sol', match: (e) => e === 'NOVEDAD SOLUCIONADA' || e === 'SOLUCION APROBADA' },
  { key: 'devolucion_transito', match: (e) => e === 'DEVOLUCION EN TRANSITO' || e === 'EN PROCESO DE DEVOLUCION' },
  { key: 'devolucion', match: (e) => e === 'DEVOLUCION' || e === 'DEVUELTO' },
  { key: 'indemnizada', match: (e) => e.includes('INDEMNIZADA') },
  { key: 'entregado', match: (e) => e === 'ENTREGADO' },
  // 'ARCHIVADO GHOST' con ESPACIO es la escritura canónica (la que reconoce
  // _estado_bucket en SQL y la que escribe dropi-nightly-reconcile); el guion
  // bajo son filas históricas. Faltaba la primera: los pedidos borrados en
  // Dropi no se clasificaban y aparecían como si siguieran vivos.
  { key: 'cancelado', match: (e) => e === 'CANCELADO' || e === 'REEMPLAZADA' || e === 'ARCHIVADO GHOST' || e === 'ARCHIVADO_GHOST' },
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
  // Se quitan las TILDES antes de comparar: Dropi Ecuador manda "EN TRÁNSITO" y
  // "DEVOLUCIÓN" acentuados y todos los matchers están escritos sin tilde, así
  // que caían en 'otros' aunque la variante estuviera contemplada. Es el mismo
  // NFD que ya usa el heurístico de direcciones.
  const e = estado.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
  for (const m of SEG_STATUS_MATCHERS) {
    if (m.match(e)) return m.key;
  }
  if (!_unclassifiedSeen.has(e)) {
    _unclassifiedSeen.add(e);
    console.warn(`[segStatus] Estado sin clasificar: "${e}" → cae en 'otros'. Si Dropi agregó esta variante, agregarla a SEG_STATUS_MATCHERS.`);
  }
  return 'otros';
}

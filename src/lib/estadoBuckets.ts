// Mapeo estado de pedido → bucket del embudo. Función PURA + testeable.
//
// Recibe el desglose CRUDO por estado (del RPC orders_estado_breakdown) y lo
// agrupa en buckets. CLAVE: cualquier estado que NO esté en el mapa va a `otros`
// ITEMIZADO POR NOMBRE — nunca se oculta en una bolsa anónima. Si Dropi agrega un
// estado nuevo, aparece con su nombre y sabemos que hay que mapearlo.
//
// Alineado con las listas del RPC logistics_summary
// (20260521233349) + un bucket NUEVO `preparacion` para los estados intermedios
// (CONFIRMADO, GUIA GENERADA, PREPARANDO, etc.) que antes caían en "Otros" (~16%).

export type BucketKey =
  | 'pendiente'
  | 'preparacion'
  | 'en_transito'
  | 'novedad'
  | 'entregado'
  | 'devuelto'
  | 'rechazado'
  | 'cancelado';

export interface EstadoRow {
  estado: string;
  pedidos: number;
  valor: number;
  unidades: number;
}

export interface BucketTotals {
  pedidos: number;
  valor: number;
  unidades: number;
}

export interface BucketizeResult {
  buckets: Record<BucketKey, BucketTotals>;
  /** Estados que no matchearon ningún bucket — itemizados por nombre (no ocultos). */
  otros: EstadoRow[];
  /** Nombres CRUDOS de los estados sin mapear. Detector permanente: si Dropi manda
   *  un estado nuevo, la UI lo puede avisar en vez de tragárselo y romper los KPIs. */
  estadosSinMapear: string[];
  totals: BucketTotals;
}

// Normaliza un estado para el lookup: mayúsculas, sin espacios extra, y `_`→espacio
// (Dropi a veces manda GUIA_GENERADA y a veces GUIA GENERADA).
export function normalizeEstado(raw: string): string {
  return (raw ?? '')
    .toUpperCase()
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// estado normalizado → bucket. Las listas de transit/devuelto/novedad/pendiente/
// cancelado replican logistics_summary; `preparacion` es nuevo.
export const ESTADO_TO_BUCKET: Record<string, BucketKey> = {
  // entregado
  'ENTREGADO': 'entregado',
  'ENTREGADO A DESTINO': 'entregado',
  // devuelto (devolución logística — distinto de rechazo del cliente)
  'DEVOLUCION': 'devuelto',
  'DEVOLUCION EN TRANSITO': 'devuelto',
  'DEVOLUCION A ORIGEN': 'devuelto',
  // rechazado (el cliente rechazó en la entrega) — bucket PROPIO: no es una
  // devolución logística y NO cuenta en la tasa de entrega madura (decisión del
  // dueño 2026-06-24). Se muestra aparte en el embudo.
  'RECHAZADO': 'rechazado',
  // en tránsito
  'EN TRANSITO': 'en_transito', // EC lo manda con tilde ("EN TRÁNSITO") — lo cubre el lookup sin acentos
  'EN CAMINO': 'en_transito',   // EC
  'EN BODEGA': 'en_transito',   // EC: bodega de la transportadora (las de Dropi 'EN BODEGA DROPI' son exact-match aparte)
  'EN TRANSPORTE': 'en_transito',
  'EN DESPACHO': 'en_transito',
  'EN TRASLADO NACIONAL': 'en_transito',
  'EN TERMINAL ORIGEN': 'en_transito',
  'EN TERMINAL DESTINO': 'en_transito',
  'EN REPARTO': 'en_transito',
  'EN DISTRIBUCION': 'en_transito',
  'EN REEXPEDICION': 'en_transito',
  'TELEMERCADEO': 'en_transito',
  'REENVIO': 'en_transito',
  'REENVÍO': 'en_transito',
  'EN BODEGA TRANSPORTADORA': 'en_transito',
  'ADMITIDA': 'en_transito',
  'DESPACHADA': 'en_transito',
  'EN BODEGA DESTINO': 'en_transito',
  'EN PUNTO DROOP': 'en_transito',
  // novedad
  'NOVEDAD': 'novedad',
  'INTENTO DE ENTREGA': 'novedad',
  'NOVEDAD SOLUCIONADA': 'novedad',
  'REPROGRAMADO': 'novedad',
  'RECLAME EN OFICINA': 'novedad', // riesgo de no-entrega, no tránsito normal
  'EN PROCESO DE INDEMNIZACION': 'novedad', // pedido fallido en compensación — gestión, no sin-clasificar
  'EN PROCESO DE INDEMNIZACIÓN': 'novedad',
  'INDEMNIZADA': 'novedad',
  // pendiente (sin confirmar / sin despachar)
  'PENDIENTE': 'pendiente',
  'PENDIENTE CONFIRMACION': 'pendiente',
  'PENDIENTE CONFIRMACIÓN': 'pendiente',
  // preparación (NUEVO — antes caían en "Otros")
  'CONFIRMADO': 'preparacion',
  'GENERADO': 'preparacion',
  'GUIA GENERADA': 'preparacion',
  'GUÍA GENERADA': 'preparacion',
  'PREPARANDO': 'preparacion',
  'PREPARANDO PARA ENVIO': 'preparacion',
  'PREPARANDO PARA ENVÍO': 'preparacion',
  'PREPARADO PARA TRANSPORTADORA': 'preparacion',
  'ENTREGADO A TRANSPORTADORA': 'preparacion',
  'EN PROCESAMIENTO': 'preparacion',
  'PROCESANDO': 'preparacion',
  'ALISTAMIENTO': 'preparacion',
  'EN ALISTAMIENTO': 'preparacion',
  'EN BODEGA DROPI': 'preparacion',
  'RECOGIDO POR DROPI': 'preparacion',
  'POR RECOLECTAR': 'preparacion', // EC: guía generada, la transportadora aún no recogió el paquete
  // cancelado
  'CANCELADO': 'cancelado',
  // Órdenes soft-borradas (REEMPLAZADA por edición / ARCHIVADO_GHOST). OJO
  // asimetría deliberada con el server: _estado_bucket (SQL) las manda a un
  // bucket 'borrado' y las EXCLUYE de todas las RPCs; el cliente solo las ve
  // por la RPC vieja o por realtime, y tratarlas como canceladas las saca de
  // los tiles "sin cancelar" — el efecto neto es el mismo.
  'REEMPLAZADA': 'cancelado',
  'ARCHIVADO GHOST': 'cancelado',
};

// Fallback por CONTENIDO para estados de transportadoras de Ecuador (Servientrega
// EC / Gintracom / Laar) que el lookup EXACTO no agarra porque traen sufijos de
// ubicación variables (ej. "INGRESANDO OPERATIVO A BODEGA QUITO") y/o acentos.
// Se evalúa SOLO si el lookup exacto falla, sobre el estado normalizado + sin
// acentos. Lección del bug de categorías de wallet: el match exacto es frágil
// con variantes de texto. Patrones específicos para no sobre-matchear.
// Los patrones TERMINALES (cancel/devoluc/devuelt) van PRIMERO para que una
// variante como "DEVOLUCION EN CENTRO LOGISTICO" no caiga en tránsito —
// espejo de _estado_bucket() en la migration 20260707120000.
const ESTADO_FALLBACK_PATTERNS: Array<[string, BucketKey]> = [
  ['CANCEL', 'cancelado'],   // "CANCELADO POR TRANSPORTADORA", etc. (paridad con NOT LIKE '%CANCEL%' del server)
  ['DEVOLUC', 'devuelto'],   // variantes DEVOLUCION* nuevas de Dropi
  ['DEVUELT', 'devuelto'],   // "DEVUELTO A ORIGEN", etc.
  ['ASIGNADO', 'en_transito'],   // EC: "ASIGNADO A GINTRACOM"/"ASIGNADO A QUITO" — repartidor/carrier asignado = en la calle. Espeja segStatus.startsWith('ASIGNADO'). (auditoría EC 2026-07-07: caía en 'otros')
  ['INGRESANDO', 'en_transito'], // EC: cubre "INGRESANDO" solo, "INGRESANDO A <bodega>", "INGRESANDO OPERATIVO A <ciudad>", "INGRESANDO DE RECOLECCION A". Antes 'INGRESANDO' pelado caía en 'otros'.
  ['BODEGA ORIGEN', 'en_transito'],
  ['RUTA A', 'en_transito'],           // EC: "EN RUTA A CENTRO LOGISTICO", "RUTA A CONCESION" — cualquier "ruta a X" es tránsito
  ['CENTRO LOGISTICO', 'en_transito'], // EC
  ['RECOLECCION', 'en_transito'],      // EC: "INGRESANDO DE RECOLECCION A <ciudad>"
  ['DISTRIBUCION A CLIENTE', 'en_transito'],
  ['DISTRIBUCION PARA ENTREGA', 'en_transito'],
  ['ZONA DE ENTREGA', 'en_transito'],
  ['RETIRO EN AGENCIA', 'novedad'],   // cliente debe ir a recoger = riesgo no-entrega
  ['SOLICITA RETIRAR', 'novedad'],    // EC: "CLIENTE SOLICITA RETIRAR EN CS" — cliente pide retirar = riesgo no-entrega (auditoría EC 2026-07-07)
  ['SOLUCION APROBADA', 'novedad'],   // lifecycle de novedad resuelta
];

/** Quita acentos para que el fallback matchee "CONCESIÓN"/"DISTRIBUCIÓN" con tilde. */
function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Resuelve el bucket de un estado: lookup exacto y, si falla, fallback por contenido. */
function resolveBucket(estado: string): BucketKey | undefined {
  const norm = normalizeEstado(estado);
  const exact = ESTADO_TO_BUCKET[norm];
  if (exact) return exact;
  // Segundo intento sin acentos: "EN TRÁNSITO" (EC) debe matchear la key
  // 'EN TRANSITO' sin duplicar cada entrada del mapa con su variante con tilde.
  const bare = stripAccents(norm);
  const exactBare = ESTADO_TO_BUCKET[bare];
  if (exactBare) return exactBare;
  const hit = ESTADO_FALLBACK_PATTERNS.find(([pat]) => bare.includes(pat));
  return hit?.[1];
}

function emptyBuckets(): Record<BucketKey, BucketTotals> {
  return {
    pendiente:   { pedidos: 0, valor: 0, unidades: 0 },
    preparacion: { pedidos: 0, valor: 0, unidades: 0 },
    en_transito: { pedidos: 0, valor: 0, unidades: 0 },
    novedad:     { pedidos: 0, valor: 0, unidades: 0 },
    entregado:   { pedidos: 0, valor: 0, unidades: 0 },
    devuelto:    { pedidos: 0, valor: 0, unidades: 0 },
    rechazado:   { pedidos: 0, valor: 0, unidades: 0 },
    cancelado:   { pedidos: 0, valor: 0, unidades: 0 },
  };
}

/**
 * Agrupa el desglose crudo por estado en buckets. Los estados no mapeados van a
 * `otros` con su nombre. Garantiza: Σ(buckets) + Σ(otros) === totals (sin huecos).
 */
export function bucketizeEstados(rows: EstadoRow[]): BucketizeResult {
  const buckets = emptyBuckets();
  const otros: EstadoRow[] = [];
  const totals: BucketTotals = { pedidos: 0, valor: 0, unidades: 0 };

  for (const r of rows || []) {
    const pedidos = Number(r.pedidos) || 0;
    const valor = Number(r.valor) || 0;
    const unidades = Number(r.unidades) || 0;
    totals.pedidos += pedidos;
    totals.valor += valor;
    totals.unidades += unidades;

    const key = resolveBucket(r.estado);
    if (key) {
      buckets[key].pedidos += pedidos;
      buckets[key].valor += valor;
      buckets[key].unidades += unidades;
    } else {
      otros.push({ estado: r.estado, pedidos, valor, unidades });
    }
  }

  // Orden estable de "otros": el más grande primero.
  otros.sort((a, b) => b.pedidos - a.pedidos);

  // Detector: nombres crudos de los estados sin bucket (los que Dropi inventó y
  // todavía no mapeamos). La UI los muestra para que no rompan KPIs en silencio.
  const estadosSinMapear = otros.map((o) => o.estado);

  return { buckets, otros, estadosSinMapear, totals };
}

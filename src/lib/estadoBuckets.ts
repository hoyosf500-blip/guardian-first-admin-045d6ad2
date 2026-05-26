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
  // devuelto
  'DEVOLUCION': 'devuelto',
  'DEVOLUCION EN TRANSITO': 'devuelto',
  'RECHAZADO': 'devuelto',
  'DEVOLUCION A ORIGEN': 'devuelto',
  // en tránsito
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
  // novedad
  'NOVEDAD': 'novedad',
  'INTENTO DE ENTREGA': 'novedad',
  'NOVEDAD SOLUCIONADA': 'novedad',
  'REPROGRAMADO': 'novedad',
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
  // cancelado
  'CANCELADO': 'cancelado',
};

function emptyBuckets(): Record<BucketKey, BucketTotals> {
  return {
    pendiente:   { pedidos: 0, valor: 0, unidades: 0 },
    preparacion: { pedidos: 0, valor: 0, unidades: 0 },
    en_transito: { pedidos: 0, valor: 0, unidades: 0 },
    novedad:     { pedidos: 0, valor: 0, unidades: 0 },
    entregado:   { pedidos: 0, valor: 0, unidades: 0 },
    devuelto:    { pedidos: 0, valor: 0, unidades: 0 },
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

    const key = ESTADO_TO_BUCKET[normalizeEstado(r.estado)];
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

  return { buckets, otros, totals };
}

/**
 * Causa raíz de devoluciones (Módulo 2 de la inteligencia de /novedades).
 *
 * Responde la pregunta cara del negocio: de las devoluciones del período,
 * ¿cuántas eran EVITABLES de nuestro lado (mala data que despachamos igual) y
 * quién las confirmó? El cruce pesado (devolución ↔ semáforo ↔ operadora que
 * confirmó, join exacto por order_id) lo hace la RPC `novedades_root_cause`
 * server-side; este módulo es la capa PURA que resume las filas que vuelven, así
 * que es 100% testeable sin red.
 *
 * "Evitable" (definición elegida por el dueño, 2026-06-23): el pedido salió con
 *   - semáforo en amarillo/rojo, O
 *   - dirección dudosa (rural / sin clasificar), O
 *   - pickup en oficina (que terminó NO retirado → devuelto).
 * Un `validation_decision` NULL (pedido anterior al validador) NO cuenta como
 * evitable por semáforo: no teníamos la señal, no es justo cargárselo a nadie.
 */

import { classifyNovedad, Culpa } from './novedadTaxonomy';

/** Fila cruda que devuelve la RPC: una devolución del período, ya enriquecida. */
export interface RootCauseRow {
  orderId: string;
  novedad: string | null;
  validationDecision: string | null;
  addressKind: string | null;
  /**
   * El semáforo CONGELADO al despachar (`orders.validacion_al_despachar`).
   *
   * `validationDecision` es mutable: se pisa al editar la dirección, y los
   * pedidos MÁS gestionados son justo los que perdieron la marca roja — o sea
   * que leyéndola se ve un semáforo mejor del que es. Cuando el sello está, se
   * usa el sello. Ver la migración 20260822180000; el histórico anterior queda
   * sin sello a propósito y cae al valor mutable, que es lo único que hay.
   */
  validacionAlDespachar?: string | null;
  addressKindAlDespachar?: string | null;
  valor: number | null;
  transportadora: string | null;
  ciudad: string | null;
  /** Operadora que confirmó (último `conf` por order_id); null = carga directa. */
  confirmerId: string | null;
  confirmerName: string | null;
  tieneNovedad: boolean;
}

export type EvitableReason = 'semaforo' | 'direccion' | 'pickup';

const SEMAFORO_RISK = new Set(['yellow', 'red']);
const DIRECCION_RISK = new Set(['rural', 'unknown']);
const PICKUP = 'pickup_office';

const norm = (s: string | null | undefined): string => (s || '').trim().toLowerCase();

/** Motivos por los que una devolución se considera evitable (puede haber varios). */
export function evitableReasons(
  row: Pick<RootCauseRow, 'validationDecision' | 'addressKind'
    | 'validacionAlDespachar' | 'addressKindAlDespachar'>,
): EvitableReason[] {
  // El sello manda sobre el valor vivo. `??` y no `||`: un sello vacío ('') es
  // un valor sellado, no una ausencia.
  const vd = norm(row.validacionAlDespachar ?? row.validationDecision);
  const ak = norm(row.addressKindAlDespachar ?? row.addressKind);
  const reasons: EvitableReason[] = [];
  if (vd === PICKUP || ak === PICKUP) reasons.push('pickup');
  if (SEMAFORO_RISK.has(vd)) reasons.push('semaforo');
  if (DIRECCION_RISK.has(ak)) reasons.push('direccion');
  return reasons;
}

export function isEvitable(
  row: Pick<RootCauseRow, 'validationDecision' | 'addressKind'
    | 'validacionAlDespachar' | 'addressKindAlDespachar'>,
): boolean {
  return evitableReasons(row).length > 0;
}

export interface OperatorRootCause {
  operatorId: string | null;
  name: string;
  devoluciones: number;
  evitables: number;
  valorPerdido: number;
  valorEvitable: number;
  pctEvitable: number | null;
}

export interface CiudadRootCause {
  ciudad: string;
  devoluciones: number;
  evitables: number;
  valorPerdido: number;
}

export interface CategoriaRootCause {
  culpa: Culpa;
  categoria: string;
  devoluciones: number;
  evitables: number;
  valorPerdido: number;
}

export interface RootCauseSummary {
  totalDevoluciones: number;
  evitables: number;
  pctEvitable: number | null;
  valorPerdidoTotal: number;
  valorPerdidoEvitable: number;
  conConfirmador: number;
  sinConfirmador: number;
  porReason: Record<EvitableReason, number>;
  porOperadora: OperatorRootCause[];
  porCategoria: CategoriaRootCause[];
  /**
   * Dónde se devuelven, no por culpa de quién.
   *
   * La auditoría de julio en Ecuador encontró Cuenca al 21% de devolución
   * contra el promedio de la operación, y ese hallazgo no se veía en ninguna
   * pantalla: la causa raíz agrupaba por operadora y por categoría, nunca por
   * ciudad. Una ciudad que devuelve el doble no es culpa de nadie del equipo —
   * es cobertura, transportadora o dirección, y se arregla distinto.
   */
  porCiudad: CiudadRootCause[];
}

const NO_CONFIRMADOR = 'Carga directa / sin confirmar';
const val = (v: number | null): number => (typeof v === 'number' && isFinite(v) ? v : 0);

/** Resume las devoluciones del período en KPIs + ranking de operadoras + categorías. */
export function summarizeRootCause(rows: RootCauseRow[]): RootCauseSummary {
  const porReason: Record<EvitableReason, number> = { semaforo: 0, direccion: 0, pickup: 0 };
  const opMap = new Map<string, OperatorRootCause>();
  const catMap = new Map<string, CategoriaRootCause>();
  const ciuMap = new Map<string, CiudadRootCause>();

  let evitables = 0;
  let valorPerdidoTotal = 0;
  let valorPerdidoEvitable = 0;
  let conConfirmador = 0;

  for (const r of rows) {
    const reasons = evitableReasons(r);
    const evit = reasons.length > 0;
    const v = val(r.valor);
    valorPerdidoTotal += v;
    if (evit) {
      evitables += 1;
      valorPerdidoEvitable += v;
      for (const reason of reasons) porReason[reason] += 1;
    }
    if (r.confirmerId) conConfirmador += 1;

    // Ranking por operadora confirmadora (null → bucket carga directa).
    const opKey = r.confirmerId ?? '__none__';
    let op = opMap.get(opKey);
    if (!op) {
      op = {
        operatorId: r.confirmerId,
        name: r.confirmerId ? (r.confirmerName || 'Operadora') : NO_CONFIRMADOR,
        devoluciones: 0, evitables: 0, valorPerdido: 0, valorEvitable: 0, pctEvitable: null,
      };
      opMap.set(opKey, op);
    }
    op.devoluciones += 1;
    op.valorPerdido += v;
    if (evit) { op.evitables += 1; op.valorEvitable += v; }

    // Desglose por categoría de novedad (taxonomía regex client-side).
    const { culpa, categoria } = classifyNovedad(r.novedad);
    const catKey = `${culpa}|${categoria}`;
    let cat = catMap.get(catKey);
    if (!cat) {
      cat = { culpa, categoria, devoluciones: 0, evitables: 0, valorPerdido: 0 };
      catMap.set(catKey, cat);
    }
    cat.devoluciones += 1;
    cat.valorPerdido += v;
    if (evit) cat.evitables += 1;

    // Por ciudad. Sin ciudad va a su propio bucket VISIBLE: meterlo en una
    // ciudad real la ensuciaría, y esconderlo haría que los totales de la
    // tabla no cuadren con el total de arriba.
    const ciudad = (r.ciudad || '').trim() || 'Sin ciudad';
    let ciu = ciuMap.get(ciudad);
    if (!ciu) {
      ciu = { ciudad, devoluciones: 0, evitables: 0, valorPerdido: 0 };
      ciuMap.set(ciudad, ciu);
    }
    ciu.devoluciones += 1;
    ciu.valorPerdido += v;
    if (evit) ciu.evitables += 1;
  }

  const porOperadora = Array.from(opMap.values())
    .map((o) => ({ ...o, pctEvitable: o.devoluciones > 0 ? o.evitables / o.devoluciones : null }))
    .sort((a, b) => b.evitables - a.evitables || b.valorEvitable - a.valorEvitable || a.name.localeCompare(b.name));

  const porCategoria = Array.from(catMap.values())
    .sort((a, b) => b.devoluciones - a.devoluciones || b.evitables - a.evitables);

  const porCiudad = Array.from(ciuMap.values())
    .sort((a, b) => b.devoluciones - a.devoluciones || b.valorPerdido - a.valorPerdido
      || a.ciudad.localeCompare(b.ciudad));

  const total = rows.length;
  return {
    totalDevoluciones: total,
    evitables,
    pctEvitable: total > 0 ? evitables / total : null,
    valorPerdidoTotal,
    valorPerdidoEvitable,
    conConfirmador,
    sinConfirmador: total - conConfirmador,
    porReason,
    porOperadora,
    porCategoria,
    porCiudad,
  };
}

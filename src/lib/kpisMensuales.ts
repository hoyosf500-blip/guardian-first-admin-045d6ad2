/**
 * KPIs de ecommerce COD, mes a mes. Lógica PURA sobre lo que devuelve el RPC
 * `kpis_mensuales`: no hace fetch, no toca Supabase, se testea sin red.
 *
 * Existe porque el dueño de la operación dijo, literalmente, "me perdí": el panel
 * de Dropi le mostraba $8M, $9M, $12M de "Utilidad Total" mes tras mes mientras el
 * negocio perdía plata, y no había ningún lugar donde ver por qué. Ese número del
 * panel es BRUTO — no descuenta los fletes de las devoluciones, ni la pauta, ni los
 * costos fijos. Este archivo calcula la cadena completa desde ese número hasta lo
 * que de verdad queda.
 *
 * ┌─ LA CADENA (medida en la tienda CO, ene–jul 2026) ──────────────────────────┐
 * │  ganancia_bruta   $77.144.723   ← lo que el panel de Dropi promete          │
 * │      ×82,6%  (factorRealizacion — se lo comen los fletes de devolución)     │
 * │  operativo        $63.742.469   ← lo que de verdad entró a la billetera     │
 * │      −pauta −admin                                                          │
 * │  resultado       −$29.712.987   ← lo tuyo.  loQueQueda = −38,5%             │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *
 * TRES REGLAS QUE NO SE NEGOCIAN
 *
 * 1. Un porcentaje del total NUNCA es el promedio de los porcentajes mensuales.
 *    Se recalcula sobre los totales. Promediar le da el mismo peso a un mes de 279
 *    pedidos que a uno de 911 y produce una cifra que no existe.
 *
 * 2. Sin pauta cargada no hay CPA, no hay contribución y no hay ROAS — dan `null`,
 *    no cero. Es la regla 1 del spec de KPIs anti-quiebra, y hoy NetoRealCard la
 *    incumple: con pauta 0 pinta el neto en verde como si fuera ganancia. Un cero
 *    inventado en el denominador de una decisión es peor que un hueco visible.
 *
 * 3. El mes en curso se marca `preliminar`. Su cohorte no terminó de cobrar: por la
 *    curva de Dropi CO, a los 7 días llegó el 55% y a los 14 el 96%. Pintar de rojo
 *    un mes que todavía está cobrando es exactamente el error que hacía abrir el
 *    CFO en rojo los primeros 20 días de todos los meses (CfoTab.tsx:245-252).
 */

import {
  deriveDeliveryMaturity,
  isRatePreliminary,
  type DeliveryMaturity,
} from './logisticsRates';

// ─────────────────────────────────────────────────────────────────────────────
// Fila cruda del RPC
// ─────────────────────────────────────────────────────────────────────────────

export interface KpiMesCrudo {
  year_month: string;
  /** Días TRANSCURRIDOS del mes (el mes en curso no cuenta los días que faltan). */
  dias: number;
  generados: number;
  unidades: number;
  cancelados: number;
  entregados: number;
  /** Incluye a los rechazados — misma convención que logistics_summary. */
  devueltos: number;
  rechazados: number;
  en_calle: number;
  valor_no_cancelado: number;
  valor_entregado: number;
  valor_en_calle: number;
  /** `ganancia_dropshipper` por cohorte = la "Utilidad Total" del panel de Dropi. */
  ganancia_bruta: number;
  entradas: number;
  salidas: number;
  /** entradas − salidas. Lo que de verdad quedó en la billetera. */
  operativo: number;
  pauta: number;
  admin: number;
  retirado: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fila enriquecida
// ─────────────────────────────────────────────────────────────────────────────

export interface KpiMes extends KpiMesCrudo {
  // ── volumen
  /** Pedidos generados ÷ días transcurridos. El número a vigilar todos los días. */
  pedidosPorDia: number | null;
  unidadesPorPedido: number | null;

  // ── calidad de la demanda
  /** cancelados ÷ generados, en %. */
  tasaCancelacion: number | null;
  /** Sobre los pedidos que NO se cancelaron: es lo que se despachó de verdad. */
  ticketPromedio: number | null;

  // ── cumplimiento
  /** entregados ÷ (entregados + devueltos − rechazados), en %. La que manda. */
  tasaEntregaMadura: number | null;
  /** entregados ÷ (generados − cancelados), en %. Hunde el mes en curso. */
  tasaEntregaCruda: number | null;
  tasaDevolucionMadura: number | null;
  /** (entregados + devueltos) ÷ no-cancelados, en %. Cuánto del mes ya concluyó. */
  pctConcluido: number;
  /** El mes todavía se está definiendo: no sacar conclusiones ni pintar colores. */
  preliminar: boolean;

  // ── dinero por unidad
  /** ganancia_bruta ÷ entregados: lo que el panel dice que deja cada entrega. */
  gananciaBrutaPorEntrega: number | null;
  /** salidas de la cohorte ÷ pedidos que no llegaron. Lo que cuesta un fracaso. */
  costoPorDevolucion: number | null;
  /** operativo ÷ entregados: lo que deja una entrega DESPUÉS de las devoluciones. */
  netoPorEntrega: number | null;
  /** pauta ÷ entregados: lo que costó conseguir una entrega. `null` sin pauta. */
  cpaPorEntrega: number | null;
  /** netoPorEntrega − cpaPorEntrega. **Si esto es negativo, vender más hunde más.** */
  contribucionPorEntrega: number | null;
  /** Lo mismo repartido entre TODOS los pedidos generados, entreguen o no. */
  contribucionPorGenerado: number | null;

  // ── resultado
  /** pauta + admin. */
  invertido: number;
  /** operativo − invertido. */
  resultado: number;
  /** operativo ÷ pauta. El retorno COBRADO, no el que reporta la plataforma. */
  roasReal: number | null;
  /**
   * Qué % de los pedidos generados tendría que entregar para no perder, si cada
   * entrega dejara lo que dice el panel. **Por encima de 100 no hay operación que
   * salve el mes**: el problema es el costo de adquisición, no la logística.
   */
  tasaEquilibrio: number | null;
  /** operativo ÷ ganancia_bruta, en %. De lo que Dropi promete, cuánto llega. */
  factorRealizacion: number | null;
  /** resultado ÷ ganancia_bruta, en %. De lo que Dropi promete, cuánto te queda. */
  loQueQueda: number | null;

  // ── caja
  /** retirado ÷ operativo, en %. Por encima de 100 el negocio se está vaciando. */
  pctRetirado: number | null;
  /** No hay pauta cargada: los KPI que dependen de ella son `null`, no cero. */
  sinPauta: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/** División segura: `null` cuando el denominador no sirve. Nunca Infinity ni NaN. */
function div(num: number, den: number): number | null {
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  const r = num / den;
  return Number.isFinite(r) ? r : null;
}

/** Porcentaje con un decimal. `null` cuando no hay denominador. */
function pct(num: number, den: number): number | null {
  const r = div(num, den);
  return r == null ? null : Math.round(r * 1000) / 10;
}

/** Resta que se propaga: si falta un operando, el resultado no existe. */
function resta(a: number | null, b: number | null): number | null {
  return a == null || b == null ? null : a - b;
}

function redondear(v: number | null): number | null {
  return v == null ? null : Math.round(v);
}

// ─────────────────────────────────────────────────────────────────────────────
// Cálculo de un mes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Enriquece una fila cruda. Exportada aparte de `construirKpis` porque los totales
 * del período se calculan con la MISMA función sobre las columnas sumadas — así es
 * imposible que la fila de total use una fórmula distinta a la de los meses.
 */
export function calcularKpisMes(f: KpiMesCrudo): KpiMes {
  const generados = n(f.generados);
  const cancelados = n(f.cancelados);
  const entregados = n(f.entregados);
  const devueltos = n(f.devueltos);
  const rechazados = n(f.rechazados);
  const unidades = n(f.unidades);
  const dias = n(f.dias);
  const gananciaBruta = n(f.ganancia_bruta);
  const salidas = n(f.salidas);
  const operativo = n(f.operativo);
  const pauta = n(f.pauta);
  const admin = n(f.admin);
  const retirado = n(f.retirado);

  /** Los cancelados nunca entraron a logística: no pueden estar en el denominador
   *  de una tasa de entrega ni en un ticket promedio. */
  const despachables = Math.max(0, generados - cancelados);

  const madurez: DeliveryMaturity = deriveDeliveryMaturity(
    entregados,
    devueltos,
    despachables,
    rechazados,
  );

  const invertido = pauta + admin;
  const resultado = operativo - invertido;
  const sinPauta = pauta <= 0;

  const gananciaBrutaPorEntrega = div(gananciaBruta, entregados);
  const netoPorEntrega = div(operativo, entregados);
  // Regla 2: sin pauta cargada el CPA no es cero, es desconocido.
  const cpaPorEntrega = sinPauta ? null : div(pauta, entregados);
  const contribucionPorEntrega = resta(netoPorEntrega, cpaPorEntrega);

  return {
    ...f,

    pedidosPorDia: div(generados, dias),
    unidadesPorPedido: div(unidades, generados),

    tasaCancelacion: pct(cancelados, generados),
    ticketPromedio: div(n(f.valor_no_cancelado), despachables),

    tasaEntregaMadura: madurez.tasaEntregaMadura,
    tasaEntregaCruda: pct(entregados, despachables),
    tasaDevolucionMadura: madurez.tasaDevolucionMadura,
    pctConcluido: madurez.pctConcluido,
    preliminar: isRatePreliminary(madurez),

    gananciaBrutaPorEntrega,
    costoPorDevolucion: div(salidas, devueltos),
    netoPorEntrega,
    cpaPorEntrega,
    contribucionPorEntrega,
    contribucionPorGenerado:
      contribucionPorEntrega == null ? null : div(entregados * contribucionPorEntrega, generados),

    invertido,
    resultado,
    roasReal: sinPauta ? null : div(operativo, pauta),
    // Cuántas entregas hacen falta para pagar pauta + fijos, expresado como % de
    // los pedidos generados. Usa la ganancia BRUTA por entrega (la del panel), así
    // que es una COTA INFERIOR: la exigencia real es mayor porque cada pedido que
    // no llega además cobra su flete. Si esta cota ya pasa de 100, no hay discusión.
    tasaEquilibrio:
      invertido > 0 && gananciaBrutaPorEntrega != null && gananciaBrutaPorEntrega > 0
        ? pct(invertido / gananciaBrutaPorEntrega, generados)
        : null,
    factorRealizacion: gananciaBruta > 0 ? pct(operativo, gananciaBruta) : null,
    loQueQueda: gananciaBruta > 0 ? pct(resultado, gananciaBruta) : null,

    pctRetirado: operativo > 0 ? pct(retirado, operativo) : null,
    sinPauta,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Serie completa
// ─────────────────────────────────────────────────────────────────────────────

/** Las tasas que tiene sentido mirar como rango (mínimo–máximo) del período. */
export const TASAS_CON_RANGO = [
  'tasaEntregaMadura',
  'tasaCancelacion',
  'ticketPromedio',
  'unidadesPorPedido',
  'pedidosPorDia',
  'netoPorEntrega',
  'cpaPorEntrega',
  'contribucionPorEntrega',
  'tasaEquilibrio',
  'factorRealizacion',
  'loQueQueda',
] as const;

export type TasaConRango = (typeof TASAS_CON_RANGO)[number];

export interface RangoTasa {
  min: number;
  max: number;
  /** Mes donde ocurrió el mínimo / el máximo — sirve para señalar el culpable. */
  mesMin: string;
  mesMax: string;
}

export interface KpisPeriodo {
  meses: KpiMes[];
  /** Fila de total: columnas sumadas y tasas RECALCULADAS sobre esas sumas. */
  totales: KpiMes;
  /**
   * Mínimo y máximo de cada tasa en el período. Es la respuesta a "la tasa de
   * entrega nunca es igual, las cancelaciones tampoco": un promedio esconde
   * justamente la variación que se quiere ver.
   *
   * Los meses `preliminar` quedan FUERA: un mes a medio cobrar siempre marcaría el
   * mínimo y arruinaría el rango.
   */
  rangos: Partial<Record<TasaConRango, RangoTasa>>;
}

export function construirKpis(filas: KpiMesCrudo[] | null | undefined): KpisPeriodo {
  const meses = (filas || []).map(calcularKpisMes);

  const suma = (sel: (m: KpiMesCrudo) => number) => meses.reduce((a, m) => a + n(sel(m)), 0);

  // Regla 1: el total se arma sumando las columnas CRUDAS y volviendo a pasar por
  // `calcularKpisMes`. Ninguna tasa del total se promedia.
  const totales = calcularKpisMes({
    year_month: 'total',
    dias: suma((m) => m.dias),
    generados: suma((m) => m.generados),
    unidades: suma((m) => m.unidades),
    cancelados: suma((m) => m.cancelados),
    entregados: suma((m) => m.entregados),
    devueltos: suma((m) => m.devueltos),
    rechazados: suma((m) => m.rechazados),
    en_calle: suma((m) => m.en_calle),
    valor_no_cancelado: suma((m) => m.valor_no_cancelado),
    valor_entregado: suma((m) => m.valor_entregado),
    valor_en_calle: suma((m) => m.valor_en_calle),
    ganancia_bruta: suma((m) => m.ganancia_bruta),
    entradas: suma((m) => m.entradas),
    salidas: suma((m) => m.salidas),
    operativo: suma((m) => m.operativo),
    pauta: suma((m) => m.pauta),
    admin: suma((m) => m.admin),
    retirado: suma((m) => m.retirado),
  });

  const rangos: Partial<Record<TasaConRango, RangoTasa>> = {};
  const firmes = meses.filter((m) => !m.preliminar);
  for (const k of TASAS_CON_RANGO) {
    const puntos = firmes
      .map((m) => ({ mes: m.year_month, v: m[k] as number | null }))
      .filter((p): p is { mes: string; v: number } => p.v != null && Number.isFinite(p.v));
    if (!puntos.length) continue;
    let lo = puntos[0];
    let hi = puntos[0];
    for (const p of puntos) {
      if (p.v < lo.v) lo = p;
      if (p.v > hi.v) hi = p;
    }
    rangos[k] = { min: lo.v, max: hi.v, mesMin: lo.mes, mesMax: hi.mes };
  }

  return { meses, totales, rangos };
}

// ─────────────────────────────────────────────────────────────────────────────
// Lecturas en castellano
// ─────────────────────────────────────────────────────────────────────────────

export type Severidad = 'ok' | 'aviso' | 'grave' | 'neutro';

export interface Veredicto {
  severidad: Severidad;
  texto: string;
}

/**
 * Traduce un mes a la frase que hay que leer primero. El orden importa: lo que
 * mata primero se dice primero.
 *
 * Un mes preliminar SIEMPRE devuelve 'neutro' — no se juzga un mes que todavía
 * está cobrando.
 */
export function veredictoDelMes(m: KpiMes): Veredicto {
  if (m.preliminar) {
    return {
      severidad: 'neutro',
      texto: `Todavía se está definiendo: concluyó el ${m.pctConcluido}% de los pedidos.`,
    };
  }
  if (m.sinPauta) {
    return {
      severidad: 'neutro',
      texto: 'Sin la pauta cargada no se puede decir si el mes ganó o perdió.',
    };
  }
  if (m.contribucionPorEntrega != null && m.contribucionPorEntrega < 0) {
    return {
      severidad: 'grave',
      texto: `Cada entrega dejó ${redondear(m.contribucionPorEntrega)} — vender más agrandaba la pérdida.`,
    };
  }
  if (m.tasaEquilibrio != null && m.tasaEquilibrio > 100) {
    return {
      severidad: 'grave',
      texto: `Habría hecho falta entregar el ${m.tasaEquilibrio}% para no perder: imposible. No fue la operación, fue el costo de traer el pedido.`,
    };
  }
  if (m.resultado < 0) {
    return { severidad: 'aviso', texto: 'El mes cerró en pérdida.' };
  }
  if (m.pctRetirado != null && m.pctRetirado > 100) {
    return {
      severidad: 'aviso',
      texto: `Se retiró el ${m.pctRetirado}% de lo que generó la operación: el negocio se está vaciando.`,
    };
  }
  return {
    severidad: 'ok',
    texto:
      m.loQueQueda == null
        ? 'El mes cerró en positivo.'
        : `De cada $100 que Dropi dijo que ganaste, te quedaron $${m.loQueQueda.toFixed(0)}.`,
  };
}

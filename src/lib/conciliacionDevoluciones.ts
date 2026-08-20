// ¿Dropi me cobró una devolución de un pedido que Guardian no ve como devuelto?
//
// Guardian tenía dos fuentes sobre devoluciones que nunca se cruzaban: la
// billetera (lo que Dropi COBRA) y `orders` (lo que Guardian VE). Mientras
// nadie las comparara, una devolución podía existir, pagarse, y no aparecer
// nunca en el CRM. Medido el 20-ago-2026 sobre 3 meses: Colombia cuadró 77 de
// 77, y una tienda de Ecuador tenía 83 de 318 cobros sin respaldo.
//
// Las tres situaciones NO son el mismo problema y por eso se cuentan separadas:
// tienen causas y dueños distintos.

import type { BucketKey } from './estadoBuckets';

export type SituacionCobro =
  /** El pedido está y figura devuelto. Nada que hacer. */
  | 'ok'
  /** El movimiento no trae con qué pedido cruzarlo: NO se puede verificar.
   *  No es lo mismo que "falta" — es que no sabemos. */
  | 'sin_referencia'
  /** Trae referencia y el pedido NO existe en el CRM: el sync nunca lo trajo. */
  | 'no_esta'
  /** El pedido existe pero su estado NO es devolución. El más caro: figura vivo
   *  o entregado e INFLA la tasa de entrega mientras ya se pagó su devolución. */
  | 'no_marcado';

export interface CobroDevolucionRow {
  movimiento_id?: number | string | null;
  fecha_cobro?: string | null;
  monto?: number | string | null;
  external_id?: string | null;
  order_id?: string | null;
  estado_guardian?: string | null;
  /** Bucket calculado por `_estado_bucket` en SQL. null = el pedido no existe. */
  bucket_guardian?: BucketKey | string | null;
  producto?: string | null;
  ciudad?: string | null;
  fecha_pedido?: string | null;
  total_periodo?: number | string | null;
  plata_periodo?: number | string | null;
}

export interface GrupoConciliacion {
  cobros: number;
  plata: number;
}

export interface ConciliacionDevoluciones {
  /** Cobros efectivamente analizados (puede ser < totalPeriodo si truncó). */
  analizados: number;
  /** Conteo REAL del período, previo al LIMIT del server. */
  totalPeriodo: number;
  /** Plata REAL del período, previa al LIMIT. */
  plataPeriodo: number;
  /** true si el server truncó: la UI DEBE decirlo. */
  parcial: boolean;

  ok: GrupoConciliacion;
  sinReferencia: GrupoConciliacion;
  noEsta: GrupoConciliacion;
  noMarcado: GrupoConciliacion;

  /** noEsta + noMarcado: cobros reales sin respaldo en el CRM. */
  sinRespaldo: GrupoConciliacion;

  /** Cobros que SÍ se pudieron verificar (todos menos los sin referencia). */
  verificables: number;
  /** ok ÷ verificables, 0-100. null si no hubo ninguno que verificar. */
  pctConRespaldoSobreVerificables: number | null;
  /** verificables ÷ analizados, 0-100. null si no se analizó nada. */
  pctVerificableSobreAnalizados: number | null;

  /** external_id a repescar desde Dropi, sin repetidos y con la plata primero.
   *  Sirve tanto para traer el pedido que falta como para refrescar el que
   *  quedó con estado viejo: en ambos casos la cura es preguntarle a Dropi. */
  externalIdsAReparar: string[];

  /** Las peores filas para mostrar en la tabla (ya vienen ordenadas del server). */
  problemas: Array<CobroDevolucionRow & { situacion: SituacionCobro; montoNum: number }>;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Regla de una sola fila. El orden de los checks importa: "no se puede
 *  verificar" se decide ANTES que "falta", porque sin referencia no hay
 *  derecho a afirmar que falte nada. */
export function clasificarCobro(r: CobroDevolucionRow): SituacionCobro {
  const ext = String(r.external_id ?? '').trim();
  if (!ext) return 'sin_referencia';
  if (!r.order_id) return 'no_esta';
  return String(r.bucket_guardian ?? '') === 'devuelto' ? 'ok' : 'no_marcado';
}

const VACIO: GrupoConciliacion = { cobros: 0, plata: 0 };

export function conciliarDevoluciones(
  rows: CobroDevolucionRow[] | null | undefined,
): ConciliacionDevoluciones {
  const list = rows || [];
  const analizados = list.length;

  const g: Record<SituacionCobro, GrupoConciliacion> = {
    ok: { ...VACIO },
    sin_referencia: { ...VACIO },
    no_esta: { ...VACIO },
    no_marcado: { ...VACIO },
  };

  const problemas: ConciliacionDevoluciones['problemas'] = [];
  const aReparar: string[] = [];
  const vistos = new Set<string>();

  for (const r of list) {
    const situacion = clasificarCobro(r);
    const montoNum = Math.abs(num(r.monto));
    g[situacion].cobros += 1;
    g[situacion].plata += montoNum;
    if (situacion !== 'ok') {
      problemas.push({ ...r, situacion, montoNum });
      // Dedup: un mismo pedido puede tener DOS cobros (flete + cargo extra) y
      // repescarlo dos veces sería gastar dos llamadas a Dropi para nada.
      const ext = String(r.external_id ?? '').trim();
      if (ext && situacion !== 'sin_referencia' && !vistos.has(ext)) {
        vistos.add(ext);
        aReparar.push(ext);
      }
    }
  }

  const verificables = analizados - g.sin_referencia.cobros;
  // Los totales del server mandan: si por algo no vinieran, se cae a lo
  // analizado — pero NUNCA al revés (inventar un total mayor sería peor).
  const totalPeriodo = Math.max(num(list[0]?.total_periodo), analizados);
  const plataPeriodo = Math.max(num(list[0]?.plata_periodo), 0);

  return {
    analizados,
    totalPeriodo,
    plataPeriodo,
    parcial: totalPeriodo > analizados,
    ok: g.ok,
    sinReferencia: g.sin_referencia,
    noEsta: g.no_esta,
    noMarcado: g.no_marcado,
    sinRespaldo: {
      cobros: g.no_esta.cobros + g.no_marcado.cobros,
      plata: g.no_esta.plata + g.no_marcado.plata,
    },
    verificables,
    // Redondeo hacia ABAJO en la tasa buena: "100% con respaldo" no puede
    // aparecer si hay aunque sea un cobro sin respaldo. Misma regla que
    // logisticsRates tras el bug del 20-ago (round mostraba 100% con
    // devoluciones reales).
    pctConRespaldoSobreVerificables:
      verificables > 0 ? Math.floor((g.ok.cobros / verificables) * 100) : null,
    pctVerificableSobreAnalizados:
      analizados > 0 ? Math.floor((verificables / analizados) * 100) : null,
    externalIdsAReparar: aReparar,
    problemas,
  };
}

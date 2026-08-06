/**
 * Balance mes a mes + cruce de rendiciones. Lógica PURA: recibe lo que ya
 * devolvieron los RPCs y calcula. No hace fetch, no toca Supabase, se testea sin red.
 *
 * Reemplaza el Excel que había que armar a mano cada vez que se quería saber
 * cómo iba la operación y si la plata que salió de la billetera estaba explicada.
 *
 * DOS PREGUNTAS DISTINTAS, NO MEZCLARLAS:
 *   1. ¿Estamos ganando?  → utilidad = operativo − pauta − admin, por mes.
 *   2. ¿Está toda la plata explicada? → retirado vs rendido, con sus comprobantes.
 * La primera mide el negocio; la segunda mide la caja. Un mes puede ser bueno y
 * tener plata sin explicar, y al revés.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. Balance mensual
// ─────────────────────────────────────────────────────────────────────────────

/** Fila cruda del RPC `balance_mensual`. */
export interface MesCrudo {
  year_month: string;
  operativo: number;
  pauta: number;
  admin: number;
  retirado: number;
  rendido: number;
  pedidos: number;
  entregados: number;
  devueltos: number;
}

export interface MesBalance extends MesCrudo {
  /** pauta + admin — lo que se puso de bolsillo para que el mes ocurriera. */
  invertido: number;
  /** operativo − invertido. Lo que quedó. */
  utilidad: number;
  /** utilidad ÷ invertido, en %. `null` si no se invirtió nada (no hay ROI de $0). */
  roi: number | null;
  /** entregados ÷ (entregados + devueltos), en %. `null` sin pedidos concluidos.
   *  Es la tasa MADURA, la misma de logisticsRates — no entregados ÷ pedidos. */
  tasaEntrega: number | null;
  /** retirado − rendido. Positivo = plata que salió y nadie justificó. */
  sinExplicar: number;
}

export interface BalanceTotales {
  operativo: number;
  pauta: number;
  admin: number;
  invertido: number;
  utilidad: number;
  roi: number | null;
  retirado: number;
  rendido: number;
  sinExplicar: number;
  pedidos: number;
  entregados: number;
  devueltos: number;
  tasaEntrega: number | null;
}

function pct(num: number, den: number): number | null {
  if (!den) return null;
  return Math.round((num / den) * 1000) / 10; // 1 decimal
}

/** Enriquece cada mes con utilidad, ROI y tasa; y calcula los totales del período. */
export function construirBalance(filas: MesCrudo[] | null | undefined): {
  meses: MesBalance[];
  totales: BalanceTotales;
} {
  const meses: MesBalance[] = (filas || []).map((f) => {
    const invertido = (f.pauta || 0) + (f.admin || 0);
    const utilidad = (f.operativo || 0) - invertido;
    const concluidos = (f.entregados || 0) + (f.devueltos || 0);
    return {
      ...f,
      invertido,
      utilidad,
      roi: pct(utilidad, invertido),
      tasaEntrega: pct(f.entregados || 0, concluidos),
      sinExplicar: (f.retirado || 0) - (f.rendido || 0),
    };
  });

  const suma = (sel: (m: MesBalance) => number) => meses.reduce((a, m) => a + sel(m), 0);
  const operativo = suma((m) => m.operativo);
  const pauta = suma((m) => m.pauta);
  const admin = suma((m) => m.admin);
  const invertido = pauta + admin;
  const utilidad = operativo - invertido;
  const entregados = suma((m) => m.entregados);
  const devueltos = suma((m) => m.devueltos);
  const retirado = suma((m) => m.retirado);
  const rendido = suma((m) => m.rendido);

  return {
    meses,
    totales: {
      operativo, pauta, admin, invertido, utilidad,
      // El ROI del total NO es el promedio de los ROI mensuales: se recalcula
      // sobre los totales. Promediar porcentajes le da el mismo peso a un mes de
      // $200 que a uno de $3.600 y da una cifra que no existe.
      roi: pct(utilidad, invertido),
      retirado, rendido,
      sinExplicar: retirado - rendido,
      pedidos: suma((m) => m.pedidos),
      entregados, devueltos,
      tasaEntrega: pct(entregados, entregados + devueltos),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Cruce de rendiciones y detector de cobros repetidos
// ─────────────────────────────────────────────────────────────────────────────

export interface RendicionItem {
  id: string;
  fecha: string | null;
  concepto: string;
  monto: number;
  plataforma: string | null;
}

export interface Rendicion {
  id: string;
  fecha: string;
  responsable: string | null;
  monto_retirado: number;
  notas: string | null;
  items: RendicionItem[];
}

export interface RendicionCruzada extends Rendicion {
  /** Suma de los comprobantes. */
  totalRendido: number;
  /** monto_retirado − totalRendido. Positivo = falta justificar. */
  diferencia: number;
  /** Ítems de ESTA rendición que ya aparecían en otra anterior. */
  duplicados: ItemDuplicado[];
}

export interface ItemDuplicado {
  item: RendicionItem;
  /** Fecha de la rendición donde ya se había cobrado. */
  yaCobradoEn: string;
  /** Id de esa rendición, para poder abrirla. */
  yaCobradoEnId: string;
}

/**
 * Normaliza un concepto para comparar: mayúsculas, sin acentos, sin espacios
 * repetidos. "UGLY 06/07" y "ugly  06/07" son el mismo cargo.
 *
 * NO se normaliza más agresivo (quitar números, por ejemplo) a propósito: dos
 * cargos legítimos del mismo proveedor en fechas distintas se distinguen
 * justamente por el número, y fusionarlos daría falsos duplicados. Es preferible
 * que un duplicado escrito distinto se escape a acusar de repetido a un cargo real.
 */
export function normalizarConcepto(s: string): string {
  return (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Llave de identidad de un cargo: mismo concepto Y mismo monto. */
function llaveItem(it: RendicionItem): string {
  return `${normalizarConcepto(it.concepto)}|${Number(it.monto).toFixed(2)}`;
}

/**
 * Cruza las rendiciones y marca los cobros repetidos.
 *
 * El caso real que lo motivó: un cargo de "UGLY 06/07" por $500 se pagó en la
 * rendición del 19-jul y volvió a aparecer en la del 23-jul. Nadie lo vio hasta
 * que se pusieron las dos listas lado a lado a mano.
 *
 * Un ítem se marca duplicado si su (concepto, monto) ya apareció en una rendición
 * ANTERIOR. La primera aparición nunca se marca: es el cobro legítimo. Se ordena
 * por fecha para que "anterior" signifique lo que uno espera, sin importar en qué
 * orden se hayan cargado.
 */
export function cruzarRendiciones(rendiciones: Rendicion[] | null | undefined): {
  cruzadas: RendicionCruzada[];
  totalRetirado: number;
  totalRendido: number;
  totalDuplicado: number;
  cantidadDuplicados: number;
} {
  const orden = [...(rendiciones || [])].sort((a, b) => a.fecha.localeCompare(b.fecha));
  const visto = new Map<string, { fecha: string; id: string }>();

  const cruzadas: RendicionCruzada[] = orden.map((r) => {
    const duplicados: ItemDuplicado[] = [];
    for (const it of r.items || []) {
      const k = llaveItem(it);
      const previo = visto.get(k);
      if (previo) {
        duplicados.push({ item: it, yaCobradoEn: previo.fecha, yaCobradoEnId: previo.id });
      } else {
        visto.set(k, { fecha: r.fecha, id: r.id });
      }
    }
    const totalRendido = (r.items || []).reduce((a, i) => a + (Number(i.monto) || 0), 0);
    return {
      ...r,
      totalRendido,
      diferencia: (Number(r.monto_retirado) || 0) - totalRendido,
      duplicados,
    };
  });

  const totalDuplicado = cruzadas.reduce(
    (a, r) => a + r.duplicados.reduce((b, d) => b + (Number(d.item.monto) || 0), 0), 0,
  );

  return {
    // Se devuelve de la más nueva a la más vieja: es el orden en que se mira.
    cruzadas: cruzadas.reverse(),
    totalRetirado: cruzadas.reduce((a, r) => a + (Number(r.monto_retirado) || 0), 0),
    totalRendido: cruzadas.reduce((a, r) => a + r.totalRendido, 0),
    totalDuplicado,
    cantidadDuplicados: cruzadas.reduce((a, r) => a + r.duplicados.length, 0),
  };
}

/**
 * Meses del rango, de 'YYYY-MM' a 'YYYY-MM'. Devuelve [] si el rango está al
 * revés — un rango inválido no debe inventar meses.
 */
export function mesesEntre(desde: string, hasta: string): string[] {
  if (!/^\d{4}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}$/.test(hasta)) return [];
  if (desde > hasta) return [];
  const out: string[] = [];
  let [y, m] = desde.split('-').map(Number);
  const [yh, mh] = hasta.split('-').map(Number);
  while (y < yh || (y === yh && m <= mh)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

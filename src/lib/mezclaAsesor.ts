// mezclaAsesor — "¿qué TIPO de pedidos gestionó cada asesor?" (anti-descreme).
//
// Pedido del dueño (25-ago-2026): saber si un asesor "descrema" — agarra solo
// los fáciles (el cliente ya apretó "confirmar") y deja los difíciles (los que
// hay que llamar y convencer). La cola ya viene ordenada difícil-primero, así
// que un asesor diligente ataca los difíciles; uno que descrema, no.
//
// Cruza QUIÉN gestionó (order_results.operator_id) con la ETIQUETA del pedido
// (orders.chat_riesgo). Puro y testeable: la query vive en el hook.
//
// ⚠️ El % de difíciles NO es una condena por sí solo: si la cola de ese día era
// casi toda "ya confirmó", el asesor no tiene difíciles que atacar. Es una
// señal para MIRAR, cruzándola con cómo venía la cola (ResumenRiesgoStrip).

import type { NivelRiesgo } from './riesgoChat';

export interface MezclaAsesor {
  mudo: number;
  frio: number;
  tibio: number;
  sin_dato: number;
  confirmado: number;
  /** Gestiones sobre pedidos sin señal de chat todavía. */
  sinSenal: number;
  total: number;
  /** Requieren trabajo real: mudo + frio + tibio. */
  dificiles: number;
  /** Ya venían resueltos por el cliente: confirmado. */
  faciles: number;
}

export interface FilaMezcla {
  operatorId: string;
  riesgo: NivelRiesgo | null;
}

const vacia = (): MezclaAsesor => ({
  mudo: 0, frio: 0, tibio: 0, sin_dato: 0, confirmado: 0, sinSenal: 0, total: 0, dificiles: 0, faciles: 0,
});

/** Agrupa las gestiones por asesor y cuenta la mezcla de etiquetas. */
export function agruparMezcla(rows: FilaMezcla[]): Map<string, MezclaAsesor> {
  const m = new Map<string, MezclaAsesor>();
  for (const row of rows) {
    if (!row.operatorId) continue;
    let a = m.get(row.operatorId);
    if (!a) { a = vacia(); m.set(row.operatorId, a); }
    a.total += 1;
    if (row.riesgo) a[row.riesgo] += 1;
    else a.sinSenal += 1;
    if (row.riesgo === 'mudo' || row.riesgo === 'frio' || row.riesgo === 'tibio') a.dificiles += 1;
    else if (row.riesgo === 'confirmado') a.faciles += 1;
  }
  return m;
}

/**
 * % de gestiones que fueron DIFÍCILES, sobre las clasificables (difícil+fácil).
 * Deja fuera "sin leer" y "sin señal" (no se sabe). null si no hay ninguna
 * clasificable — ahí no se puede opinar. Alto = ataca lo difícil (bien); bajo =
 * descrema (a revisar contra cómo venía la cola).
 */
export function porcentajeDificiles(a: MezclaAsesor): number | null {
  const base = a.dificiles + a.faciles;
  if (base === 0) return null;
  return Math.round((a.dificiles / base) * 100);
}

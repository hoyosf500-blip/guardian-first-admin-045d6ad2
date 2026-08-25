// devolucionSeguimiento — atribución de las DEVOLUCIONES al lado de Seguimiento.
//
// La causa raíz de /novedades ya atribuye la devolución a quien CONFIRMÓ (quien
// aceptó una dirección mala = la causa). Esto contesta la OTRA pregunta del
// dueño: de los pedidos que se devolvieron, ¿quién les hizo seguimiento —y
// cuántos no tocó nadie? El seguimiento no CAUSA la devolución, la RESCATA; por
// eso acá se habla de "gestionó / no gestionó", nunca de culpa.
//
// Puro y testeable. El cruce es por TELÉFONO (los touchpoints no tienen order_id):
// se normaliza a los últimos 9 dígitos en ambos lados —igual que shopify-reconcile—
// porque el mismo número puede venir con/sin prefijo. Un teléfono con dos pedidos
// devueltos cuenta las dos veces (atribución por pedido); es la ambigüedad conocida
// del match por teléfono y va advertida en la pantalla.

export interface DevueltoLite {
  phone: string | null;
  valor: number | null;
}

export interface SegTouchLite {
  phone: string | null;
  operator_id: string;
}

export interface GestorSegRow {
  operatorId: string;
  devueltos: number;
  valor: number;
}

export interface DevolucionSeguimientoResumen {
  /** Total de pedidos devueltos del período. */
  total: number;
  valorTotal: number;
  /** Devueltos que NINGUNA operadora tocó en Seguimiento (hueco de cobertura). */
  sinGestionSeg: number;
  valorSinGestion: number;
  /** Ranking de operadoras que gestionaron devueltos, desc por cantidad. */
  porGestor: GestorSegRow[];
}

/** Últimos 9 dígitos del teléfono. '' si no hay dígitos (no matchea con nada). */
export function normalizarTel(phone: string | null | undefined): string {
  const soloDigitos = String(phone ?? '').replace(/\D/g, '');
  return soloDigitos.length <= 9 ? soloDigitos : soloDigitos.slice(-9);
}

export function resumirDevolucionSeguimiento(
  devueltos: DevueltoLite[],
  segTouch: SegTouchLite[],
  adminIds: string[] = [],
): DevolucionSeguimientoResumen {
  const adminSet = new Set(adminIds);

  // teléfono normalizado → set de operadoras (NO admins) que lo gestionaron en SEG.
  const opsPorTel = new Map<string, Set<string>>();
  for (const tp of segTouch) {
    if (!tp.operator_id || adminSet.has(tp.operator_id)) continue;
    const key = normalizarTel(tp.phone);
    if (!key) continue;
    let set = opsPorTel.get(key);
    if (!set) { set = new Set(); opsPorTel.set(key, set); }
    set.add(tp.operator_id);
  }

  const acc = new Map<string, GestorSegRow>();
  let total = 0;
  let valorTotal = 0;
  let sinGestionSeg = 0;
  let valorSinGestion = 0;

  for (const d of devueltos) {
    total += 1;
    const valor = Number.isFinite(d.valor as number) ? (d.valor as number) : 0;
    valorTotal += valor;

    const key = normalizarTel(d.phone);
    const ops = key ? opsPorTel.get(key) : undefined;
    if (!ops || ops.size === 0) {
      sinGestionSeg += 1;
      valorSinGestion += valor;
      continue;
    }
    // Atribución COMPARTIDA: si dos operadoras lo tocaron, cuenta para ambas.
    for (const opId of ops) {
      let row = acc.get(opId);
      if (!row) { row = { operatorId: opId, devueltos: 0, valor: 0 }; acc.set(opId, row); }
      row.devueltos += 1;
      row.valor += valor;
    }
  }

  const porGestor = Array.from(acc.values()).sort(
    (a, b) => b.devueltos - a.devueltos || b.valor - a.valor,
  );

  return { total, valorTotal, sinGestionSeg, valorSinGestion, porGestor };
}

// Tasa de cancelación POR PRODUCTO: la lógica pura.
//
// ── Por qué existe ─────────────────────────────────────────────────────────
// La tarjeta "Por producto" mostraba CUÁNTAS cancelaciones tenía cada producto,
// no la TASA. Con ese orden el más vendido encabeza siempre y la pantalla no
// puede contestar "¿cuál me está cancelando más?". Agosto-2026, Ecuador:
//
//   Gafas Bluetooth ....... 109 cancelaciones (51% del total)  → tasa 28,3%
//   Freidora con canasta ... 35 cancelaciones (16%)            → tasa 39,8%  ← la peor
//   Aurelis / Drenaje ...... 20 cancelaciones ( 9%)            → tasa 35,1%
//   Ejercitador pélvico .... 25 cancelaciones (12%)            → tasa 19,4%
//
// ── El hallazgo que decide el diseño ───────────────────────────────────────
// El MISMO producto, publicado dos veces, cancela distinto:
//
//   Freidora "con canasta winner"  95 pedidos → 39,8%
//   "FREIDORA IMP WINNER"          18 pedidos → 11,8%
//   Aurelis | Drenaje Linfático    58 pedidos → 35,1%
//   DRENAJE LINFATICO (59 ML)      84 pedidos → 26,6%
//
// Si el problema fuera el producto, las dos publicaciones cancelarían igual.
// **Es el anuncio.** Por eso las publicaciones NUNCA se suman: se detectan como
// hermanas y se muestran juntas para que la diferencia salte a la vista.

/** Fila cruda de la RPC `cancelaciones_por_producto`. */
export interface ProductoCrudo {
  producto: string;
  generados: number;
  cancelados: number;
  entregados: number;
  devueltos: number;
  pendientes: number;
  enCurso: number;
  valorGenerado: number;
  valorCancelado: number;
}

export interface FilaProducto extends ProductoCrudo {
  /** Pedidos que ya no pueden cancelarse = generados − pendientes. */
  resueltos: number;
  /** cancelados ÷ resueltos × 100. `null` si no hay resueltos: sin desenlaces
   *  no hay tasa, y un 0% sería una mentira tranquilizadora. */
  tasa: number | null;
  /** Puntos por encima (+) o por debajo (−) del promedio de la tienda.
   *  `null` cuando falta cualquiera de las dos tasas. */
  delta: number | null;
  /** ¿Tiene muestra suficiente para rankear? Ver `MIN_RESUELTOS_PRODUCTO`. */
  rankeable: boolean;
  /** Clave de agrupación de publicaciones hermanas. */
  claveHermanas: string;
}

/**
 * Mínimo de pedidos RESUELTOS para que un producto entre al ranking.
 *
 * Espeja `MIN_RESUELTOS_RANK` de `carrierRecommendations.ts:32`, que nació del
 * mismo bug: con `resueltos > 0` bastaba UN pedido concluido para marcar 100% y
 * encabezar la lista con ruido estadístico. Los que no llegan **no se esconden**
 * — se listan aparte y sin porcentaje.
 */
export const MIN_RESUELTOS_PRODUCTO = 8;

/**
 * Diferencia en puntos a partir de la cual dos publicaciones del mismo producto
 * se marcan como discrepantes.
 *
 * 12 puntos no es un número redondo elegido al azar: es menos que la brecha
 * medida en las dos Freidoras (28 puntos) y más que el ruido entre los dos
 * Drenajes (8,5 puntos), que probablemente sean la misma oferta. Marca lo que
 * hay que ir a mirar sin llenar la pantalla de avisos.
 */
export const UMBRAL_HERMANAS_PUNTOS = 12;

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Palabras que distinguen a un LISTADO de otro pero no al producto. Sacarlas es
 * lo que hace que "Freidora con canasta winner" y "FREIDORA IMP WINNER" caigan
 * en la misma clave.
 */
const RELLENO = new Set([
  'imp', 'pr', 'winner', 'ml', 'gr', 'kg', 'digital', 'pantalla', 'con', 'de', 'del',
  'la', 'el', 'los', 'las', 'y', 'para', 'x', 'un', 'una', 'unidad', 'unidades', 'pack',
]);

/**
 * Clave para detectar que dos filas son el MISMO producto publicado distinto.
 *
 * La clave es **la palabra más larga del nombre**, después de sacar acentos, la
 * marca, los paréntesis y el relleno. Suena tosco y lo es a propósito: comparar
 * el conjunto completo de palabras NO funciona, porque las publicaciones del
 * mismo producto casi nunca tienen las mismas ("Freidora con canasta winner"
 * contra "FREIDORA IMP WINNER"). La palabra más larga suele ser el sustantivo
 * que nombra al producto —freidora, linfatico, ejercitador, bluetooh— y es lo
 * único estable entre dos listados.
 *
 * Su único trabajo es acercar candidatos para mostrarlos juntos: **nunca
 * fusiona nada ni suma cifras**. Un falso positivo pone dos filas contiguas con
 * un aviso; un falso negativo deja todo como está hoy. Ninguno de los dos
 * rompe un número.
 *
 * La marca se saca tomando el ÚLTIMO segmento del `|`, no el primero:
 * en "Aurelis | Drenaje Linfático" la marca va adelante y el producto atrás.
 */
export function claveProducto(nombre: string): string {
  const segmentos = (nombre || '').split('|');
  const palabras = segmentos[segmentos.length - 1]
    .normalize('NFD').replace(/[̀-ͯ]/g, '')    // fuera acentos
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')                          // fuera "(59 ML)"
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !RELLENO.has(w) && !/^\d+$/.test(w));
  if (!palabras.length) return '';
  // La más larga gana; a igual largo, la alfabéticamente primera, para que la
  // clave sea determinista y no dependa del orden de las palabras.
  return palabras.sort((a, b) => (b.length - a.length) || a.localeCompare(b))[0];
}

export interface GrupoHermanas {
  clave: string;
  filas: FilaProducto[];
  /** Diferencia en puntos entre la mejor y la peor del grupo. `null` si no hay
   *  al menos dos filas con tasa rankeable. */
  brechaPuntos: number | null;
  /** true si la brecha supera el umbral: hay que ir a mirar los dos anuncios. */
  discrepan: boolean;
}

export interface ResumenPorProducto {
  /** Rankeables, la peor tasa primero. */
  ranking: FilaProducto[];
  /** Sin muestra suficiente. Se muestran, sin porcentaje. */
  bajoMinimo: FilaProducto[];
  /** Tasa de cancelación madura de toda la tienda en el período. */
  promedioTienda: number | null;
  /** Grupos de publicaciones del mismo producto con 2+ filas. */
  hermanas: GrupoHermanas[];
  totales: { generados: number; cancelados: number; resueltos: number; valorCancelado: number };
}

export const EMPTY_POR_PRODUCTO: ResumenPorProducto = {
  ranking: [], bajoMinimo: [], promedioTienda: null, hermanas: [],
  totales: { generados: 0, cancelados: 0, resueltos: 0, valorCancelado: 0 },
};

export function resumirPorProducto(filas: ProductoCrudo[]): ResumenPorProducto {
  if (!filas?.length) return EMPTY_POR_PRODUCTO;

  const totGen = filas.reduce((s, f) => s + f.generados, 0);
  const totCanc = filas.reduce((s, f) => s + f.cancelados, 0);
  const totRes = filas.reduce((s, f) => s + Math.max(f.generados - f.pendientes, 0), 0);
  const totVal = filas.reduce((s, f) => s + f.valorCancelado, 0);

  // El promedio de la tienda sale de la MISMA fórmula que cada fila. Si se
  // tomara de otra RPC, cualquier diferencia de filtro daría deltas imposibles
  // de auditar — el error que ya separó a `financial_summary` de
  // `logistics_summary` en el total de cancelados.
  const promedioTienda = totRes > 0 ? round1((totCanc / totRes) * 100) : null;

  const calc = (f: ProductoCrudo): FilaProducto => {
    const resueltos = Math.max(f.generados - f.pendientes, 0);
    const tasa = resueltos > 0 ? round1((f.cancelados / resueltos) * 100) : null;
    return {
      ...f,
      resueltos,
      tasa,
      delta: tasa == null || promedioTienda == null ? null : round1(tasa - promedioTienda),
      rankeable: tasa != null && resueltos >= MIN_RESUELTOS_PRODUCTO,
      claveHermanas: claveProducto(f.producto),
    };
  };

  const todas = filas.map(calc);
  const ranking = todas
    .filter(f => f.rankeable)
    // Peor primero. Desempate por volumen: entre dos con la misma tasa, el que
    // mueve más pedidos es el que hay que atender.
    .sort((a, b) => (b.tasa! - a.tasa!) || (b.generados - a.generados));
  const bajoMinimo = todas
    .filter(f => !f.rankeable)
    .sort((a, b) => b.generados - a.generados);

  // ── Publicaciones hermanas ───────────────────────────────────────────────
  const porClave = new Map<string, FilaProducto[]>();
  for (const f of todas) {
    if (!f.claveHermanas) continue;   // nombre vacío no agrupa con nada
    const arr = porClave.get(f.claveHermanas) ?? [];
    arr.push(f);
    porClave.set(f.claveHermanas, arr);
  }
  const hermanas: GrupoHermanas[] = [];
  for (const [clave, grupo] of porClave) {
    if (grupo.length < 2) continue;
    const conTasa = grupo.filter(f => f.rankeable).map(f => f.tasa!);
    const brechaPuntos = conTasa.length >= 2
      ? round1(Math.max(...conTasa) - Math.min(...conTasa))
      : null;
    hermanas.push({
      clave,
      filas: [...grupo].sort((a, b) => (b.tasa ?? -1) - (a.tasa ?? -1)),
      brechaPuntos,
      discrepan: brechaPuntos != null && brechaPuntos >= UMBRAL_HERMANAS_PUNTOS,
    });
  }
  hermanas.sort((a, b) => (b.brechaPuntos ?? -1) - (a.brechaPuntos ?? -1));

  return {
    ranking,
    bajoMinimo,
    promedioTienda,
    hermanas,
    totales: { generados: totGen, cancelados: totCanc, resueltos: totRes, valorCancelado: totVal },
  };
}

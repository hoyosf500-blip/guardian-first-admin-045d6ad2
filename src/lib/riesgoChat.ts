// El riesgo de cancelación que trae ImporChat, del lado del cliente.
//
// ESPEJA `supabase/functions/_shared/senalConfirmacion.ts` (lado servidor), que
// es donde se deriva. Acá solo vive el vocabulario y cómo se muestra: el código
// de producción de `src/` no importa de `supabase/functions/` — la única
// referencia cruzada que existe en el repo es un comentario (`dropiPais.ts`).
// El guardián `src/test/riesgoChatEspejo.test.ts` falla si las dos listas se
// separan, que es la única forma de que un espejo no mienta con el tiempo.
//
// De dónde salen los números: agosto-2026, Rushmira Ecuador, 765 pedidos ya
// resueltos de los cuales 213 se cancelaron (27,8%).

export type NivelRiesgo = 'sin_dato' | 'confirmado' | 'tibio' | 'frio' | 'mudo';

/** Orden de la cola: primero lo que más se pierde si nadie lo toca. */
export const PRIORIDAD_RIESGO: Record<NivelRiesgo, number> = {
  mudo: 0,
  frio: 1,
  tibio: 2,
  sin_dato: 3,
  confirmado: 4,
};

export interface RiesgoInfo {
  /** Lo que ve la asesora en el chip. Corto: entra en una fila de tabla. */
  etiqueta: string;
  /** Qué pasó, en una frase. */
  que: string;
  /** La tasa medida, para que el chip no sea una opinión. */
  tasa: string;
  /** Qué hacer con este pedido. */
  queHacer: string;
  /** Clase Tailwind del chip. Tokens del design system, no colores crudos. */
  clase: string;
}

export const RIESGO_INFO: Record<NivelRiesgo, RiesgoInfo> = {
  mudo: {
    etiqueta: 'Llamar — no usa chat',
    que: 'Nunca escribió nada por WhatsApp, jamás.',
    tasa: '66% se cancela',
    queHacer: 'Es la mitad de todo lo que se pierde. De los que nadie llamó, se cancelaron todos.',
    clase: 'bg-destructive/15 text-destructive border-destructive/30',
  },
  frio: {
    // ⛔ Antes decía "No respondió" y CHOCABA de frente con la línea de abajo
    // en la misma fila (28-ago-2026). Esta regla mira SOLO este pedido — si el
    // cliente apretó o no el botón de confirmar —, mientras que "el cliente
    // escribió y sigue sin respuesta" mira TODA la conversación. Las dos pueden
    // ser ciertas a la vez, y juntas se leían como opuestas: una decía que el
    // cliente no contestó y la otra que estaba esperando respuesta nuestra.
    // La palabra nueva dice lo que la regla mide de verdad.
    // La clave `frio` NO se toca: es el valor histórico guardado en la base.
    etiqueta: 'No confirmó por el chat',
    que: 'Alguna vez habló por el chat, pero con este pedido no hizo nada.',
    tasa: '38% se cancela',
    queHacer: 'Escribile: ese cliente sí contesta, con este pedido todavía no.',
    clase: 'bg-destructive/10 text-destructive border-destructive/25',
  },
  tibio: {
    etiqueta: 'Quedó con dudas',
    que: 'Escribió, pero nunca apretó el botón de confirmar.',
    tasa: '34% se cancela',
    queHacer: 'Casi siempre es una duda del producto. Contestala y cerrá vos.',
    clase: 'bg-warning/15 text-warning-foreground border-warning/30',
  },
  sin_dato: {
    etiqueta: 'Sin leer',
    que: 'Todavía no se leyó la conversación de este pedido.',
    tasa: '—',
    queHacer: 'No lo saltees por estar en blanco: en blanco no quiere decir tranquilo.',
    clase: 'bg-muted text-muted-foreground border-border',
  },
  confirmado: {
    etiqueta: 'Ya confirmó',
    que: 'Apretó “Confirmar pedido” en el WhatsApp.',
    tasa: '10% se cancela',
    queHacer: 'No hace falta llamarlo. Los que apretaron y ni escribieron cancelan 7%.',
    clase: 'bg-success/15 text-success border-success/30',
  },
};

/** El conteo de la cola PENDIENTE partido por etiqueta de chat. Para el resumen
 *  de arriba de Confirmar: "96 llamar · 8 con dudas · 12 ya confirmó". */
export interface ConteoRiesgo {
  mudo: number;
  frio: number;
  tibio: number;
  sin_dato: number;
  confirmado: number;
  /** Pendientes sin dbId o sin señal todavía (no cae en ninguna etiqueta). */
  sinSenal: number;
  /** Total de pendientes contados. */
  total: number;
}

/**
 * Cuenta los pedidos PENDIENTES (sin `result`) por etiqueta de riesgo.
 *
 * Solo pendientes a propósito: el resumen es "qué trabajo me QUEDA por
 * atender", no un histórico. Un pedido ya gestionado no es carga. Un pendiente
 * sin señal de chat (dbId ausente o no sincronizado) cae en `sinSenal`, no se
 * fuerza a ninguna etiqueta — mismo criterio que `normalizarRiesgo`.
 */
export function contarPorRiesgo(
  items: Array<{ dbId?: string | null; result?: string | null }>,
  index: Map<string, NivelRiesgo>,
): ConteoRiesgo {
  const c: ConteoRiesgo = { mudo: 0, frio: 0, tibio: 0, sin_dato: 0, confirmado: 0, sinSenal: 0, total: 0 };
  for (const o of items) {
    if (o.result) continue;
    c.total += 1;
    const r = o.dbId ? index.get(o.dbId) ?? null : null;
    if (r) c[r] += 1;
    else c.sinSenal += 1;
  }
  return c;
}

/** Normaliza lo que venga de la base. Cualquier cosa rara → `null`.
 *
 *  Devuelve `null` y NO `'sin_dato'` a propósito: son cosas distintas.
 *  `null` = esta columna no existe todavía o no se sincronizó nunca, y la
 *  pantalla no debe dibujar nada. `'sin_dato'` = se intentó leer la
 *  conversación y no se pudo, que sí es información y sí se muestra. */
export function normalizarRiesgo(v: unknown): NivelRiesgo | null {
  const s = String(v ?? '').trim();
  return (s in PRIORIDAD_RIESGO) ? (s as NivelRiesgo) : null;
}

/**
 * Comparador por riesgo. Un pedido SIN señal (`null`) queda en el medio,
 * exactamente donde estaría hoy: así, mientras la sincronización no corra, la
 * cola se comporta byte por byte como antes y nadie nota un cambio fantasma.
 */
export function compararRiesgo(a: NivelRiesgo | null, b: NivelRiesgo | null): number {
  const NEUTRO = PRIORIDAD_RIESGO.sin_dato;
  const pa = a ? PRIORIDAD_RIESGO[a] : NEUTRO;
  const pb = b ? PRIORIDAD_RIESGO[b] : NEUTRO;
  return pa - pb;
}

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
  frio: 0,
  mudo: 1,
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
  frio: {
    etiqueta: 'Llamar primero',
    que: 'Le llegó la confirmación por WhatsApp y no hizo nada.',
    tasa: '58% se cancela',
    queHacer: 'Es el grupo donde está el 62% de la plata que se pierde.',
    clase: 'bg-destructive/15 text-destructive border-destructive/30',
  },
  mudo: {
    etiqueta: 'Solo por teléfono',
    que: 'Nunca escribió nada por WhatsApp, jamás.',
    tasa: '76% se cancela',
    queHacer: 'A esta persona el chat no le sirve. De los que nadie llamó, se cancelaron todos.',
    clase: 'bg-destructive/10 text-destructive border-destructive/25',
  },
  tibio: {
    etiqueta: 'Quedó con dudas',
    que: 'Escribió, pero nunca apretó el botón de confirmar.',
    tasa: '42% se cancela',
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

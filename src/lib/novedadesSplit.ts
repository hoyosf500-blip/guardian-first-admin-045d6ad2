// Separa la cola de Novedades en dos grupos según la lista de incidencias
// ABIERTAS que devuelve dropi-open-incidences (la misma consulta del panel de
// Dropi — ver el 19-vs-9 del 2026-07-06):
//  - porGestionar: la incidencia sigue abierta en Dropi → trabajo real de la
//    asesora (es lo que Dropi muestra en su panel de novedades).
//  - esperando: el pedido sigue en estado NOVEDAD pero la transportadora cerró
//    o dejó vencer la incidencia → no hay nada que gestionar (Dropi rechaza
//    resolverlas); queda esperar reintento o devolución.
//
// `openIds === null` significa "no sé" (edge caída, función sin deployar,
// token vencido): NO separamos — todo va a porGestionar, igual que antes del
// split. Degradación segura por diseño.

export interface NovedadesSplit<T> {
  porGestionar: T[];
  esperando: T[];
  /** true = la separación viene de datos reales de Dropi; false = fallback sin separar. */
  conocido: boolean;
}

export function splitNovedades<T extends { externalId?: string | null }>(
  queue: T[],
  openIds: Set<string> | null,
): NovedadesSplit<T> {
  // `openIds` null = "no sé" (edge caída). Y un set VACÍO con cola no-vacía es
  // la MISMA incertidumbre disfrazada de dato (H1, auditoría 14-ago-2026): si
  // Dropi renombra un literal de la consulta del panel, la edge devuelve 200
  // con 0 ids y TODA la cola caía a "Esperando transportadora" con check verde
  // — trabajo real escondido detrás de un panel plegado. "Cero incidencias
  // abiertas con N novedades en cola" no se puede distinguir de "la consulta
  // se rompió", así que no se separa: todo queda visible como pendiente. El
  // error contrario (esconder trabajo) cuesta clientes; este solo cuesta que
  // la asesora vea de más.
  if (!openIds || (openIds.size === 0 && queue.length > 0)) {
    return { porGestionar: queue, esperando: [], conocido: false };
  }
  const porGestionar: T[] = [];
  const esperando: T[] = [];
  for (const o of queue) {
    if (o.externalId && openIds.has(String(o.externalId))) porGestionar.push(o);
    else esperando.push(o);
  }
  return { porGestionar, esperando, conocido: true };
}

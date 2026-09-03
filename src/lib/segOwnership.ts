/**
 * Propiedad de un pedido en Seguimiento, derivada de la GESTIÓN REAL — NO de la
 * columna `assigned_to` (auto-asignación que ya se apagó, migration
 * 20260524120000). Un pedido "es mío" si yo registré una gestión (touchpoint)
 * sobre su teléfono; "está disponible" si nadie lo ha gestionado todavía.
 *
 * Los touchpoints de admins se IGNORAN: cuando Fabian entra a auditar no debe
 * marcar pedidos como "atendidos" ni robárselos a la operadora real (mismo
 * criterio que useSegAssignment, donde los admins nunca reclaman).
 */

export type SegOwnerBucket = 'mine' | 'available' | 'other';

/** Touchpoint mínimo necesario para clasificar (la fila real trae más campos). */
interface TouchpointLike {
  operator_id: string;
  /** Solo hace falta si se pide una ventana. Sin él, la fila NO se descarta:
   *  no saber cuándo fue no es razón para borrar una gestión que existió. */
  created_at?: string | null;
}

/**
 * Clasifica un pedido a partir de SUS touchpoints (ya filtrados por teléfono).
 *  - 'available' → ningún touchpoint de operadora (nadie lo ha gestionado)
 *  - 'mine'      → tengo al menos un touchpoint propio
 *  - 'other'     → solo lo ha gestionado otra operadora
 *
 * `desdeMs` (opcional) acota la ventana.
 *
 * ⛔ POR QUÉ EXISTE (3-sep-2026). Esta función NO miraba la fecha, y `CrmTable`
 * le pasa **60 días** de touchpoints. O sea que un pedido que alguien tocó hace
 * cincuenta días seguía diciendo **"Mío"** en la vista Lista, como si estuviera
 * trabajado hoy. El dueño necesita esa etiqueta para saber a quién NO regañar:
 * una etiqueta que se queda pegada dos meses no le sirve para eso — le dice que
 * está atendido algo que nadie mira desde marzo.
 *
 * Es opcional a propósito: quien no la pasa se comporta EXACTAMENTE como antes.
 * El filtro "solo disponibles" de la lista no la usa a propósito (ver `CrmTable`).
 */
export function classifySegOwnershipFromTps(
  tps: TouchpointLike[],
  currentUserId: string | undefined,
  adminIds: string[],
  desdeMs?: number,
): SegOwnerBucket {
  const adminSet = new Set(adminIds);
  // Solo cuentan las gestiones de operadoras (no de admins auditando).
  const operatorTps = tps.filter((tp) => {
    if (adminSet.has(tp.operator_id)) return false;
    if (desdeMs == null) return true;
    // Una fila sin fecha NO se descarta: "no sé cuándo fue" no es lo mismo que
    // "fue hace mucho", y descartarla convertiría una gestión real en un pedido
    // "que nadie tocó" — el error caro en esta pantalla.
    if (!tp.created_at) return true;
    const t = Date.parse(tp.created_at);
    return !Number.isFinite(t) || t >= desdeMs;
  });

  if (operatorTps.length === 0) return 'available';
  if (currentUserId && operatorTps.some((tp) => tp.operator_id === currentUserId)) {
    return 'mine';
  }
  return 'other';
}

/**
 * Variante por teléfono sobre el mapa `phoneTouchpoints` (touchpoints del
 * módulo SEG agrupados por teléfono). Útil para filtrar la lista completa.
 */
export function classifySegOwnership(
  phone: string,
  touchpointsByPhone: Record<string, TouchpointLike[]>,
  currentUserId: string | undefined,
  adminIds: string[],
): SegOwnerBucket {
  return classifySegOwnershipFromTps(
    touchpointsByPhone[phone] ?? [],
    currentUserId,
    adminIds,
  );
}

export type SegOwnerFilter = 'mine' | 'available' | 'all';

/**
 * ¿El bucket pasa el filtro seleccionado?
 *  - 'all'       → siempre (incluye míos, disponibles y de otras)
 *  - 'mine'      → solo los que he gestionado yo
 *  - 'available' → solo los que nadie ha gestionado (el bucket "fácil")
 */
export function matchesOwnerFilter(
  bucket: SegOwnerBucket,
  filter: SegOwnerFilter,
): boolean {
  if (filter === 'all') return true;
  return bucket === filter;
}

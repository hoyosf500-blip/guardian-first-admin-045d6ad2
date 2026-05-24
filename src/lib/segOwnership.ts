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
}

/**
 * Clasifica un pedido a partir de SUS touchpoints (ya filtrados por teléfono).
 *  - 'available' → ningún touchpoint de operadora (nadie lo ha gestionado)
 *  - 'mine'      → tengo al menos un touchpoint propio
 *  - 'other'     → solo lo ha gestionado otra operadora
 */
export function classifySegOwnershipFromTps(
  tps: TouchpointLike[],
  currentUserId: string | undefined,
  adminIds: string[],
): SegOwnerBucket {
  const adminSet = new Set(adminIds);
  // Solo cuentan las gestiones de operadoras (no de admins auditando).
  const operatorTps = tps.filter((tp) => !adminSet.has(tp.operator_id));

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

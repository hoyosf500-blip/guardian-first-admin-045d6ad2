/**
 * Lógica pura del guardia anti-duplicados del panel anti-fuga (Confirmar).
 * Sin red ni React. Reusa `normalizePhone` (últimos 9 dígitos, CO+EC).
 *
 * Regla: un pedido pendiente de Shopify es "duplicado" si su teléfono ya tiene
 * un pedido en Dropi NO cancelado (cualquier fecha). La asesora puede destrabar
 * con "No es duplicado" (override por pedido).
 */
import { normalizePhone } from './phone';

/** Pedido que YA existe en Dropi (devuelto por la RPC find_duplicate_phones). */
export interface ExistingOrder {
  phone_norm: string;
  external_id: string;
  estado: string | null;
  fecha: string | null;
  nombre: string | null;
  created_at: string | null;
}

/** Mapa teléfono-normalizado → pedidos Dropi existentes con ese teléfono. */
export function buildDupMap(existing: ExistingOrder[]): Map<string, ExistingOrder[]> {
  const map = new Map<string, ExistingOrder[]>();
  for (const e of existing) {
    if (!e.phone_norm) continue;
    const arr = map.get(e.phone_norm);
    if (arr) arr.push(e);
    else map.set(e.phone_norm, [e]);
  }
  return map;
}

/** Pedidos Dropi existentes para un teléfono (o [] si ninguno). */
export function dupMatchesFor(
  phone: string | null | undefined,
  dupMap: Map<string, ExistingOrder[]>,
): ExistingOrder[] {
  const norm = normalizePhone(phone);
  if (!norm) return [];
  return dupMap.get(norm) ?? [];
}

/**
 * ¿El pedido está BLOQUEADO por duplicado? Tiene match de teléfono Y la asesora
 * no lo marcó como "No es duplicado" (override por id de pedido).
 */
export function isBlockedByDuplicate(
  item: { id: string; phone: string | null | undefined },
  dupMap: Map<string, ExistingOrder[]>,
  overrides: Set<string>,
): boolean {
  if (overrides.has(item.id)) return false;
  return dupMatchesFor(item.phone, dupMap).length > 0;
}

/** Teléfonos normalizados únicos (no vacíos) de una lista de pedidos. */
export function uniquePhones(items: Array<{ phone: string | null | undefined }>): string[] {
  const set = new Set<string>();
  for (const it of items) {
    const n = normalizePhone(it.phone);
    if (n) set.add(n);
  }
  return [...set];
}

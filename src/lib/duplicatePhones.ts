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

/**
 * ⛔ LOS REPETIDOS DENTRO DEL PROPIO LOTE (3-sep-2026).
 *
 * `isBlockedByDuplicate` compara contra los pedidos que YA están en Dropi. No
 * mira el lote contra sí mismo — y "Subir todos" sube uno por uno en un bucle.
 * Si dos ventas de Shopify distintas traen el MISMO teléfono, las dos pasaban el
 * filtro (ninguna estaba aún en Dropi) y las dos se subían con segundos de
 * diferencia: dos órdenes reales, dos guías con números consecutivos, doble
 * flete. Es exactamente lo que reportaron el 3-sep-2026 en Colombia 2 — tienda
 * que tiene el robot APAGADO, o sea que el duplicado salió de este botón.
 *
 * Se queda el PRIMERO de cada teléfono y los demás esperan. No se pierden: la
 * asesora los ve en la lista con su motivo, y si de verdad son dos pedidos
 * distintos los sube con "No es duplicado".
 *
 * ⛔ El override manda: un pedido que la asesora ya marcó como "No es duplicado"
 * NO se frena acá. Ella miró los dos y decidió; el sistema no le discute.
 *
 * Devuelve los ids que hay que dejar para después (nunca el primero).
 */
export function repetidosEnElLote(
  items: Array<{ id: string; phone: string | null | undefined }>,
  overrides: Set<string> = new Set(),
): Set<string> {
  const vistos = new Set<string>();
  const repetidos = new Set<string>();
  for (const it of items) {
    if (overrides.has(it.id)) continue;
    const n = normalizePhone(it.phone);
    // Sin teléfono no se puede afirmar que sean el mismo cliente: no se frena.
    if (!n) continue;
    if (vistos.has(n)) repetidos.add(it.id);
    else vistos.add(n);
  }
  return repetidos;
}

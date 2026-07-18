import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Auditoría de paridad Guardian ↔ Dropi (Capa 3 del PLAN-PARITY-DROPI).
 *
 * Reproduce de forma programática el método que hicimos a mano el 2026-05-28
 * para arreglar los 47 pedidos EC stale: lee no-terminales de Guardian, lee
 * los mismos rangos en Dropi (web v2) y reporta divergencias. El operador
 * confirma y aplica los UPDATE en bulk.
 *
 * Es independiente del cron: aunque dropi-cron caiga zombie, el owner puede
 * disparar esto desde /admin y dejar el estado alineado.
 */

export interface GuardianOrder {
  id: string;
  external_id: string;
  estado: string;
  guia: string;
  transportadora: string;
  nombre: string;
}

export interface DropiOrder {
  id: string;
  status: string;
  guia: string;
  trans: string;
  name: string;
}

export interface Divergence {
  guardianId: string;
  externalId: string;
  nombre: string;
  before: { estado: string; guia: string; trans: string };
  after: { estado: string; guia: string; trans: string };
  action: 'update' | 'cancel_orphan';
}

const ORPHAN_THRESHOLD = 5_000_000;

/** Tope de filas que traemos de Guardian por corrida. No paginamos: pedimos el
 *  conteo EXACTO aparte para saber si nos quedamos cortos y poder DECIRLO, en
 *  vez de rotular una muestra como si fuera el total de la tienda. */
export const GUARDIAN_SCAN_LIMIT = 2000;

/** Estados terminales en Guardian — no necesitan auditarse (no van a cambiar). */
const TERMINAL = [
  'PENDIENTE CONFIRMACION', 'ENTREGADO', 'CANCELADO', 'DEVOLUCION',
  'DEVUELTO', 'ARCHIVADO_GHOST', 'ORDEN INDEMNIZADA', 'RECHAZADO',
];

export interface GuardianScan {
  /** Los pedidos que efectivamente entraron a la comparación contra Dropi. */
  orders: GuardianOrder[];
  /** Conteo EXACTO de no-terminales de la tienda en la DB.
   *  `null` = el servidor no devolvió el conteo (no asumir 0). */
  total: number | null;
  /** true si quedaron no-terminales fuera del corte, o sea: `orders` es una
   *  MUESTRA y no se puede afirmar paridad sobre ella. */
  truncated: boolean;
}

export async function fetchGuardianNonTerminal(
  supabase: SupabaseClient,
  storeId: string,
): Promise<GuardianScan> {
  const inList = `(${TERMINAL.map((s) => `"${s}"`).join(',')})`;
  const { data, count, error } = await supabase
    .from('orders')
    .select('id, external_id, estado, guia, transportadora, nombre', { count: 'exact' })
    .eq('store_id', storeId)
    .not('estado', 'in', inList)
    .not('external_id', 'is', null)
    .limit(GUARDIAN_SCAN_LIMIT);
  if (error) throw new Error(error.message);
  const rows = (data || []) as GuardianOrder[];
  const orders = rows.filter((o) => o.external_id);
  const total = typeof count === 'number' ? count : null;
  // Comparamos contra `rows.length` (lo que devolvió la query), NO contra
  // `orders.length` (ya filtrado) — si no, un external_id vacío se leería como
  // truncamiento. Sin count, tocar el tope es la única señal de que hay más
  // afuera: preferimos avisar de más antes que declarar paridad sobre una muestra.
  const truncated = total !== null
    ? total > rows.length
    : rows.length >= GUARDIAN_SCAN_LIMIT;
  return { orders, total, truncated };
}

/** Pide el snapshot Dropi al edge function `dropi-snapshot`. El proxy
 *  server-side existe porque api.dropi.ec/co NO permite CORS desde
 *  guardian-first-admin.lovable.app → un fetch directo desde el browser
 *  daba "Failed to fetch" en preflight. El edge usa la integration-key
 *  permanente de la tienda (no necesita session token web) y devuelve
 *  el snapshot ya mapeado al shape DropiOrder. */
export async function fetchDropiSnapshot(
  supabase: SupabaseClient,
  storeId: string,
  fromDate: string,
  toDate: string,
): Promise<{ snapshot: Map<string, DropiOrder>; partial: boolean; message?: string }> {
  const { data, error } = await supabase.functions.invoke('dropi-snapshot', {
    body: { store_id: storeId, from: fromDate, to: toDate },
  });
  if (error) throw new Error(error.message || 'dropi-snapshot falló');
  const result = data as {
    orders?: DropiOrder[];
    error?: string;
    partial?: boolean;
    message?: string;
  };
  if (result?.error) throw new Error(result.error);
  const out = new Map<string, DropiOrder>();
  for (const o of result?.orders || []) out.set(String(o.id), o);
  return { snapshot: out, partial: Boolean(result?.partial), message: result?.message };
}

/** Mapea el status crudo de Dropi al estado canónico de Guardian. */
export function mapDropiStatusToGuardian(s: string): string {
  const up = (s || '').toUpperCase();
  if (up === 'GENERADA') return 'GUIA_GENERADA';
  return up;
}

export function findDivergences(
  guardian: GuardianOrder[],
  dropi: Map<string, DropiOrder>,
): Divergence[] {
  const out: Divergence[] = [];
  for (const g of guardian) {
    const ext = String(g.external_id);
    const d = dropi.get(ext);
    if (!d) {
      // Huérfano: Guardian lo tiene no-terminal pero Dropi no lo conoce.
      // Solo lo marcamos cancelable si es id viejo (< 5M) — los nuevos pueden
      // ser tan recientes que aún no entren en el rango consultado.
      const extNum = Number(ext);
      if (Number.isFinite(extNum) && extNum < ORPHAN_THRESHOLD) {
        out.push({
          guardianId: g.id,
          externalId: ext,
          nombre: g.nombre,
          before: { estado: g.estado, guia: g.guia, trans: g.transportadora },
          after: { estado: 'CANCELADO', guia: g.guia, trans: g.transportadora },
          action: 'cancel_orphan',
        });
      }
      continue;
    }
    const newEstado = mapDropiStatusToGuardian(d.status);
    if (
      g.estado !== newEstado
      || (g.guia || '') !== (d.guia || '')
      || (g.transportadora || '') !== (d.trans || '')
    ) {
      out.push({
        guardianId: g.id,
        externalId: ext,
        nombre: g.nombre,
        before: { estado: g.estado, guia: g.guia, trans: g.transportadora },
        after: { estado: newEstado, guia: d.guia, trans: d.trans },
        action: 'update',
      });
    }
  }
  return out;
}

export async function applyDivergences(
  supabase: SupabaseClient,
  storeId: string,
  divergences: Divergence[],
): Promise<{ applied: number; failed: Divergence[] }> {
  let applied = 0;
  const failed: Divergence[] = [];
  for (const d of divergences) {
    const { error } = await supabase
      .from('orders')
      .update({
        estado: d.after.estado,
        guia: d.after.guia,
        transportadora: d.after.trans,
        last_movement_at: new Date().toISOString(),
      })
      .eq('id', d.guardianId)
      .eq('store_id', storeId);
    if (error) failed.push(d);
    else applied++;
  }
  return { applied, failed };
}

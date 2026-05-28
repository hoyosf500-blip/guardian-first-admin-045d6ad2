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

/** Estados terminales en Guardian — no necesitan auditarse (no van a cambiar). */
const TERMINAL = [
  'PENDIENTE CONFIRMACION', 'ENTREGADO', 'CANCELADO', 'DEVOLUCION',
  'DEVUELTO', 'ARCHIVADO_GHOST', 'ORDEN INDEMNIZADA', 'RECHAZADO',
];

export async function fetchGuardianNonTerminal(
  supabase: SupabaseClient,
  storeId: string,
): Promise<GuardianOrder[]> {
  const inList = `(${TERMINAL.map((s) => `"${s}"`).join(',')})`;
  const { data, error } = await supabase
    .from('orders')
    .select('id, external_id, estado, guia, transportadora, nombre')
    .eq('store_id', storeId)
    .not('estado', 'in', inList)
    .not('external_id', 'is', null)
    .limit(2000);
  if (error) throw new Error(error.message);
  return ((data || []) as GuardianOrder[]).filter((o) => o.external_id);
}

/** Llama al endpoint web v2 de Dropi (api.dropi.ec para EC) con el session
 *  token del owner. Pagina hasta agotar resultados. */
export async function fetchDropiSnapshot(
  sessionToken: string,
  fromDate: string,
  toDate: string,
  userId: number,
  countryCode = 'EC',
): Promise<Map<string, DropiOrder>> {
  const out = new Map<string, DropiOrder>();
  const host = countryCode === 'EC' ? 'https://api.dropi.ec' : 'https://api.dropi.co';
  let start = 0;
  const pageSize = 200;
  while (true) {
    const url = `${host}/api/orders/myorders/v2?exportAs=orderByRow&orderBy=id&orderDirection=desc`
      + `&result_number=${pageSize}&start=${start}`
      + `&textToSearch=&status=null&supplier_id=false&user_id=${userId}`
      + `&from=${fromDate}&until=${toDate}`
      + `&filter_product=undefined&haveIncidenceProcesamiento=false&tag_id=&warranty=false&seller=null`
      + `&filter_date_by=Modified%20Date&invoiced=null`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${sessionToken}` } });
    if (!r.ok) throw new Error(`Dropi HTTP ${r.status} en página start=${start}`);
    const data = await r.json();
    const objs = Array.isArray(data?.objects) ? data.objects : [];
    if (objs.length === 0) break;
    for (const o of objs) {
      out.set(String(o.id), {
        id: String(o.id),
        status: String(o.status || ''),
        guia: String(o.shipping_guide || ''),
        trans: String((o.distribution_company && o.distribution_company.name) || o.shipping_company || ''),
        name: ((o.name || '') + ' ' + (o.surname || '')).trim(),
      });
    }
    if (objs.length < pageSize) break;
    start += pageSize;
  }
  return out;
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

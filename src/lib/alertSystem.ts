/**
 * 5-Level Alert System ported from Panel Operadora v3.2
 * Tracks order risk based on carrier scanning activity
 */

export { CARRIER_DEADLINES } from './constants';

export type AlertLevel = 'ok' | 'watch' | 'alert' | 'critical' | 'lost';

export interface AlertInfo {
  level: AlertLevel;
  color: string;
  tailwindColor: string;
  icon: string;
  label: string;
  sinEscaneo: number;
  lastMov: string;
  officeCD: { deadline: number; remaining: number; carrier: string } | null;
  novedadW: { remaining: number } | null;
}

export interface FreshnessInfo {
  hoursAgo: number;
  level: 'fresh' | 'pending' | 'stale' | 'critical';
  color: string;
  tailwindColor: string;
  label: string;
}

export function getCarrierDeadline(transportadora: string): number {
  return CARRIER_DEADLINES[(transportadora || '').toUpperCase()] || 7;
}

export function getSegStage(estado: string): string {
  const s = estado.toUpperCase();
  if (s === 'NOVEDAD' || s === 'INTENTO DE ENTREGA') return 'novedad';
  if (s.includes('OFICINA') || s.includes('RECLAME')) return 'oficina';
  if (s.includes('DEVOL')) return 'devolucion';
  if (['PENDIENTE', 'ALISTAMIENTO', 'GUIA GENERADA', 'EN PROCESAMIENTO', 'EN BODEGA DROPI', 'RECOGIDO POR DROPI'].includes(s)) return 'bodega';
  if (s === 'GUIA_GENERADA' || s.includes('PREPARADO') || s === 'ENTREGADO A TRANSPORTADORA') return 'guia';
  if (s.includes('REPARTO') || s.includes('DISTRIBUCION') || s.includes('TERMINAL') || s.includes('REEXPEDICION') || s.includes('DESPACHAD') || s.includes('REENVÍO') || s.includes('REENVIO') || s.includes('TRANSPORTE') || s === 'ADMITIDA' || s === 'EN DESPACHO' || s === 'TELEMERCADEO') return 'transito';
  return 'otro';
}

export function getAlertLevel(diasConf: number, dias: number, estado: string, transportadora: string, novedad?: string): AlertInfo | null {
  const stage = getSegStage(estado);

  const sinEscaneo = diasConf > 0 ? diasConf : dias;
  // diasConf === 0 means "confirmed today" — valid, not missing. The old
  // `!sinEscaneo` check treated 0 as falsy and returned null, silently
  // excluding freshly confirmed orders from the alert system.
  if (sinEscaneo < 0) return null;

  // Office countdown
  let officeCD: AlertInfo['officeCD'] = null;
  const e = estado.toUpperCase();
  if (e.includes('OFICINA') || e.includes('RECLAME')) {
    const dl = getCarrierDeadline(transportadora);
    const rem = Math.max(0, dl - sinEscaneo);
    officeCD = { deadline: dl, remaining: rem, carrier: transportadora || '?' };
  }

  // Novedad rescue window (3 days)
  let novedadW: AlertInfo['novedadW'] = null;
  if (e === 'NOVEDAD' || e === 'INTENTO DE ENTREGA') {
    const rem = Math.max(0, 3 - sinEscaneo);
    novedadW = { remaining: rem };
  }

  let level: AlertLevel, color: string, tailwindColor: string, icon: string, label: string;

  if (sinEscaneo < 1) {
    level = 'ok'; color = 'var(--green)'; tailwindColor = 'text-green'; icon = '🟢'; label = 'Normal';
  } else if (sinEscaneo < 2) {
    level = 'watch'; color = 'var(--yellow)'; tailwindColor = 'text-yellow-500'; icon = '🟡'; label = `${sinEscaneo}d — Monitorear`;
  } else if (sinEscaneo < 3) {
    level = 'alert'; color = 'var(--orange)'; tailwindColor = 'text-orange'; icon = '🟠'; label = `${sinEscaneo}d — Llamar + reclamar`;
  } else if (sinEscaneo < 5) {
    level = 'critical'; color = 'var(--red)'; tailwindColor = 'text-red'; icon = '🔴'; label = `${sinEscaneo}d — Posible pérdida`;
  } else {
    level = 'lost'; color = '#888'; tailwindColor = 'text-muted-foreground'; icon = '⚫'; label = `${sinEscaneo}d — Devolución casi segura`;
  }

  return { level, color, tailwindColor, icon, label, sinEscaneo, lastMov: '', officeCD, novedadW };
}

export function getFreshness(lastTouchTime: number | null, dias: number): FreshnessInfo {
  let hoursAgo: number;
  if (lastTouchTime && lastTouchTime > 0) {
    hoursAgo = (Date.now() - lastTouchTime) / 3600000;
  } else {
    hoursAgo = (dias || 0) * 24;
  }

  if (hoursAgo < 4) {
    return { hoursAgo, level: 'fresh', color: 'var(--green)', tailwindColor: 'text-green', label: hoursAgo < 1 ? `hace ${Math.round(hoursAgo * 60)}min` : `hace ${Math.round(hoursAgo)}h` };
  } else if (hoursAgo < 24) {
    return { hoursAgo, level: 'pending', color: 'var(--yellow)', tailwindColor: 'text-yellow-500', label: `hace ${Math.round(hoursAgo)}h` };
  } else if (hoursAgo < 48) {
    return { hoursAgo, level: 'stale', color: 'var(--orange)', tailwindColor: 'text-orange', label: `hace ${Math.round(hoursAgo / 24)}d ${Math.round(hoursAgo % 24)}h` };
  } else {
    return { hoursAgo, level: 'critical', color: 'var(--red)', tailwindColor: 'text-red', label: `hace ${Math.round(hoursAgo / 24)}d` };
  }
}

export function needsAction(estado: string, diasConf: number, dias: number, isResolved: boolean, lastTouchTime: number | null): boolean {
  if (isResolved) return false;
  const stage = getSegStage(estado);
  if (stage === 'bodega' || stage === 'guia') return false;
  const e = estado.toUpperCase();
  const fresh = getFreshness(lastTouchTime, diasConf || dias);

  if (e === 'NOVEDAD' || e === 'INTENTO DE ENTREGA' || e.includes('OFICINA') || e.includes('RECLAME')) {
    return fresh.hoursAgo >= 12;
  }
  if (!diasConf || diasConf < 5) return false;
  return fresh.hoursAgo >= 24;
}

export function getSuggestedAction(estado: string, novedad: string, transportadora: string, diasConf: number): string {
  const e = estado.toUpperCase();
  if (e.includes('OFICINA') || e.includes('RECLAME')) {
    return `Llamar al cliente — decirle que recoja en oficina de ${transportadora || 'la transportadora'}`;
  }
  if ((e === 'NOVEDAD' || e === 'INTENTO DE ENTREGA') && novedad?.toLowerCase().includes('direcci')) {
    return 'Llamar al cliente — pedir dirección correcta';
  }
  if (e === 'NOVEDAD' || e === 'INTENTO DE ENTREGA') {
    return `Llamar al cliente + reclamar a ${transportadora || 'transportadora'}`;
  }
  if (diasConf >= 3) {
    return `Reclamar a ${transportadora || 'transportadora'} — paquete lleva ${diasConf}d sin escaneo`;
  }
  return 'Contactar al cliente por WhatsApp para confirmar que espera el pedido';
}

/**
 * Priority score for ordering work queues (higher = more urgent).
 * Combines SLA risk, operational stage, and order value.
 */
export function calcPriority(order: {
  diasConf: number; dias: number; estado: string;
  transportadora: string; novedad?: string; novedadSol?: boolean;
  valor?: number;
}): number {
  let score = 0;
  const sinEscaneo = order.diasConf !== undefined && order.diasConf >= 0 ? order.diasConf : order.dias;
  const e = (order.estado || '').toUpperCase();
  const stage = getSegStage(e);

  // SLA urgency (0–50 pts) — biggest weight
  if (sinEscaneo >= 5) score += 50;
  else if (sinEscaneo >= 3) score += 40;
  else if (sinEscaneo >= 2) score += 25;
  else if (sinEscaneo >= 1) score += 10;

  // Stage urgency (0–30 pts)
  if (stage === 'novedad' && !order.novedadSol) score += 30;
  else if (stage === 'oficina') score += 25;
  else if (stage === 'devolucion') score += 20;
  else if (stage === 'transito') score += 5;

  // High-value bonus (0–10 pts)
  const val = Number(order.valor) || 0;
  if (val >= 200000) score += 10;
  else if (val >= 100000) score += 5;
  else if (val >= 50000) score += 2;

  // Novedad rescue window bonus
  if ((e === 'NOVEDAD' || e === 'INTENTO DE ENTREGA') && !order.novedadSol) {
    const rescue = Math.max(0, 3 - sinEscaneo);
    if (rescue <= 1) score += 15; // last day to rescue
  }

  // Office countdown bonus
  if (e.includes('OFICINA') || e.includes('RECLAME')) {
    const dl = getCarrierDeadline(order.transportadora);
    const rem = Math.max(0, dl - sinEscaneo);
    if (rem <= 2) score += 15; // about to expire
  }

  return score;
}

/** Priority level for UI display */
export type PriorityLevel = 'critical' | 'high' | 'medium' | 'low';

export function getPriorityLevel(score: number): PriorityLevel {
  if (score >= 50) return 'critical';
  if (score >= 30) return 'high';
  if (score >= 15) return 'medium';
  return 'low';
}

export const PRIORITY_CONFIG: Record<PriorityLevel, { label: string; color: string; bgClass: string }> = {
  critical: { label: 'Urgente', color: 'text-red-500', bgClass: 'bg-red-500/10 border-red-500/30' },
  high: { label: 'Alta', color: 'text-orange-500', bgClass: 'bg-orange-500/10 border-orange-500/30' },
  medium: { label: 'Media', color: 'text-yellow-500', bgClass: 'bg-yellow-500/10 border-yellow-500/30' },
  low: { label: 'Normal', color: 'text-muted-foreground', bgClass: '' },
};

/** Carrier performance stats */
export interface CarrierStat {
  carrier: string;
  total: number;
  entregado: number;
  devol: number;
  novedad: number;
  oficina: number;
  efectividad: number;
  devolRate: number;
}

export function calcCarrierStats(orders: Array<{ estado: string; transportadora: string }>): CarrierStat[] {
  const byCarrier: Record<string, { total: number; entregado: number; devol: number; novedad: number; oficina: number }> = {};
  orders.forEach(o => {
    const t = o.transportadora || '';
    if (!t) return;
    if (!byCarrier[t]) byCarrier[t] = { total: 0, entregado: 0, devol: 0, novedad: 0, oficina: 0 };
    byCarrier[t].total++;
    const e = o.estado.toUpperCase();
    if (e === 'ENTREGADO') byCarrier[t].entregado++;
    if (e.includes('DEVOL')) byCarrier[t].devol++;
    if (e === 'NOVEDAD' || e === 'INTENTO DE ENTREGA') byCarrier[t].novedad++;
    if (e.includes('OFICINA') || e.includes('RECLAME')) byCarrier[t].oficina++;
  });
  return Object.entries(byCarrier).map(([carrier, d]) => ({
    carrier,
    ...d,
    efectividad: d.total > 0 ? Math.round(d.entregado / d.total * 100) : 0,
    devolRate: d.total > 0 ? Math.round(d.devol / d.total * 100) : 0,
  })).sort((a, b) => b.total - a.total);
}

/** Toxic cities */
export interface ToxicCity {
  city: string;
  total: number;
  devol: number;
  novedad: number;
  oficina: number;
  risk: number;
}

export function calcToxicCities(orders: Array<{ estado: string; ciudad: string }>): ToxicCity[] {
  const byCity: Record<string, { total: number; devol: number; novedad: number; oficina: number }> = {};
  orders.forEach(o => {
    const c = o.ciudad || '';
    if (!c) return;
    if (!byCity[c]) byCity[c] = { total: 0, devol: 0, novedad: 0, oficina: 0 };
    byCity[c].total++;
    const e = o.estado.toUpperCase();
    if (e.includes('DEVOL')) byCity[c].devol++;
    if (e === 'NOVEDAD' || e === 'INTENTO DE ENTREGA') byCity[c].novedad++;
    if (e.includes('OFICINA') || e.includes('RECLAME')) byCity[c].oficina++;
  });
  return Object.entries(byCity)
    .filter(([, d]) => d.total >= 3)
    .map(([city, d]) => ({
      city,
      ...d,
      risk: d.total > 0 ? Math.round((d.devol + d.oficina) / d.total * 100) : 0,
    }))
    .sort((a, b) => b.risk - a.risk);
}

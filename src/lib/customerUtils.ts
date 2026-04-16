/**
 * Pure utility functions for customer history analysis.
 * Extracted for testability — no DB, no React.
 */

export type BadgeKind = 'vip' | 'risk' | 'recurrent';

export interface CustomerBadge {
  kind: BadgeKind;
  label: string;
  className: string;
}

export function calcBadge(total: number, entregados: number, devoluciones: number): CustomerBadge | null {
  if (total < 3) return null;
  const effectiveness = (entregados / total) * 100;
  if (effectiveness >= 80) {
    return { kind: 'vip', label: '⭐ CLIENTE VIP', className: 'bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/20' };
  }
  if (effectiveness < 50 && devoluciones >= 2) {
    return { kind: 'risk', label: '⚠️ RIESGO — devuelve seguido', className: 'bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20' };
  }
  if (total >= 5) {
    return { kind: 'recurrent', label: 'Cliente recurrente', className: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20' };
  }
  return null;
}

export function estadoColor(estado: string | null): string {
  if (!estado) return 'bg-muted text-muted-foreground';
  const e = estado.toUpperCase();
  if (e === 'ENTREGADO') return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20';
  if (e.includes('DEVOL')) return 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20';
  if (e === 'NOVEDAD' || e.includes('INTENTO DE ENTREGA')) return 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border border-orange-500/20';
  if (e.includes('OFICINA') || e.includes('RECLAME')) return 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border border-yellow-500/20';
  if (e === 'PENDIENTE CONFIRMACION') return 'bg-gray-500/10 text-gray-600 dark:text-gray-400 border border-gray-500/20';
  return 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20';
}

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { CheckCircle2, ListChecks, Hourglass, Users } from 'lucide-react';
import { bogotaToday } from '@/lib/utils';

/**
 * Barra de productividad para Seguimiento y Rescate, equivalente a
 * CounterBar pero contando touchpoints por módulo.
 *
 * Muestra para el día actual:
 * - Mis acciones (cuántos pedidos toqué)
 * - Mis resueltos (Resuelto/Devolucion solicitada/Solicite devolucion)
 * - Mis pendientes (acciones que no son resolutivas)
 * - Tasa de resolución personal
 * - Total del equipo (referencia)
 *
 * Realtime: se actualiza apenas se inserta un touchpoint nuevo.
 */

const RESOLVING_LABELS = new Set([
  'Resuelto',
  'Devolucion solicitada',
  'Solicite devolucion',
]);

interface Stats {
  myActions: number;
  myResolved: number;
  teamActions: number;
  teamResolved: number;
}

interface Props {
  module: 'SEG' | 'RESCUE';
}

export default function SegRescueCounterBar({ module }: Props) {
  const { user } = useAuth();
  const [stats, setStats] = useState<Stats>({
    myActions: 0,
    myResolved: 0,
    teamActions: 0,
    teamResolved: 0,
  });

  const refetch = useCallback(async () => {
    if (!user) return;
    const today = bogotaToday();
    const prefix = module === 'SEG' ? 'SEG:' : 'RESCUE:';
    const { data, error } = await supabase
      .from('touchpoints')
      .select('action, operator_id')
      .eq('action_date', today)
      .like('action', `${prefix}%`);
    if (error || !data) return;
    let mA = 0, mR = 0, tA = 0, tR = 0;
    data.forEach(t => {
      const clean = t.action.replace(/^(SEG|RESCUE):\s*/, '');
      const isResolving = RESOLVING_LABELS.has(clean);
      tA++;
      if (isResolving) tR++;
      if (t.operator_id === user.id) {
        mA++;
        if (isResolving) mR++;
      }
    });
    setStats({ myActions: mA, myResolved: mR, teamActions: tA, teamResolved: tR });
  }, [user, module]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  // Realtime: cuando cualquier operadora inserta un touchpoint, refresca
  // las stats. Debounce ligero para evitar ráfagas.
  useEffect(() => {
    if (!user) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const debounced = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void refetch(); }, 400);
    };
    const channel = supabase
      .channel(`tp-stats-${module}-${user.id}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'touchpoints' },
        debounced,
      )
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [user, module, refetch]);

  if (!user) return null;

  const pendientes = Math.max(0, stats.myActions - stats.myResolved);
  const tasa = stats.myActions > 0
    ? Math.round((stats.myResolved / stats.myActions) * 100)
    : 0;

  // La barra se muestra siempre (incluso al inicio del día con ceros)
  // para que la operadora sepa que la herramienta está ahí desde el
  // primer minuto.

  const tasaTone =
    tasa >= 50 ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/25'
    : tasa >= 25 ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/25'
    : 'bg-muted/60 text-muted-foreground border-border';

  return (
    <div className="bg-card border border-border rounded-2xl p-3.5 mb-4 flex items-center gap-4 flex-wrap shadow-ds-xs">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5 text-sm" aria-label={`Mis acciones hoy: ${stats.myActions}`}>
          <div className="w-6 h-6 rounded-lg bg-blue-500/10 border border-blue-500/25 flex items-center justify-center">
            <ListChecks size={13} className="text-blue-500" aria-hidden="true" />
          </div>
          <span className="font-mono text-sm font-bold text-foreground tabular-nums">{stats.myActions}</span>
          <span className="text-xs text-muted-foreground">acciones</span>
        </div>
        <div className="flex items-center gap-1.5 text-sm" aria-label={`Resueltos hoy: ${stats.myResolved}`}>
          <div className="w-6 h-6 rounded-lg bg-emerald-500/10 border border-emerald-500/25 flex items-center justify-center">
            <CheckCircle2 size={13} className="text-emerald-500" aria-hidden="true" />
          </div>
          <span className="font-mono text-sm font-bold text-foreground tabular-nums">{stats.myResolved}</span>
          <span className="text-xs text-muted-foreground">resueltos</span>
        </div>
        <div className="flex items-center gap-1.5 text-sm" aria-label={`Pendientes hoy: ${pendientes}`}>
          <div className="w-6 h-6 rounded-lg bg-amber-500/10 border border-amber-500/25 flex items-center justify-center">
            <Hourglass size={13} className="text-amber-500" aria-hidden="true" />
          </div>
          <span className="font-mono text-sm font-bold text-foreground tabular-nums">{pendientes}</span>
          <span className="text-xs text-muted-foreground">pendientes</span>
        </div>
      </div>
      <div className="flex items-center gap-2 ml-auto">
        <span className={`text-[11px] font-semibold px-2 py-1 rounded-md border tabular-nums ${tasaTone}`}>
          Resolución {tasa}%
        </span>
        <div className="hidden sm:flex items-center gap-1.5 text-xs text-muted-foreground border-l border-border pl-3">
          <Users size={12} aria-hidden="true" />
          <span>Equipo</span>
          <span className="font-mono font-bold text-foreground tabular-nums">{stats.teamActions}</span>
          <span>/</span>
          <span className="font-mono text-emerald-500 tabular-nums">{stats.teamResolved}</span>
          <span>resueltos</span>
        </div>
      </div>
    </div>
  );
}

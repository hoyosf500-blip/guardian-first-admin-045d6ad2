import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useStore } from '@/contexts/StoreContext';
import { CheckCircle2, ListChecks, Hourglass, Users } from 'lucide-react';
import { bogotaToday } from '@/lib/utils';
import { isSegCloser } from '@/lib/segDailyReview';

/**
 * Barra de productividad para Seguimiento. Cuenta touchpoints "SEG:*"
 * del día. Realtime: refresca al insertarse un touchpoint nuevo.
 *
 * Antes era SegRescueCounterBar y soportaba módulo "RESCUE"; el módulo
 * Rescate se eliminó (2026-05-08) y las listas SLA de /seguimiento ya
 * cubren los casos. Esto quedó single-purpose.
 *
 * "Resuelto" cuenta los cierres (Resuelto/Devolución) vía isSegCloser, que
 * también reconoce los labels viejos para los touchpoints históricos.
 */

interface Stats {
  myActions: number;
  myResolved: number;
  teamActions: number;
  teamResolved: number;
}

export default function SegCounterBar() {
  const { user, isAdmin } = useAuth();
  const { activeStoreId } = useStore();
  const [stats, setStats] = useState<Stats>({
    myActions: 0, myResolved: 0, teamActions: 0, teamResolved: 0,
  });

  const refetch = useCallback(async () => {
    if (!user || !activeStoreId) return;
    const today = bogotaToday();
    const { data, error } = await supabase
      .from('touchpoints')
      .select('action, operator_id')
      .eq('action_date', today)
      .eq('store_id', activeStoreId)
      .like('action', 'SEG:%');
    if (error || !data) return;
    let mA = 0, mR = 0, tA = 0, tR = 0;
    data.forEach(t => {
      const isResolving = isSegCloser(t.action);
      tA++;
      if (isResolving) tR++;
      if (t.operator_id === user.id) {
        mA++;
        if (isResolving) mR++;
      }
    });
    setStats({ myActions: mA, myResolved: mR, teamActions: tA, teamResolved: tR });
  }, [user, activeStoreId]);

  useEffect(() => { void refetch(); }, [refetch]);

  useEffect(() => {
    if (!user || !activeStoreId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const debounced = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void refetch(); }, 400);
    };
    const channel = supabase
      .channel(`tp-stats-seg-${user.id}-${activeStoreId}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'touchpoints', filter: `store_id=eq.${activeStoreId}` },
        debounced,
      )
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [user, activeStoreId, refetch]);

  if (!user || isAdmin) return null;

  const pendientes = Math.max(0, stats.myActions - stats.myResolved);
  const tasa = stats.myActions > 0 ? Math.round((stats.myResolved / stats.myActions) * 100) : 0;
  const tasaTone =
    tasa >= 50 ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/25'
    : tasa >= 25 ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/25'
    : 'bg-muted/60 text-muted-foreground border-border';

  return (
    <div className="bg-card border border-border rounded-2xl p-3.5 mb-4 flex items-center gap-4 flex-wrap shadow-ds-xs">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5 text-sm">
          <div className="w-6 h-6 rounded-lg bg-blue-500/10 border border-blue-500/25 flex items-center justify-center">
            <ListChecks size={13} className="text-blue-500" aria-hidden="true" />
          </div>
          <span className="font-mono text-sm font-bold text-foreground tabular-nums">{stats.myActions}</span>
          <span className="text-xs text-muted-foreground">acciones</span>
        </div>
        <div className="flex items-center gap-1.5 text-sm">
          <div className="w-6 h-6 rounded-lg bg-emerald-500/10 border border-emerald-500/25 flex items-center justify-center">
            <CheckCircle2 size={13} className="text-emerald-500" aria-hidden="true" />
          </div>
          <span className="font-mono text-sm font-bold text-foreground tabular-nums">{stats.myResolved}</span>
          <span className="text-xs text-muted-foreground">resueltos</span>
        </div>
        <div className="flex items-center gap-1.5 text-sm">
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

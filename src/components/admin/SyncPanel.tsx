import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useStore } from '@/contexts/StoreContext';
import { RefreshCw, Loader2, Calendar, ArrowDownToLine } from 'lucide-react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { Progress } from '@/components/ui/progress';
import { TiltCard } from '@/components/ui3d';

const fadeUp = { initial: { opacity: 0, y: 16 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.35, ease: 'easeOut' } };

export default function SyncPanel({ onSyncComplete }: { onSyncComplete?: () => void }) {
  const { activeStore, activeStoreId, isOwnerOfActive } = useStore();
  const [syncing, setSyncing] = useState(false);
  const [fromDate, setFromDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [toDate, setToDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [lastResult, setLastResult] = useState<{ synced: number; duplicates: number; total: number; chunks?: number } | null>(null);

  async function handleSync() {
    if (!activeStoreId) { toast.error('Sin tienda activa'); return; }
    if (!isOwnerOfActive) { toast.error('Solo el dueño de la tienda puede sincronizar'); return; }
    setSyncing(true);
    setLastResult(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { toast.error('No hay sesión activa'); return; }

      const res = await supabase.functions.invoke('dropi-sync', {
        body: { from: fromDate, untill: toDate, store_id: activeStoreId },
      });

      if (res.error) {
        toast.error(`Error: ${res.error.message}`);
      } else if (res.data?.error) {
        toast.error(res.data.error);
      } else {
        const r = res.data;
        setLastResult({ synced: r.synced ?? 0, duplicates: r.duplicates ?? 0, total: r.total ?? 0, chunks: r.chunks });
        toast.success(r.message || `${r.synced} pedidos sincronizados`);
        onSyncComplete?.();
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Error de sincronización');
    } finally {
      setSyncing(false);
    }
  }

  return (
    <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.05 }} className="md:col-span-2">
    <TiltCard className="bg-card/40 border border-border rounded-2xl shadow-card3d">
      <div className="px-5 py-4 border-b border-border flex items-center gap-2.5">
        <span className="w-9 h-9 rounded-xl bg-info/14 border border-info/30 text-info glow-info flex items-center justify-center flex-shrink-0" aria-hidden="true">
          <ArrowDownToLine size={15} />
        </span>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-foreground">Sincronizar pedidos de Dropi</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Tienda activa: <span className="font-medium text-foreground">{activeStore?.name ?? '—'}</span>
            {activeStore?.country_code ? ` (${activeStore.country_code})` : ''}
          </p>
        </div>
        {syncing && (
          <span className="flex-shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-info/14 border border-info/30 text-info">
            EN PROCESO
          </span>
        )}
      </div>

      <div className="px-5 py-4 flex flex-wrap gap-3 items-end">
        <div className="flex flex-col gap-1">
          <label className="hud-label" htmlFor="sync-from-date">Desde</label>
          <div className="relative">
            <Calendar size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <input
              id="sync-from-date"
              type="date"
              value={fromDate}
              onChange={e => setFromDate(e.target.value)}
              className="h-9 rounded-xl border border-border bg-card/40 pl-7 pr-3 text-xs font-mono tabular-nums text-foreground focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <label className="hud-label" htmlFor="sync-to-date">Hasta</label>
          <div className="relative">
            <Calendar size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <input
              id="sync-to-date"
              type="date"
              value={toDate}
              onChange={e => setToDate(e.target.value)}
              className="h-9 rounded-xl border border-border bg-card/40 pl-7 pr-3 text-xs font-mono tabular-nums text-foreground focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
          </div>
        </div>
        <button
          onClick={handleSync}
          disabled={syncing || !activeStoreId}
          className="btn-accent-3d h-9 px-4 rounded-xl text-sm font-semibold flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {syncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          {syncing ? 'Sincronizando…' : 'Sincronizar'}
        </button>
      </div>

      {syncing && (
        <div className="px-5 pb-3">
          <Progress value={undefined} className="h-1.5" />
          <p className="text-[10px] text-muted-foreground mt-1">Descargando y actualizando pedidos…</p>
        </div>
      )}

      {lastResult && (
        <div className="px-5 pb-4 flex gap-4 text-xs">
          <span className="text-success font-semibold font-mono tabular-nums">{lastResult.synced} sincronizados</span>
          <span className="text-muted-foreground font-mono tabular-nums">{lastResult.total} total Dropi</span>
          {lastResult.chunks && lastResult.chunks > 1 && (
            <span className="text-muted-foreground font-mono tabular-nums">{lastResult.chunks} chunks</span>
          )}
        </div>
      )}
    </TiltCard>
    </motion.div>
  );
}

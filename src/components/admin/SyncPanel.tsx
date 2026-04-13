import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { RefreshCw, Loader2, Calendar, ArrowDownToLine } from 'lucide-react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';

const fadeUp = { initial: { opacity: 0, y: 16 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.35, ease: 'easeOut' } };

export default function SyncPanel({ onSyncComplete }: { onSyncComplete?: () => void }) {
  const [syncing, setSyncing] = useState(false);
  const [fromDate, setFromDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [toDate, setToDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [lastResult, setLastResult] = useState<{ synced: number; duplicates: number; total: number } | null>(null);

  async function handleSync() {
    setSyncing(true);
    setLastResult(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { toast.error('No hay sesión activa'); return; }

      const res = await supabase.functions.invoke('dropi-sync', {
        body: { from: fromDate, untill: toDate },
      });

      if (res.error) {
        toast.error(`Error: ${res.error.message}`);
      } else if (res.data?.error) {
        toast.error(res.data.error);
      } else {
        const r = res.data;
        setLastResult({ synced: r.synced ?? 0, duplicates: r.duplicates ?? 0, total: r.total ?? 0 });
        toast.success(r.message || `${r.synced} pedidos sincronizados`);
        onSyncComplete?.();
      }
    } catch (err: any) {
      toast.error(err.message || 'Error de sincronización');
    } finally {
      setSyncing(false);
    }
  }

  return (
    <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.05 }} className="bg-card rounded-xl border border-border overflow-hidden md:col-span-2">
      <div className="px-5 py-4 border-b border-border flex items-center gap-2">
        <ArrowDownToLine size={16} className="text-primary" />
        <div>
          <h3 className="text-sm font-semibold text-foreground">Sincronizar pedidos de Dropi</h3>
          <p className="text-xs text-muted-foreground mt-0.5">Importa pedidos desde Dropi por rango de fechas</p>
        </div>
      </div>
      <div className="px-5 py-4 flex flex-wrap gap-3 items-end">
        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Desde</label>
          <div className="relative">
            <Calendar size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <input
              type="date"
              value={fromDate}
              onChange={e => setFromDate(e.target.value)}
              className="h-9 rounded-lg border border-border bg-background pl-7 pr-3 text-xs font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Hasta</label>
          <div className="relative">
            <Calendar size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <input
              type="date"
              value={toDate}
              onChange={e => setToDate(e.target.value)}
              className="h-9 rounded-lg border border-border bg-background pl-7 pr-3 text-xs font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
        </div>
        <button
          onClick={handleSync}
          disabled={syncing}
          className="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium flex items-center gap-2 hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {syncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          {syncing ? 'Sincronizando…' : 'Sincronizar'}
        </button>
      </div>
      {lastResult && (
        <div className="px-5 pb-4 flex gap-4 text-xs">
          <span className="text-green font-medium">{lastResult.synced} nuevos</span>
          <span className="text-muted-foreground">{lastResult.duplicates} duplicados</span>
          <span className="text-muted-foreground">{lastResult.total} total en Dropi</span>
        </div>
      )}
    </motion.div>
  );
}

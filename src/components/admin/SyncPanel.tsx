import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { RefreshCw, Loader2, Calendar, ArrowDownToLine, Globe } from 'lucide-react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { Progress } from '@/components/ui/progress';

const fadeUp = { initial: { opacity: 0, y: 16 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.35, ease: 'easeOut' } };

export default function SyncPanel({ onSyncComplete }: { onSyncComplete?: () => void }) {
  const [syncing, setSyncing] = useState(false);
  const [fromDate, setFromDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [toDate, setToDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [lastResult, setLastResult] = useState<{ synced: number; duplicates: number; total: number; chunks?: number } | null>(null);
  const [storeUrl, setStoreUrl] = useState('');
  const [storeUrlSaved, setStoreUrlSaved] = useState(false);

  useEffect(() => {
    supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'dropi_store_url')
      .maybeSingle()
      .then(({ data }) => {
        if (data?.value) {
          setStoreUrl(data.value);
          setStoreUrlSaved(true);
        }
      });
  }, []);

  async function saveStoreUrl() {
    if (!storeUrl.trim()) return;
    const { error } = await supabase
      .from('app_settings')
      .upsert({ key: 'dropi_store_url', value: storeUrl.trim() }, { onConflict: 'key' });
    if (error) {
      toast.error('Error guardando URL');
    } else {
      setStoreUrlSaved(true);
      toast.success('URL de tienda guardada');
    }
  }

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
        setLastResult({ synced: r.synced ?? 0, duplicates: r.duplicates ?? 0, total: r.total ?? 0, chunks: r.chunks });
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
          <p className="text-xs text-muted-foreground mt-0.5">Importa y actualiza pedidos desde Dropi por rango de fechas</p>
        </div>
      </div>

      {/* Store URL config */}
      {!storeUrlSaved && (
        <div className="px-5 py-3 border-b border-border bg-muted/30">
          <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1 mb-1.5">
            <Globe size={10} /> URL de tu tienda Dropi (requerido)
          </label>
          <div className="flex gap-2">
            <input
              type="url"
              value={storeUrl}
              onChange={e => setStoreUrl(e.target.value)}
              placeholder="https://tutienda.dropi.co"
              className="flex-1 h-8 rounded-lg border border-border bg-background px-3 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            <button
              onClick={saveStoreUrl}
              className="h-8 px-3 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
            >
              Guardar
            </button>
          </div>
        </div>
      )}

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

      {syncing && (
        <div className="px-5 pb-3">
          <Progress value={undefined} className="h-1.5" />
          <p className="text-[10px] text-muted-foreground mt-1">Descargando y actualizando pedidos…</p>
        </div>
      )}

      {lastResult && (
        <div className="px-5 pb-4 flex gap-4 text-xs">
          <span className="text-green-500 font-medium">{lastResult.synced} sincronizados</span>
          <span className="text-muted-foreground">{lastResult.total} total Dropi</span>
          {lastResult.chunks && lastResult.chunks > 1 && (
            <span className="text-muted-foreground">{lastResult.chunks} chunks</span>
          )}
        </div>
      )}

      {storeUrlSaved && (
        <div className="px-5 pb-3">
          <button
            onClick={() => setStoreUrlSaved(false)}
            className="text-[10px] text-muted-foreground hover:text-foreground transition-colors underline"
          >
            Cambiar URL de tienda ({storeUrl})
          </button>
        </div>
      )}
    </motion.div>
  );
}

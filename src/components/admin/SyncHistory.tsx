import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useStore } from '@/contexts/StoreContext';
import { History, CheckCircle2, XCircle, RefreshCw } from 'lucide-react';
import { motion } from 'framer-motion';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { TiltCard } from '@/components/ui3d';

interface SyncLog {
  id: string;
  source: string;
  status: string;
  synced_count: number;
  duplicates_count: number;
  total_count: number;
  error_message: string | null;
  created_at: string;
}

const fadeUp = { initial: { opacity: 0, y: 16 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.35, ease: 'easeOut' } };

export default function SyncHistory() {
  const { activeStoreId } = useStore();
  const [logs, setLogs] = useState<SyncLog[]>([]);
  const [loading, setLoading] = useState(true);

  // Recarga al cambiar de tienda — el historial es POR TIENDA.
  useEffect(() => { loadLogs(); }, [activeStoreId]);

  async function loadLogs() {
    if (!activeStoreId) { setLogs([]); setLoading(false); return; }
    setLoading(true);
    const { data } = await supabase
      .from('sync_logs')
      .select('*')
      .eq('store_id', activeStoreId)
      .order('created_at', { ascending: false })
      .limit(20);
    setLogs((data as SyncLog[]) || []);
    setLoading(false);
  }

  return (
    <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.1 }} className="md:col-span-2">
    <TiltCard className="bg-card/40 border border-border rounded-2xl shadow-card3d">
      <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="w-8 h-8 rounded-xl bg-accent/14 border border-accent/30 text-accent flex items-center justify-center flex-shrink-0" aria-hidden="true">
            <History size={15} />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">Historial de sincronizaciones</h3>
            <p className="text-xs text-muted-foreground mt-0.5"><span className="font-mono tabular-nums">{logs.length}</span> registros</p>
          </div>
        </div>
        <button onClick={loadLogs} className="h-8 w-8 rounded-xl border border-border bg-card/40 flex items-center justify-center text-muted-foreground hover:text-foreground hover:border-border-strong transition-colors flex-shrink-0">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {loading ? (
        <div className="p-5 space-y-2">
          {[1, 2, 3].map(i => <div key={i} className="h-12 rounded-xl skeleton-shimmer" />)}
        </div>
      ) : logs.length === 0 ? (
        <div className="p-8 text-center text-sm text-muted-foreground">No hay sincronizaciones registradas</div>
      ) : (
        <div className="p-3 space-y-2 max-h-80 overflow-y-auto">
          {logs.map(log => (
            <div key={log.id} className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl bg-card/40 border border-border hover:border-border-strong transition-colors">
              <div className="flex items-center gap-3 min-w-0">
                {log.status === 'success' ? (
                  <div className="w-8 h-8 rounded-xl bg-success/14 border border-success/30 flex items-center justify-center flex-shrink-0">
                    <CheckCircle2 size={14} className="text-success" />
                  </div>
                ) : (
                  <div className="w-8 h-8 rounded-xl bg-danger/14 border border-danger/30 flex items-center justify-center flex-shrink-0">
                    <XCircle size={14} className="text-danger" />
                  </div>
                )}
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground font-mono tabular-nums">
                    {log.status === 'success'
                      ? `${log.synced_count} sincronizados`
                      : 'Error'}
                  </div>
                  <div className="text-[10px] text-muted-foreground font-mono tabular-nums">
                    {format(new Date(log.created_at), "d MMM yyyy, HH:mm", { locale: es })}
                  </div>
                </div>
              </div>
              <div className="text-right flex-shrink-0">
                <div className="text-xs font-mono tabular-nums text-muted-foreground">
                  {log.total_count} total
                  {log.duplicates_count > 0 && (
                    <span className="ml-1.5 text-warning">• {log.duplicates_count} dup</span>
                  )}
                </div>
                {log.error_message && (
                  <div className="text-[10px] text-danger max-w-[200px] truncate">{log.error_message}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </TiltCard>
    </motion.div>
  );
}

import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useStore } from '@/contexts/StoreContext';
import { History, CheckCircle2, XCircle, RefreshCw } from 'lucide-react';
import { motion } from 'framer-motion';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';

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
    <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.1 }} className="bg-card rounded-xl border border-border overflow-hidden md:col-span-2">
      <div className="px-5 py-4 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <History size={16} className="text-primary" />
          <div>
            <h3 className="text-sm font-semibold text-foreground">Historial de sincronizaciones</h3>
            <p className="text-xs text-muted-foreground mt-0.5">{logs.length} registros</p>
          </div>
        </div>
        <button onClick={loadLogs} className="h-7 w-7 rounded-lg border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {loading ? (
        <div className="p-5 space-y-2">
          {[1, 2, 3].map(i => <div key={i} className="h-12 rounded-lg skeleton-shimmer" />)}
        </div>
      ) : logs.length === 0 ? (
        <div className="p-8 text-center text-sm text-muted-foreground">No hay sincronizaciones registradas</div>
      ) : (
        <div className="divide-y divide-border max-h-80 overflow-y-auto">
          {logs.map(log => (
            <div key={log.id} className="flex items-center justify-between px-5 py-3">
              <div className="flex items-center gap-3">
                {log.status === 'success' ? (
                  <div className="w-7 h-7 rounded-full bg-green/10 flex items-center justify-center">
                    <CheckCircle2 size={14} className="text-green" />
                  </div>
                ) : (
                  <div className="w-7 h-7 rounded-full bg-red/10 flex items-center justify-center">
                    <XCircle size={14} className="text-red" />
                  </div>
                )}
                <div>
                  <div className="text-sm font-medium text-foreground">
                    {log.status === 'success'
                      ? `${log.synced_count} sincronizados`
                      : 'Error'}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {format(new Date(log.created_at), "d MMM yyyy, HH:mm", { locale: es })}
                  </div>
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs font-mono text-muted-foreground">
                  {log.total_count} total
                  {log.duplicates_count > 0 && (
                    <span className="ml-1.5 text-orange">• {log.duplicates_count} dup</span>
                  )}
                </div>
                {log.error_message && (
                  <div className="text-[10px] text-red max-w-[200px] truncate">{log.error_message}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </motion.div>
  );
}

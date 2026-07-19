import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useStore } from '@/contexts/StoreContext';
import { History, CheckCircle2, XCircle, RefreshCw } from 'lucide-react';
import { motion } from 'framer-motion';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { TiltCard, Sparkline } from '@/components/ui3d';

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

  // Serie de `synced_count` de las corridas EXITOSAS, en orden cronológico (los
  // logs vienen del más nuevo al más viejo). Solo 'success': una corrida con
  // error no trae 0 pedidos, no trae NADA — dibujarla como 0 sería inventar un
  // cero medido. Sparkline no dibuja con menos de 2 puntos.
  const syncedSeries = logs
    .filter(l => l.status === 'success')
    .map(l => l.synced_count)
    .reverse();

  // Techo de la serie para la barra proporcional de cada fila: cuánto trajo esta
  // corrida contra la mejor del historial visible.
  const maxSynced = syncedSeries.length > 0 ? Math.max(...syncedSeries) : 0;

  return (
    <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.1 }} className="md:col-span-2">
    <TiltCard className="bg-card/40 border border-border rounded-2xl shadow-card3d">
      <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <span className="w-9 h-9 rounded-xl bg-accent/14 border border-accent/30 text-accent glow-accent flex items-center justify-center flex-shrink-0" aria-hidden="true">
            <History size={17} />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">Historial de sincronizaciones</h3>
            <p className="text-xs text-muted-foreground mt-0.5"><span className="font-mono tabular-nums">{logs.length}</span> registros</p>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          {/* El pulso del sync: cuántos pedidos trajo cada corrida exitosa, de la
              más vieja a la más nueva. Solo se dibuja con 2+ corridas. */}
          {syncedSeries.length > 1 && (
            <div className="hidden sm:block w-28" title="Pedidos sincronizados por corrida exitosa (de la más vieja a la más nueva)">
              <Sparkline data={syncedSeries} color="hsl(var(--success))" height={26} />
            </div>
          )}
          <button onClick={loadLogs} aria-label="Refrescar historial" className="h-9 w-9 rounded-xl border border-border bg-card/40 flex items-center justify-center text-muted-foreground hover:text-foreground hover:border-border-strong transition-colors flex-shrink-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} aria-hidden="true" />
          </button>
        </div>
      </div>

      {loading ? (
        <div className="p-5 space-y-2">
          {[1, 2, 3].map(i => <div key={i} className="h-12 rounded-xl skeleton-shimmer" />)}
        </div>
      ) : logs.length === 0 ? (
        <div className="p-8 text-center text-sm text-muted-foreground">No hay sincronizaciones registradas</div>
      ) : (
        <div className="p-3 space-y-2 max-h-80 overflow-y-auto">
          {logs.map(log => {
            const ok = log.status === 'success';
            // Ancho relativo a la mejor corrida del historial visible. Sin techo
            // (o corrida con error) no se dibuja barra: no hay proporción que
            // mostrar y una barra vacía se leería como "trajo cero".
            const width = ok && maxSynced > 0
              ? Math.max(0, Math.min(100, (log.synced_count / maxSynced) * 100))
              : null;
            return (
              <div key={log.id} className="flex flex-col gap-2 px-3 py-2.5 rounded-xl bg-card/40 border border-border hover:border-border-strong transition-colors duration-200">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    {ok ? (
                      <div className="w-9 h-9 rounded-xl bg-success/14 border border-success/30 glow-success flex items-center justify-center flex-shrink-0" aria-hidden="true">
                        <CheckCircle2 size={16} className="text-success" />
                      </div>
                    ) : (
                      <div className="w-9 h-9 rounded-xl bg-danger/14 border border-danger/30 glow-danger flex items-center justify-center flex-shrink-0" aria-hidden="true">
                        <XCircle size={16} className="text-danger" />
                      </div>
                    )}
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-foreground font-mono tabular-nums">
                        {ok ? `${log.synced_count} sincronizados` : 'Error'}
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
                {width !== null && (
                  <div className="h-1 rounded-full bg-foreground/10 overflow-hidden">
                    <div
                      className="h-full rounded-full transition-[width] duration-700"
                      style={{ width: `${width}%`, background: 'hsl(var(--success))' }}
                      aria-hidden="true"
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </TiltCard>
    </motion.div>
  );
}

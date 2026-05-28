import { useEffect, useState, useCallback } from 'react';
import { CheckCircle2, AlertTriangle, WifiOff, RefreshCw } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useStore } from '@/contexts/StoreContext';
import { toast } from 'sonner';

/**
 * Banner de salud del sync por tienda. 3 estados:
 *  - verde:   última sync 'success' con synced_count>0 en últimas 24h
 *  - amarillo: todas las corridas de la última hora con synced_count=0 OR
 *              status='warn' (zombie detectado por dropi-cron)
 *  - rojo:    última sync 'error' O > 60 min sin attempt
 *
 * Crítico: el amarillo es la pieza que NO existía antes — del 21/05 al 28/05
 * todo decía verde "hace 5 min" mientras el cron devolvía 0 silenciosamente.
 */

type Color = 'green' | 'yellow' | 'red';

interface LogRow {
  status: string;
  synced_count: number;
  total_count: number;
  created_at: string;
  error_message: string | null;
}

interface Props {
  /** Callback opcional para abrir el modal de auditoría desde el banner amarillo. */
  onAuditClick?: () => void;
}

export default function SyncFreshness({ onAuditClick }: Props) {
  const { activeStoreId, isManagerOfActive } = useStore();
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(async () => {
    if (!activeStoreId) return;
    setLoading(true);
    const { data } = await supabase
      .from('sync_logs')
      .select('status, synced_count, total_count, created_at, error_message')
      .eq('store_id', activeStoreId)
      .order('created_at', { ascending: false })
      .limit(12);
    setLogs((data as LogRow[]) || []);
    setLoading(false);
  }, [activeStoreId]);

  useEffect(() => {
    void load();
    const id = setInterval(() => { void load(); }, 60_000);
    return () => clearInterval(id);
  }, [load]);

  const handleRetry = async () => {
    if (retrying) return;
    setRetrying(true);
    const t = toast.loading('Disparando sync manual…');
    try {
      const { error } = await supabase.functions.invoke('dropi-cron', { body: {} });
      if (error) throw error;
      toast.success('Sync disparado — refrescando en 5s', { id: t });
      setTimeout(() => { void load(); }, 5000);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo disparar', { id: t });
    } finally {
      setRetrying(false);
    }
  };

  if (!activeStoreId || logs.length === 0) return null;

  const now = Date.now();
  const last = logs[0];
  const lastAttemptAgeMin = (now - new Date(last.created_at).getTime()) / 60000;
  const lastSuccess = logs.find((l) => l.status === 'success' && l.synced_count > 0);
  const lastSuccessAgeHrs = lastSuccess
    ? (now - new Date(lastSuccess.created_at).getTime()) / 3600000
    : Infinity;
  const recentHour = logs.filter(
    (l) => (now - new Date(l.created_at).getTime()) / 60000 < 60,
  );
  const recentAllZeroOrWarn = recentHour.length > 0
    && recentHour.every((l) => l.synced_count === 0 || l.status === 'warn');
  const lastIsError = last.status === 'error';

  let color: Color;
  if (lastIsError || lastAttemptAgeMin > 60) color = 'red';
  else if (recentAllZeroOrWarn || lastSuccessAgeHrs > 24) color = 'yellow';
  else color = 'green';

  // Verde es discreto — solo un punto + tooltip. Amarillo/rojo son banners.
  if (color === 'green') {
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
        title={`Última sync hace ${Math.round(lastAttemptAgeMin)} min · ${lastSuccess?.synced_count ?? 0} cambios`}>
        <span className="w-1.5 h-1.5 rounded-full bg-success" aria-hidden />
        <span>Sync OK</span>
      </div>
    );
  }

  if (color === 'yellow') {
    return (
      <div className="rounded-lg border border-warning/40 bg-warning/8 px-3 py-2 flex items-center gap-3">
        <AlertTriangle size={16} className="text-warning flex-shrink-0" aria-hidden />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-warning">Sync corriendo pero sin novedades</p>
          <p className="text-[11px] text-muted-foreground">
            Las últimas {recentHour.length} corridas no trajeron cambios. ¿Sospechás datos viejos?
          </p>
        </div>
        {onAuditClick && isManagerOfActive && (
          <button
            onClick={onAuditClick}
            className="text-xs font-semibold text-warning hover:underline whitespace-nowrap cursor-pointer"
          >
            Auditar paridad →
          </button>
        )}
      </div>
    );
  }

  // red
  return (
    <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 flex items-center gap-3">
      <WifiOff size={16} className="text-destructive flex-shrink-0" aria-hidden />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold text-destructive">
          {lastIsError ? 'Sync con error' : `Sin sync hace ${Math.round(lastAttemptAgeMin)} min`}
        </p>
        {last.error_message && (
          <p className="text-[11px] text-muted-foreground truncate" title={last.error_message}>
            {last.error_message}
          </p>
        )}
      </div>
      {isManagerOfActive && (
        <button
          onClick={handleRetry}
          disabled={retrying || loading}
          className="inline-flex items-center gap-1 text-xs font-semibold text-destructive hover:underline whitespace-nowrap cursor-pointer disabled:opacity-50"
        >
          {retrying ? <RefreshCw size={11} className="animate-spin" /> : null}
          Reintentar manual
        </button>
      )}
    </div>
  );
}

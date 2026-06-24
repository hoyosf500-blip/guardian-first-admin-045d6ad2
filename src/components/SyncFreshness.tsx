import { useEffect, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
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
  const qc = useQueryClient();
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
      // Frescura del sync de ÓRDENES = cron automático (source='dropi-cron', cada
      // 5 min) + syncs manuales (source='dropi'). ANTES filtraba solo 'dropi' →
      // ignoraba el cron y mostraba rojo falso "Sin sync hace X min" aunque el cron
      // corriera bien. Excluye wallet ('dropi-wallet-sync') y acciones por-pedido.
      .in('source', ['dropi-cron', 'dropi'])
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
    if (retrying || !activeStoreId) return;
    setRetrying(true);
    const t = toast.loading('Sincronizando pedidos…');
    try {
      // Mismo call que el botón "Sincronizar" (useResumenSync): dropi-sync para
      // ESTA tienda, store-scoped (gate = dueño), rápido (1 tienda). Escribe
      // sync_logs source='dropi' que ESTE banner sí lee → se actualiza al toque.
      // ANTES pegaba a dropi-cron: global (todas las tiendas, ~2 min), exigía
      // admin GLOBAL (los socios recibían 403 silencioso) y escribía
      // source='dropi-cron' que el banner NO leía → "no pasaba nada".
      const fmt = (d: Date) => d.toISOString().split('T')[0];
      const to = new Date();
      const from = new Date(to);
      from.setDate(from.getDate() - 30);
      const { data, error } = await supabase.functions.invoke('dropi-sync', {
        body: { store_id: activeStoreId, from: fmt(from), untill: fmt(to) },
      });
      const d = data as { error?: string; rateLimited?: boolean; message?: string } | null;
      if (error) throw new Error(error.message);
      if (d?.rateLimited) throw new Error(d.message || 'Dropi está limitando (rate limit). Probá en un minuto.');
      if (d?.error) throw new Error(d.error);
      toast.success('Pedidos sincronizados.', { id: t });
      // Refrescar el banner Y las cards del resumen (no solo la frescura).
      for (const k of ['orders-estado-breakdown', 'logistics', 'orders-sync-health', 'ganancia-neta-dropi']) {
        qc.invalidateQueries({ queryKey: [k] });
      }
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo sincronizar', { id: t });
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

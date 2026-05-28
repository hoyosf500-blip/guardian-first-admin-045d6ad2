import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useStore } from '@/contexts/StoreContext';
import { Search, Shield, Activity, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { motion } from 'framer-motion';
import DropiAuditModal from './DropiAuditModal';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';

interface AuditRow {
  id: string;
  created_at: string;
  guardian_count: number;
  dropi_count: number;
  divergences_found: number;
  divergences_applied: number;
  missing_in_dropi: number;
  notes: string | null;
}

interface HealthRow {
  last_health_status: string | null;
  last_health_checked_at: string | null;
  dropi_api_key: string | null;
  country_code: string;
}

export default function DropiParityPanel() {
  const { activeStoreId, isManagerOfActive } = useStore();
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<AuditRow[]>([]);
  const [health, setHealth] = useState<HealthRow | null>(null);

  const load = useCallback(async () => {
    if (!activeStoreId) return;
    const [h, hist] = await Promise.all([
      supabase.from('store_dropi_config')
        .select('last_health_status, last_health_checked_at, dropi_api_key, country_code')
        .eq('store_id', activeStoreId).maybeSingle(),
      supabase.from('audit_runs')
        .select('id, created_at, guardian_count, dropi_count, divergences_found, divergences_applied, missing_in_dropi, notes')
        .eq('store_id', activeStoreId).order('created_at', { ascending: false }).limit(5),
    ]);
    setHealth(h.data as HealthRow | null);
    setHistory((hist.data as AuditRow[]) || []);
  }, [activeStoreId]);

  useEffect(() => { void load(); }, [load]);

  if (!isManagerOfActive || !activeStoreId) return null;

  // Antes el gate era `dropi_session_token` (JWT web 1h, había que pegarlo a mano).
  // Ahora la edge function dropi-snapshot usa la integration-key permanente,
  // así que basta con tener api_key configurada (que es lo mínimo para que el
  // cron y health funcionen también).
  const canAudit = Boolean((health?.dropi_api_key || '').length > 0);
  const healthStatus = health?.last_health_status || 'unknown';
  const healthColor = healthStatus === 'ok' ? 'success'
    : healthStatus === 'degraded' ? 'warning'
    : healthStatus === 'down' ? 'destructive' : 'muted-foreground';
  const healthLabel = healthStatus === 'ok' ? 'Saludable'
    : healthStatus === 'degraded' ? 'Sin novedades 7d'
    : healthStatus === 'down' ? 'Caído'
    : 'Sin chequear';

  return (
    <>
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
        className="bg-card rounded-xl border border-border overflow-hidden md:col-span-2">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Shield size={16} className="text-accent" />
            <div>
              <h3 className="text-sm font-semibold text-foreground">Paridad con Dropi</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Compara Guardian vs Dropi y reconcilia divergencias. Backstop manual del cron.
              </p>
            </div>
          </div>
          <div className={`flex items-center gap-1.5 text-xs text-${healthColor}`}>
            <Activity size={12} />
            <span className="font-semibold">{healthLabel}</span>
            {health?.last_health_checked_at && (
              <span className="text-muted-foreground">
                · {format(new Date(health.last_health_checked_at), 'd MMM HH:mm', { locale: es })}
              </span>
            )}
          </div>
        </div>

        <div className="px-5 py-4 space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={() => setOpen(true)}
              disabled={!canAudit}
              title={canAudit ? '' : 'Falta dropi_api_key en Credenciales Dropi'}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-accent-foreground text-sm font-semibold hover:opacity-90 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Search size={14} /> Auditar paridad ahora
            </button>
            {!canAudit && (
              <span className="text-[11px] text-warning inline-flex items-center gap-1">
                <AlertTriangle size={11} /> Cargá la api_key de Dropi para habilitar
              </span>
            )}
          </div>

          {history.length > 0 && (
            <div className="border border-border rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-secondary text-muted-foreground">
                  <tr>
                    <th className="text-left px-3 py-2">Fecha</th>
                    <th className="text-right px-3 py-2">Guardian</th>
                    <th className="text-right px-3 py-2">Dropi</th>
                    <th className="text-right px-3 py-2">Divergencias</th>
                    <th className="text-right px-3 py-2">Aplicadas</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {history.map(r => (
                    <tr key={r.id}>
                      <td className="px-3 py-2 text-muted-foreground">
                        {format(new Date(r.created_at), "d MMM HH:mm", { locale: es })}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">{r.guardian_count}</td>
                      <td className="px-3 py-2 text-right font-mono">{r.dropi_count}</td>
                      <td className="px-3 py-2 text-right font-mono">
                        {r.divergences_found === 0
                          ? <CheckCircle2 size={12} className="text-success inline" />
                          : <span className="text-warning font-bold">{r.divergences_found}</span>}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-success">{r.divergences_applied}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </motion.div>

      <DropiAuditModal
        open={open}
        onClose={() => { setOpen(false); void load(); }}
        storeId={activeStoreId}
      />
    </>
  );
}

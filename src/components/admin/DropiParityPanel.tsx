import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useStore } from '@/contexts/StoreContext';
import { Search, Shield, Activity, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { motion } from 'framer-motion';
import DropiAuditModal from './DropiAuditModal';
import { TiltCard } from '@/components/ui3d';
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
  has_api_key: boolean;
  country_code: string;
}

export default function DropiParityPanel() {
  const { activeStoreId, isManagerOfActive } = useStore();
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<AuditRow[]>([]);
  const [health, setHealth] = useState<HealthRow | null>(null);
  // Errores de LECTURA visibles: un fallo de la query NO es "sin api_key" ni
  // "sin historial" — antes un blip de red hacía decir "Cargá la api_key"
  // con la clave puesta, contradiciendo al panel de Credenciales de al lado.
  const [cfgReadFailed, setCfgReadFailed] = useState(false);
  const [histReadFailed, setHistReadFailed] = useState(false);

  const load = useCallback(async () => {
    if (!activeStoreId) return;
    const [h, status, hist] = await Promise.all([
      // Columnas de SALUD (no secretas). La api_key permanente ya NO se baja al
      // navegador: acá sólo hace falta el booleano "¿hay clave?", y ese viene por
      // get_store_dropi_status. Bajarla era la misma exposición que filtró la
      // clave de Ecuador (quedó en un volcado del DOM). Espejo de StoreCredentialsPanel.
      supabase.from('store_dropi_config')
        .select('last_health_status, last_health_checked_at, country_code')
        .eq('store_id', activeStoreId).maybeSingle(),
      (supabase.rpc as unknown as (
        fn: string, args: Record<string, unknown>,
      ) => Promise<{ data: Array<{ has_api_key: boolean }> | null; error: { message: string } | null }>)(
        'get_store_dropi_status', { p_store_id: activeStoreId },
      ),
      supabase.from('audit_runs')
        .select('id, created_at, guardian_count, dropi_count, divergences_found, divergences_applied, missing_in_dropi, notes')
        .eq('store_id', activeStoreId).order('created_at', { ascending: false }).limit(5),
    ]);
    // Falla de CUALQUIERA de las dos lecturas de config = estado desconocido (no
    // "sin api_key"): mismo criterio que antes, ahora sobre las dos fuentes.
    setCfgReadFailed(Boolean(h.error || status.error));
    setHistReadFailed(Boolean(hist.error));
    if (h.error || status.error) {
      setHealth(null);
    } else {
      const cfg = h.data as { last_health_status: string | null; last_health_checked_at: string | null; country_code: string } | null;
      setHealth({
        last_health_status: cfg?.last_health_status ?? null,
        last_health_checked_at: cfg?.last_health_checked_at ?? null,
        country_code: cfg?.country_code ?? 'CO',
        has_api_key: Boolean(Array.isArray(status.data) ? status.data[0]?.has_api_key : false),
      });
    }
    setHistory(hist.error ? [] : ((hist.data as AuditRow[]) || []));
  }, [activeStoreId]);

  useEffect(() => { void load(); }, [load]);

  if (!isManagerOfActive || !activeStoreId) return null;

  // Antes el gate era `dropi_session_token` (JWT web 1h, había que pegarlo a mano).
  // Ahora la edge function dropi-snapshot usa la integration-key permanente,
  // así que basta con tener api_key configurada (que es lo mínimo para que el
  // cron y health funcionen también).
  const canAudit = Boolean(health?.has_api_key);
  // 'read_error' se distingue de 'unknown': "Sin chequear" es una fila leída
  // con health null (nunca corrió el check); "No se pudo leer" es que la query
  // falló y el estado real es desconocido.
  const healthStatus = cfgReadFailed ? 'read_error' : (health?.last_health_status || 'unknown');
  // 'throttled' (nuevo, auditoría EC 2026-07-07): 429/503 transitorio de Dropi,
  // NO cuenta caída — ámbar "Throttle", no rojo. Antes caía al else gris.
  const healthColor = healthStatus === 'ok' ? 'success'
    : healthStatus === 'degraded' || healthStatus === 'throttled' || healthStatus === 'read_error' ? 'warning'
    : healthStatus === 'down' ? 'destructive' : 'muted-foreground';
  const healthLabel = healthStatus === 'ok' ? 'Saludable'
    : healthStatus === 'degraded' ? 'Sin novedades 7d'
    : healthStatus === 'throttled' ? 'Throttle temporal'
    : healthStatus === 'down' ? 'Caído'
    : healthStatus === 'read_error' ? 'No se pudo leer'
    : 'Sin chequear';

  return (
    <>
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
        className="md:col-span-2">
        <TiltCard className="bg-card/40 border border-border rounded-2xl shadow-card3d">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="w-9 h-9 rounded-xl bg-accent/14 border border-accent/30 text-accent glow-accent flex items-center justify-center flex-shrink-0" aria-hidden="true">
              <Shield size={15} />
            </span>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-foreground">Paridad con Dropi</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Compara Guardian vs Dropi y reconcilia divergencias. Backstop manual del cron.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold ${
              healthColor === 'success' ? 'bg-success/14 border border-success/30 text-success'
              : healthColor === 'warning' ? 'bg-warning/14 border border-warning/30 text-warning'
              : healthColor === 'destructive' ? 'bg-danger/14 border border-danger/30 text-danger'
              : 'bg-card/40 border border-border text-muted-foreground'
            }`}>
              <Activity size={11} />
              {healthLabel}
            </span>
            {health?.last_health_checked_at && (
              <span className="text-[11px] text-muted-foreground font-mono tabular-nums">
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
              title={canAudit ? '' : cfgReadFailed ? 'No se pudo leer la configuración' : 'Falta dropi_api_key en Credenciales Dropi'}
              className="btn-accent-3d inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Search size={14} /> Auditar paridad ahora
            </button>
            {/* Con la lectura caída NO decir "Cargá la api_key": la clave puede
                estar puesta — lo que falló fue leerla. Instrucción falsa =
                dueño dando vueltas entre dos paneles que se contradicen. */}
            {!canAudit && (
              cfgReadFailed ? (
                <span className="text-[11px] text-warning inline-flex items-center gap-1.5">
                  <AlertTriangle size={11} /> No se pudo leer la configuración —
                  <button
                    type="button"
                    onClick={() => void load()}
                    className="underline underline-offset-2 hover:text-foreground transition-colors"
                  >
                    reintentar
                  </button>
                </span>
              ) : (
                <span className="text-[11px] text-warning inline-flex items-center gap-1">
                  <AlertTriangle size={11} /> Cargá la api_key de Dropi para habilitar
                </span>
              )
            )}
          </div>

          {/* El historial ausente por fallo de lectura NO puede parecer "nunca
              se auditó" — se avisa en vez de desaparecer en silencio. */}
          {histReadFailed && (
            <p className="text-[11px] text-warning inline-flex items-center gap-1">
              <AlertTriangle size={11} /> No se pudo leer el historial de auditorías.
            </p>
          )}

          {history.length > 0 && (
            <div className="border border-border rounded-2xl overflow-x-auto shadow-card3d">
              <table className="w-full text-xs">
                <thead className="bg-card/40 text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="text-left px-3 py-2">Fecha</th>
                    <th className="text-right px-3 py-2">Guardian</th>
                    <th className="text-right px-3 py-2">Dropi</th>
                    <th className="text-right px-3 py-2">Divergencias</th>
                    <th className="text-right px-3 py-2">Aplicadas</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {history.map(r => (
                    <tr key={r.id} className="hover:bg-card/40 transition-colors">
                      <td className="px-3 py-2 text-muted-foreground font-mono tabular-nums">
                        {format(new Date(r.created_at), "d MMM HH:mm", { locale: es })}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">{r.guardian_count}</td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">{r.dropi_count}</td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">
                        {r.divergences_found === 0
                          ? <CheckCircle2 size={12} className="text-success inline" />
                          : <span className="text-warning font-bold">{r.divergences_found}</span>}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-success">{r.divergences_applied}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        </TiltCard>
      </motion.div>

      <DropiAuditModal
        open={open}
        onClose={() => { setOpen(false); void load(); }}
        storeId={activeStoreId}
      />
    </>
  );
}

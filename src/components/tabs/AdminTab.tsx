import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { CheckCircle2, XCircle, PhoneOff, Key, Save, Eye, EyeOff, Loader2, Wifi, WifiOff, AlertTriangle, X } from 'lucide-react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import SyncHistory from '@/components/admin/SyncHistory';
import SyncPanel from '@/components/admin/SyncPanel';
import ReportsTable from '@/components/admin/ReportsTable';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';

const fadeUp = { initial: { opacity: 0, y: 16 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.35, ease: 'easeOut' } };

interface Profile { user_id: string; display_name: string; roles: string[]; }
interface DayReport { operator_name: string; report_date: string; data: Record<string, number>; }
interface FailedSync { id: string; created_at: string; error_message: string | null; }

export default function AdminTab() {
  const { isAdmin } = useAuth();
  const [operators, setOperators] = useState<Profile[]>([]);
  const [reports, setReports] = useState<DayReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncKey, setSyncKey] = useState(0);
  const [failedSyncs, setFailedSyncs] = useState<FailedSync[]>([]);
  const [dismissedAlerts, setDismissedAlerts] = useState<Set<string>>(new Set());

  const [dropiKey, setDropiKey] = useState('');
  const [dropiKeySaved, setDropiKeySaved] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [testingKey, setTestingKey] = useState(false);
  const [testResult, setTestResult] = useState<'ok' | 'fail' | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    loadData();
    loadDropiKey();
    loadFailedSyncs();
  }, [isAdmin]);

  async function loadFailedSyncs() {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data } = await supabase
      .from('sync_logs')
      .select('id, created_at, error_message')
      .eq('status', 'error')
      .gte('created_at', twentyFourHoursAgo)
      .order('created_at', { ascending: false })
      .limit(5);
    setFailedSyncs((data as FailedSync[]) || []);
  }

  async function loadDropiKey() {
    const { data } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'dropi_api_key')
      .maybeSingle();
    if (data) {
      setDropiKey(data.value);
      setDropiKeySaved(data.value);
    }
  }

  async function saveDropiKey() {
    if (!dropiKey.trim()) {
      toast.error('La clave no puede estar vacía');
      return;
    }
    setSavingKey(true);
    try {
      if (dropiKeySaved) {
        const { error } = await supabase
          .from('app_settings')
          .update({ value: dropiKey.trim() })
          .eq('key', 'dropi_api_key');
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('app_settings')
          .insert({ key: 'dropi_api_key', value: dropiKey.trim() });
        if (error) throw error;
      }
      setDropiKeySaved(dropiKey.trim());
      toast.success('Clave API de Dropi guardada');
    } catch (err: any) {
      toast.error(err.message || 'Error al guardar');
    } finally {
      setSavingKey(false);
    }
  }

  async function testDropiConnection() {
    setTestingKey(true);
    setTestResult(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { toast.error('No hay sesión activa'); return; }
      const today = new Date().toISOString().split('T')[0];
      const res = await supabase.functions.invoke('dropi-sync', {
        body: { from: today, untill: today },
      });
      if (res.error) {
        setTestResult('fail');
        toast.error(`Error: ${res.error.message}`);
      } else if (res.data?.error) {
        setTestResult('fail');
        toast.error(res.data.error);
      } else {
        setTestResult('ok');
        toast.success(`Conexión exitosa — ${res.data.message || 'API respondió correctamente'}`);
      }
    } catch (err: any) {
      setTestResult('fail');
      toast.error(err.message || 'Error de conexión');
    } finally {
      setTestingKey(false);
    }
  }

  async function loadData() {
    setLoading(true);
    const { data: profiles } = await supabase.from('profiles').select('user_id, display_name');
    const { data: roles } = await supabase.from('user_roles').select('user_id, role');
    if (profiles && roles) {
      setOperators(profiles.map(p => ({ ...p, roles: roles.filter(r => r.user_id === p.user_id).map(r => r.role) })));
    }
    const { data: reps } = await supabase.from('daily_reports')
      .select('operator_id, report_date, report_type, data')
      .eq('report_type', 'cierre').order('report_date', { ascending: false }).limit(20);
    if (reps && profiles) {
      setReports(reps.map(r => ({
        operator_name: profiles?.find(p => p.user_id === r.operator_id)?.display_name || 'Desconocido',
        report_date: r.report_date, data: r.data as Record<string, number>,
      })));
    }
    setLoading(false);
  }

  if (!isAdmin) return <div className="text-center py-10 text-muted-foreground">Acceso denegado</div>;

  return (
    <div className="max-w-5xl mx-auto">
      <p className="text-sm text-muted-foreground mb-5">Panel de administración</p>

      {failedSyncs.filter(f => !dismissedAlerts.has(f.id)).length > 0 && (
        <motion.div {...fadeUp} className="mb-5 rounded-xl border border-destructive/40 bg-destructive/10 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="text-destructive mt-0.5 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <h4 className="text-sm font-semibold text-destructive">Sincronización fallida</h4>
              <p className="text-xs text-destructive/80 mt-0.5 mb-2">
                {failedSyncs.filter(f => !dismissedAlerts.has(f.id)).length} error(es) en las últimas 24 horas
              </p>
              <div className="space-y-1.5">
                {failedSyncs.filter(f => !dismissedAlerts.has(f.id)).map(sync => (
                  <div key={sync.id} className="flex items-center justify-between gap-2 text-xs bg-destructive/5 rounded-lg px-3 py-2">
                    <div className="min-w-0">
                      <span className="text-muted-foreground">
                        {format(new Date(sync.created_at), "d MMM, HH:mm", { locale: es })}
                      </span>
                      {sync.error_message && (
                        <span className="ml-2 text-destructive truncate">{sync.error_message}</span>
                      )}
                    </div>
                    <button
                      onClick={() => setDismissedAlerts(prev => new Set([...prev, sync.id]))}
                      className="text-muted-foreground hover:text-foreground flex-shrink-0"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </motion.div>
      )}

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => <div key={i} className="h-16 rounded-xl skeleton-shimmer" />)}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Dropi API Key */}
          <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0 }} className="bg-card rounded-xl border border-border overflow-hidden md:col-span-2">
            <div className="px-5 py-4 border-b border-border flex items-center gap-2">
              <Key size={16} className="text-primary" />
              <div>
                <h3 className="text-sm font-semibold text-foreground">Clave API de Dropi</h3>
                <p className="text-xs text-muted-foreground mt-0.5">Configura la clave de integración para sincronizar pedidos</p>
              </div>
            </div>
            <div className="px-5 py-4 flex gap-3 items-center">
              <div className="relative flex-1">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={dropiKey}
                  onChange={e => setDropiKey(e.target.value)}
                  placeholder="Pega aquí tu clave de integración Dropi"
                  className="w-full h-10 rounded-lg border border-border bg-background px-3 pr-10 text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
              <button
                onClick={saveDropiKey}
                disabled={savingKey || dropiKey === dropiKeySaved}
                className="h-10 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium flex items-center gap-2 hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {savingKey ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                Guardar
              </button>
            </div>
            {dropiKeySaved && (
              <div className="px-5 pb-4 flex items-center justify-between">
                <span className="text-xs text-green flex items-center gap-1">
                  <CheckCircle2 size={12} /> Clave configurada
                </span>
                <button
                  onClick={testDropiConnection}
                  disabled={testingKey}
                  className="h-8 px-3 rounded-lg border border-border bg-secondary text-secondary-foreground text-xs font-medium flex items-center gap-2 hover:bg-secondary/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {testingKey ? <Loader2 size={12} className="animate-spin" /> : testResult === 'ok' ? <Wifi size={12} className="text-green" /> : testResult === 'fail' ? <WifiOff size={12} className="text-red" /> : <Wifi size={12} />}
                  {testingKey ? 'Probando…' : testResult === 'ok' ? 'Conexión OK' : testResult === 'fail' ? 'Falló' : 'Probar conexión'}
                </button>
              </div>
            )}
          </motion.div>

          <SyncPanel onSyncComplete={() => setSyncKey(k => k + 1)} />

          <SyncHistory key={syncKey} />

          <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.05 }} className="bg-card rounded-xl border border-border overflow-hidden">
            <div className="px-5 py-4 border-b border-border">
              <h3 className="text-sm font-semibold text-foreground">Operadoras registradas</h3>
              <p className="text-xs text-muted-foreground mt-0.5">{operators.length} usuarios</p>
            </div>
            <div className="divide-y divide-border">
              {operators.map(op => (
                <div key={op.user_id} className="flex items-center justify-between px-5 py-3">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center text-xs font-bold text-foreground">
                      {op.display_name[0].toUpperCase()}
                    </div>
                    <div>
                      <div className="text-sm font-medium text-foreground">{op.display_name}</div>
                      <div className="text-[10px] text-muted-foreground font-mono">{op.user_id.slice(0, 8)}…</div>
                    </div>
                  </div>
                  <div className="flex gap-1.5">
                    {op.roles.map(r => (
                      <span key={r} className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                        r === 'admin' ? 'bg-orange/10 text-orange' : 'bg-blue/10 text-blue'
                      }`}>{r}</span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </motion.div>

          <ReportsTable />
        </div>
      )}
    </div>
  );
}

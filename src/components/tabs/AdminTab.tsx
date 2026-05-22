import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useStore } from '@/contexts/StoreContext';
import { CheckCircle2, Key, Save, Eye, EyeOff, Loader2, AlertTriangle, X, Sparkles, WifiOff } from 'lucide-react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import SyncHistory from '@/components/admin/SyncHistory';
import SyncPanel from '@/components/admin/SyncPanel';
import ReportsTable from '@/components/admin/ReportsTable';
import StoreCredentialsPanel from '@/components/admin/StoreCredentialsPanel';
import StoreInvitePanel from '@/components/admin/StoreInvitePanel';
import ProductDropiMapPanel from '@/components/admin/ProductDropiMapPanel';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import ProductivityDashboard from '@/components/admin/ProductivityDashboard';
import DailyReportsView from '@/components/admin/DailyReportsView';
import { GoogleQuotaWidget } from '@/components/admin/GoogleQuotaWidget';

const fadeUp = { initial: { opacity: 0, y: 16 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.35, ease: 'easeOut' } };

interface Profile { user_id: string; display_name: string; roles: string[]; }
interface DayReport { operator_name: string; report_date: string; data: Record<string, number>; }
interface FailedSync { id: string; created_at: string; error_message: string | null; }

export default function AdminTab() {
  const { isAdmin } = useAuth();
  const { activeStoreId } = useStore();
  const [operators, setOperators] = useState<Profile[]>([]);
  const [reports, setReports] = useState<DayReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncKey, setSyncKey] = useState(0);
  const [failedSyncs, setFailedSyncs] = useState<FailedSync[]>([]);
  const [dismissedAlerts, setDismissedAlerts] = useState<Set<string>>(new Set());

  // AI key state (sigue siendo global, no por tienda)
  const [aiKey, setAiKey] = useState('');
  const [aiKeySaved, setAiKeySaved] = useState('');
  const [showAiKey, setShowAiKey] = useState(false);
  const [savingAiKey, setSavingAiKey] = useState(false);
  const [testingAi, setTestingAi] = useState(false);
  const [aiTestResult, setAiTestResult] = useState<'ok' | 'fail' | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    loadData();
    loadAiKey();
    loadFailedSyncs();
  }, [isAdmin, activeStoreId]);


  async function loadFailedSyncs() {
    if (!activeStoreId) { setFailedSyncs([]); return; }
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data } = await supabase
      .from('sync_logs')
      .select('id, created_at, error_message')
      .eq('status', 'error')
      .eq('store_id', activeStoreId)
      .gte('created_at', twentyFourHoursAgo)
      .order('created_at', { ascending: false })
      .limit(5);
    setFailedSyncs((data as FailedSync[]) || []);
  }

  // (loadDropiKey / saveDropiKey / testDropiConnection eliminados —
  //  reemplazados por StoreCredentialsPanel multi-tenant.)


  async function loadAiKey() {
    const { data } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'dashscope_api_key')
      .maybeSingle();
    if (data) {
      setAiKey(data.value);
      setAiKeySaved(data.value);
    }
  }

  async function saveAiKey() {
    if (!aiKey.trim()) { toast.error('La clave no puede estar vacía'); return; }
    setSavingAiKey(true);
    try {
      if (aiKeySaved) {
        const { error } = await supabase.from('app_settings').update({ value: aiKey.trim() }).eq('key', 'dashscope_api_key');
        if (error) throw error;
      } else {
        const { error } = await supabase.from('app_settings').insert({ key: 'dashscope_api_key', value: aiKey.trim() });
        if (error) throw error;
      }
      setAiKeySaved(aiKey.trim());
      toast.success('Clave AI guardada');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Error al guardar');
    } finally {
      setSavingAiKey(false);
    }
  }

  async function testAiConnection() {
    // Fix 3: en vez de pegarle directo a aliyuncs con la key del browser,
    // probamos la conexión vía edge function (auth + key server-side).
    setTestingAi(true);
    setAiTestResult(null);
    try {
      const { data, error } = await supabase.functions.invoke('ai-order-assistant', {
        body: {
          action: 'priority_reason',
          context: 'Pedido de prueba: cliente nuevo, valor 50000, 2 dias sin movimiento.',
        },
      });
      const payload = data as { ok?: boolean; error?: string } | null;
      if (error || !payload?.ok) {
        setAiTestResult('fail');
        toast.error(error?.message || payload?.error || 'Error IA');
      } else {
        setAiTestResult('ok');
        toast.success('IA conectada correctamente');
      }
    } catch (err: unknown) {
      setAiTestResult('fail');
      toast.error(err instanceof Error ? err.message : 'Error de conexión');
    } finally {
      setTestingAi(false);
    }
  }

  // Credenciales Dropi (API key + session token) ahora son POR TIENDA y se
  // manejan en <StoreCredentialsPanel />. Se eliminaron loadDropiSession /
  // saveDropiSession / testDropiFingerprint (escribían en app_settings global).

  async function loadData() {
    setLoading(true);
    if (!activeStoreId) { setOperators([]); setReports([]); setLoading(false); return; }

    // Operadoras de la TIENDA ACTIVA (no usuarios globales): se leen de
    // store_members + profiles. Antes se listaban todos los profiles/user_roles
    // del sistema, así que el admin de Ecuador veía a las operadoras de Colombia
    // aunque no fueran miembros de su tienda. El rol que se muestra es el rol
    // POR TIENDA (owner/operator), no el global de user_roles.
    const { data: members } = await supabase
      .from('store_members')
      .select('user_id, role')
      .eq('store_id', activeStoreId);
    const memberIds = (members ?? []).map(m => m.user_id);
    const { data: profiles } = memberIds.length
      ? await supabase.from('profiles').select('user_id, display_name').in('user_id', memberIds)
      : { data: [] as { user_id: string; display_name: string }[] };

    const roleByUser = new Map((members ?? []).map(m => [m.user_id, m.role as string]));
    const nameByUser = new Map((profiles ?? []).map(p => [p.user_id, p.display_name]));
    setOperators((profiles ?? []).map(p => ({
      user_id: p.user_id,
      display_name: p.display_name,
      roles: roleByUser.get(p.user_id) ? [roleByUser.get(p.user_id) as string] : [],
    })));

    // Reportes de cierre — también por tienda.
    const { data: reps } = await supabase.from('daily_reports')
      .select('operator_id, report_date, report_type, data')
      .eq('report_type', 'cierre')
      .eq('store_id', activeStoreId)
      .order('report_date', { ascending: false }).limit(20);
    setReports((reps ?? []).map(r => ({
      operator_name: nameByUser.get(r.operator_id) || 'Desconocido',
      report_date: r.report_date, data: r.data as Record<string, number>,
    })));
    setLoading(false);
  }

  if (!isAdmin) return <div className="text-center py-10 text-muted-foreground">Acceso denegado</div>;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Page header — patrón pro coherente con Logística/Rescate */}
      <header className="space-y-1.5">
        <div className="text-[11px] uppercase tracking-[0.12em] font-semibold text-muted-foreground">
          Panel · Admin
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground leading-none flex items-center gap-2.5">
          <Key size={22} className="text-accent" aria-hidden="true" strokeWidth={2.25} />
          Administración
        </h1>
        <p className="text-sm text-muted-foreground">
          Configuración de integraciones (Dropi, IA, huella), gestión de operadoras y reportes.
        </p>
      </header>

      <Tabs defaultValue="config" className="w-full">
        <TabsList className="mb-5">
          <TabsTrigger value="config">Configuración</TabsTrigger>
          <TabsTrigger value="productividad">Productividad</TabsTrigger>
          <TabsTrigger value="reportes">Reportes diarios</TabsTrigger>
        </TabsList>

        <TabsContent value="productividad" className="mt-0">
          <ProductivityDashboard />
        </TabsContent>

        <TabsContent value="reportes" className="mt-0">
          <DailyReportsView />
        </TabsContent>

        <TabsContent value="config" className="mt-0 space-y-0">
          <div>

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
          {/* Credenciales Dropi POR TIENDA (reemplaza el panel global app_settings) */}
          <div className="md:col-span-2">
            <StoreCredentialsPanel />
          </div>

          {/* Vínculos de productos Shopify → Dropi (mapeo manual por tienda) */}
          <div className="md:col-span-2">
            <ProductDropiMapPanel />
          </div>

          {/* Invitar operadora por link (solo dueño de la tienda activa) */}
          <StoreInvitePanel />

          {/* AI API Key */}
          <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.02 }} className="bg-card rounded-xl border border-border overflow-hidden md:col-span-2">
            <div className="px-5 py-4 border-b border-border flex items-center gap-2">
              <Sparkles size={16} className="text-ai" />
              <div>
                <h3 className="text-sm font-semibold text-foreground">Clave API de IA (DashScope)</h3>
                <p className="text-xs text-muted-foreground mt-0.5">Habilita guiones de llamada, sugerencias y perfiles de cliente con IA</p>
              </div>
            </div>
            <div className="px-5 py-4 flex gap-3 items-center">
              <div className="relative flex-1">
                <input
                  type={showAiKey ? 'text' : 'password'}
                  value={aiKey}
                  onChange={e => setAiKey(e.target.value)}
                  placeholder="Pega aquí tu clave de DashScope (sk-...)"
                  className="w-full h-10 rounded-lg border border-border bg-background px-3 pr-10 text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-violet-500/30"
                />
                <button type="button" onClick={() => setShowAiKey(!showAiKey)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors">
                  {showAiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
              <button onClick={saveAiKey} disabled={savingAiKey || aiKey === aiKeySaved}
                className="h-10 px-4 rounded-lg bg-ai text-ai-foreground text-sm font-medium flex items-center gap-2 hover:opacity-90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                {savingAiKey ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                Guardar
              </button>
            </div>
            {aiKeySaved && (
              <div className="px-5 pb-4 flex items-center justify-between">
                <span className="text-xs text-success flex items-center gap-1">
                  <CheckCircle2 size={12} /> Clave IA configurada
                </span>
                <button onClick={testAiConnection} disabled={testingAi}
                  className="h-8 px-3 rounded-lg border border-border bg-secondary text-secondary-foreground text-xs font-medium flex items-center gap-2 hover:bg-secondary/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                  {testingAi ? <Loader2 size={12} className="animate-spin" /> : aiTestResult === 'ok' ? <Sparkles size={12} className="text-ai" /> : aiTestResult === 'fail' ? <WifiOff size={12} className="text-danger" /> : <Sparkles size={12} />}
                  {testingAi ? 'Probando…' : aiTestResult === 'ok' ? 'IA OK' : aiTestResult === 'fail' ? 'Falló' : 'Probar IA'}
                </button>
              </div>
            )}
          </motion.div>

          {/* La "Huella del comprador" (token de sesión Dropi) ahora es por tienda
              y vive dentro de <StoreCredentialsPanel />. */}

          <div className="my-4 md:col-span-2">
            <GoogleQuotaWidget />
          </div>

          <SyncPanel onSyncComplete={() => { setSyncKey(k => k + 1); loadFailedSyncs(); }} />

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
                      <span key={r} className={`pill ${r === 'admin' || r === 'owner' ? 'pill-warning' : 'pill-info'}`}>{r}</span>
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
        </TabsContent>
      </Tabs>
    </div>
  );
}


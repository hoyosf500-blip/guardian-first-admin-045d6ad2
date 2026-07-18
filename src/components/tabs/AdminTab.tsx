import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useStore } from '@/contexts/StoreContext';
import { CheckCircle2, Key, Save, Eye, EyeOff, Loader2, AlertTriangle, X, Sparkles, WifiOff, Users } from 'lucide-react';
import { TiltCard } from '@/components/ui3d';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import SyncHistory from '@/components/admin/SyncHistory';
import SyncPanel from '@/components/admin/SyncPanel';
import ReportsTable from '@/components/admin/ReportsTable';
import StoreCredentialsPanel from '@/components/admin/StoreCredentialsPanel';
import StoreInvitePanel from '@/components/admin/StoreInvitePanel';
import ProductDropiMapPanel from '@/components/admin/ProductDropiMapPanel';
import DropiParityPanel from '@/components/admin/DropiParityPanel';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import ProductivityDashboard from '@/components/admin/ProductivityDashboard';
import WorkSchedulePanel from '@/components/admin/WorkSchedulePanel';
import DailyReportsView from '@/components/admin/DailyReportsView';
import WaBotConfigPanel from '@/components/admin/WaBotConfigPanel';
import WaBotNotifyPanel from '@/components/admin/WaBotNotifyPanel';
import ProductKnowledgePanel from '@/components/admin/ProductKnowledgePanel';
import WaChannelsPanel from '@/components/admin/WaChannelsPanel';
import WaQuickRepliesPanel from '@/components/admin/WaQuickRepliesPanel';

const fadeUp = { initial: { opacity: 0, y: 16 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.35, ease: 'easeOut' } };

interface Profile { user_id: string; display_name: string; roles: string[]; }
interface DayReport { operator_name: string; report_date: string; data: Record<string, number>; }
interface FailedSync { id: string; created_at: string; error_message: string | null; }

export default function AdminTab() {
  // isAdmin = admin GLOBAL de plataforma (Fabian). isManagerOfActive = owner o
  // supervisor de la tienda activa. El Admin es managerOnly (igual que el gate de
  // AdminPage): un supervisor DEBE poder entrar. Solo la config GLOBAL (clave IA)
  // queda reservada al admin de plataforma.
  const { isAdmin } = useAuth();
  const { activeStoreId, isManagerOfActive } = useStore();
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
    if (!isManagerOfActive) return;
    loadData();
    loadFailedSyncs();
    if (isAdmin) loadAiKey(); // clave IA = config global, solo admin de plataforma
  }, [isManagerOfActive, isAdmin, activeStoreId]);


  async function loadFailedSyncs() {
    if (!activeStoreId) { setFailedSyncs([]); return; }
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data } = await supabase
      .from('sync_logs')
      .select('id, created_at, error_message')
      // 'warn' incluido: dropi-change-carrier loguea status 'warn' cuando la
      // orden vieja pudo quedar activa (riesgo de doble envío) — con el filtro
      // solo-'error' esos avisos no aparecían en ningún lado.
      .in('status', ['error', 'warn'])
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

  if (!isManagerOfActive) return <div className="text-center py-10 text-muted-foreground">Acceso denegado</div>;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Page header — patrón pro coherente con Logística/Rescate */}
      <header className="space-y-1.5 min-w-0">
        <div className="hud-label text-accent truncate">
          Panel · Admin
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-3">
          <span className="w-11 h-11 rounded-2xl bg-accent/14 border border-accent/30 text-accent glow-accent flex items-center justify-center flex-shrink-0" aria-hidden="true">
            <Key size={20} strokeWidth={2.25} />
          </span>
          Administración
        </h1>
        <p className="text-sm text-muted-foreground">
          Configuración de integraciones (Dropi, IA, huella), gestión de operadoras y reportes.
        </p>
      </header>

      <Tabs defaultValue="config" className="w-full">
        <TabsList className="mb-5 inline-flex flex-wrap gap-2 h-auto bg-transparent p-0 justify-start rounded-none [&>*]:px-4 [&>*]:py-2 [&>*]:rounded-xl [&>*]:text-sm [&>*]:font-medium [&>*]:bg-card/40 [&>*]:border [&>*]:border-border [&>*]:text-muted-foreground [&>*:hover]:text-foreground [&>*:hover]:border-border-strong [&>*]:transition-colors [&>*[data-state=active]]:bg-accent/16 [&>*[data-state=active]]:border-accent/40 [&>*[data-state=active]]:text-accent [&>*[data-state=active]]:font-semibold [&>*[data-state=active]]:shadow-glow3d">
          <TabsTrigger value="config">Configuración</TabsTrigger>
          <TabsTrigger value="canales">Canales WhatsApp</TabsTrigger>
          <TabsTrigger value="bot">Bot WhatsApp</TabsTrigger>
          <TabsTrigger value="productos">Productos (bot)</TabsTrigger>
          <TabsTrigger value="productividad">Productividad</TabsTrigger>
          <TabsTrigger value="reportes">Reportes diarios</TabsTrigger>
        </TabsList>

        <TabsContent value="productividad" className="mt-0 space-y-4">
          <WorkSchedulePanel />
          <ProductivityDashboard />
        </TabsContent>

        <TabsContent value="reportes" className="mt-0">
          <DailyReportsView />
        </TabsContent>

        <TabsContent value="canales" className="mt-0">
          <WaChannelsPanel />
        </TabsContent>

        <TabsContent value="bot" className="mt-0 space-y-4">
          <WaBotConfigPanel />
          <WaBotNotifyPanel />
          <WaQuickRepliesPanel />
        </TabsContent>

        <TabsContent value="productos" className="mt-0">
          <ProductKnowledgePanel />
        </TabsContent>

        <TabsContent value="config" className="mt-0 space-y-0">
          <div>

      {failedSyncs.filter(f => !dismissedAlerts.has(f.id)).length > 0 && (
        <motion.div {...fadeUp} className="relative mb-5 rounded-2xl border border-border bg-card/40 p-4 pl-5 shadow-card3d">
          <span className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-danger" aria-hidden="true" />
          <div className="flex items-start gap-3">
            <span className="w-8 h-8 rounded-xl bg-danger/14 border border-danger/30 text-danger flex items-center justify-center flex-shrink-0" aria-hidden="true">
              <AlertTriangle size={15} />
            </span>
            <div className="flex-1 min-w-0">
              <h4 className="text-sm font-semibold text-danger">Sincronización fallida</h4>
              <p className="text-xs text-muted-foreground mt-0.5 mb-2">
                {failedSyncs.filter(f => !dismissedAlerts.has(f.id)).length} error(es)/aviso(s) en las últimas 24 horas
              </p>
              <div className="space-y-1.5">
                {failedSyncs.filter(f => !dismissedAlerts.has(f.id)).map(sync => (
                  <div key={sync.id} className="flex items-center justify-between gap-2 text-xs bg-card/40 rounded-xl px-3 py-2 border border-border hover:border-border-strong transition-colors">
                    <div className="min-w-0">
                      <span className="text-muted-foreground font-mono tabular-nums">
                        {format(new Date(sync.created_at), "d MMM, HH:mm", { locale: es })}
                      </span>
                      {sync.error_message && (
                        <span className="ml-2 text-danger truncate">{sync.error_message}</span>
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
          {[1, 2, 3].map(i => <div key={i} className="h-16 rounded-2xl skeleton-shimmer" />)}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Credenciales Dropi POR TIENDA (reemplaza el panel global app_settings) */}
          <div className="md:col-span-2">
            <StoreCredentialsPanel />
          </div>

          {/* Paridad Guardian ↔ Dropi (Capa 3 del PLAN-PARITY-DROPI) */}
          <DropiParityPanel />

          {/* Vínculos de productos Shopify → Dropi (mapeo manual por tienda) */}
          <div className="md:col-span-2">
            <ProductDropiMapPanel />
          </div>

          {/* Invitar operadora por link (solo dueño de la tienda activa) */}
          <StoreInvitePanel />

          {/* AI API Key — config GLOBAL (app_settings), solo admin de plataforma */}
          {isAdmin && (
          <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.02 }} className="md:col-span-2">
          <TiltCard className="bg-card/40 border border-border rounded-2xl shadow-card3d">
            <div className="px-5 py-4 border-b border-border flex items-center gap-2.5">
              <span className="w-8 h-8 rounded-xl bg-accent/14 border border-accent/30 text-accent flex items-center justify-center flex-shrink-0" aria-hidden="true">
                <Sparkles size={15} />
              </span>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-foreground">Clave API de IA (DashScope)</h3>
                <p className="text-xs text-muted-foreground mt-0.5">Habilita guiones de llamada, sugerencias y perfiles de cliente con IA</p>
              </div>
              {aiKeySaved && (
                <span className="ml-auto flex-shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-success/14 border border-success/30 text-success">
                  CONFIGURADA
                </span>
              )}
            </div>
            <div className="px-5 py-4 flex gap-3 items-center">
              <div className="relative flex-1">
                <input
                  type={showAiKey ? 'text' : 'password'}
                  value={aiKey}
                  onChange={e => setAiKey(e.target.value)}
                  placeholder="Pega aquí tu clave de DashScope (sk-...)"
                  className="w-full h-10 rounded-xl border border-border bg-card/40 px-3 pr-10 text-sm font-mono tabular-nums text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-accent/30"
                />
                <button type="button" onClick={() => setShowAiKey(!showAiKey)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors">
                  {showAiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
              <button onClick={saveAiKey} disabled={savingAiKey || aiKey === aiKeySaved}
                className="btn-accent-3d h-10 px-4 rounded-xl text-sm font-semibold flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed">
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
                  className="h-8 px-3 rounded-xl border border-border bg-card/40 text-muted-foreground hover:text-foreground hover:border-border-strong text-xs font-medium flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                  {testingAi ? <Loader2 size={12} className="animate-spin" /> : aiTestResult === 'ok' ? <Sparkles size={12} className="text-ai" /> : aiTestResult === 'fail' ? <WifiOff size={12} className="text-danger" /> : <Sparkles size={12} />}
                  {testingAi ? 'Probando…' : aiTestResult === 'ok' ? 'IA OK' : aiTestResult === 'fail' ? 'Falló' : 'Probar IA'}
                </button>
              </div>
            )}
          </TiltCard>
          </motion.div>
          )}

          {/* La "Huella del comprador" (token de sesión Dropi) ahora es por tienda
              y vive dentro de <StoreCredentialsPanel />. */}

          {/* GoogleQuotaWidget eliminado 2026-05-22: Google Maps/Places está
              desactivado (ver featureFlags.GOOGLE_PLACES_ENABLED), no hay cuota
              que mostrar. */}

          <SyncPanel onSyncComplete={() => { setSyncKey(k => k + 1); loadFailedSyncs(); }} />

          <SyncHistory key={syncKey} />

          <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.05 }}>
          <TiltCard className="bg-card/40 border border-border rounded-2xl shadow-card3d">
            <div className="px-5 py-4 border-b border-border flex items-center gap-2.5">
              <span className="w-8 h-8 rounded-xl bg-accent/14 border border-accent/30 text-accent flex items-center justify-center flex-shrink-0" aria-hidden="true">
                <Users size={15} />
              </span>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-foreground">Operadoras registradas</h3>
                <p className="text-xs text-muted-foreground mt-0.5"><span className="font-mono tabular-nums">{operators.length}</span> usuarios</p>
              </div>
            </div>
            <div className="p-3 space-y-2">
              {operators.map(op => (
                <div key={op.user_id} className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl bg-card/40 border border-border hover:border-border-strong transition-colors">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-8 h-8 rounded-xl bg-accent-gradient flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
                      {op.display_name[0].toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-foreground truncate">{op.display_name}</div>
                      <div className="text-[10px] text-muted-foreground font-mono tabular-nums">{op.user_id.slice(0, 8)}…</div>
                    </div>
                  </div>
                  <div className="flex gap-1.5 flex-shrink-0">
                    {op.roles.map(r => (
                      <span
                        key={r}
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold ${
                          r === 'admin' || r === 'owner'
                            ? 'bg-warning/14 border border-warning/30 text-warning'
                            : 'bg-info/14 border border-info/30 text-info'
                        }`}
                      >{r}</span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </TiltCard>
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


import { useEffect, useState, useMemo } from 'react';
import { partirAvisos } from '@/lib/syncAvisos';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useStore } from '@/contexts/StoreContext';
import { CheckCircle2, Key, Save, Eye, EyeOff, Loader2, AlertTriangle, X, Sparkles, WifiOff, Users, SlidersHorizontal, TrendingUp, ClipboardList } from 'lucide-react';
import { TiltCard, AuroraBackdrop } from '@/components/ui3d';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import SyncHistory from '@/components/admin/SyncHistory';
import SyncPanel from '@/components/admin/SyncPanel';
import StoreCredentialsPanel from '@/components/admin/StoreCredentialsPanel';
import StoreInvitePanel from '@/components/admin/StoreInvitePanel';
import { isRpcMissing } from '@/lib/rpcError';
import CompartirGuardianPanel from '@/components/admin/CompartirGuardianPanel';
import ProductDropiMapPanel from '@/components/admin/ProductDropiMapPanel';
import DropiParityPanel from '@/components/admin/DropiParityPanel';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import ProductivityDashboard from '@/components/admin/ProductivityDashboard';
import WorkSchedulePanel from '@/components/admin/WorkSchedulePanel';
import DailyReportsView from '@/components/admin/DailyReportsView';

const fadeUp = { initial: { opacity: 0, y: 16 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.35, ease: 'easeOut' } };

/** Entrada escalonada — misma escala de delays que Dashboard/Logística. */
const rise = (delay = 0) => ({
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35, delay, ease: 'easeOut' as const },
});

/** Pastilla de sub-tab (misma firma que LogisticaTab). */
const TAB_PILL = [
  'shrink-0 inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium transition-colors duration-200',
  'bg-card/40 border border-border text-muted-foreground',
  'hover:text-foreground hover:border-border-strong',
  'data-[state=active]:bg-accent/16 data-[state=active]:border-accent/40',
  'data-[state=active]:text-accent data-[state=active]:font-semibold',
  'data-[state=active]:shadow-glow3d',
].join(' ');

interface Profile { user_id: string; display_name: string; roles: string[]; }
interface FailedSync { id: string; created_at: string; error_message: string | null; }

export default function AdminTab() {
  // isAdmin = admin GLOBAL de plataforma (Fabian). isManagerOfActive = owner o
  // supervisor de la tienda activa. El Admin es managerOnly (igual que el gate de
  // AdminPage): un supervisor DEBE poder entrar. Solo la config GLOBAL (clave IA)
  // queda reservada al admin de plataforma.
  const { isAdmin } = useAuth();
  // `activeStore` se usa en el título del panel de IA. Faltaba acá y la pantalla
  // reventaba entera con "activeStore is not defined": el `?.` NO protege contra
  // una variable que no existe (eso es ReferenceError, no undefined).
  const { activeStore, activeStoreId, isManagerOfActive, isOwnerOfActive } = useStore();
  const [operators, setOperators] = useState<Profile[]>([]);
  // Miembro con una acción en vuelo (cambiar rol / quitar) — deshabilita sus controles.
  const [memberBusy, setMemberBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncKey, setSyncKey] = useState(0);
  const [failedSyncs, setFailedSyncs] = useState<FailedSync[]>([]);
  const [dismissedAlerts, setDismissedAlerts] = useState<Set<string>>(new Set());

  // No todo `warn` es una falla. Cuando hay varias tiendas, el cron reparte su
  // presupuesto y posterga alguna para la corrida siguiente — se registra a
  // propósito (sin fila, el indicador de frescura creería que el cron murió),
  // pero el sistema lo resuelve solo. Pintarlo de rojo bajo "Sincronización
  // fallida" hizo que un dueño nuevo viera "5 errores" con todo sano y
  // escribiera preguntando qué se había roto. Nada se había roto.
  const { problemas: avisosProblema, normales: avisosNormales } = useMemo(
    () => partirAvisos(failedSyncs.filter(f => !dismissedAlerts.has(f.id))),
    [failedSyncs, dismissedAlerts],
  );

  // Clave de IA POR TIENDA (auditoría 2026-08-13: antes era UNA global y las
  // consultas de los dueños invitados las pagaba el dueño de la plataforma).
  const [aiKey, setAiKey] = useState('');
  const [aiKeyConfigurada, setAiKeyConfigurada] = useState(false);
  const [showAiKey, setShowAiKey] = useState(false);
  const [savingAiKey, setSavingAiKey] = useState(false);
  const [aiSoportado, setAiSoportado] = useState(true);
  const [testingAi, setTestingAi] = useState(false);
  const [aiTestResult, setAiTestResult] = useState<'ok' | 'fail' | null>(null);

  useEffect(() => {
    if (!isManagerOfActive) return;
    loadData();
    loadFailedSyncs();
    if (isOwnerOfActive) loadStoreAiStatus(); // la clave de IA es del DUEÑO de la tienda
  }, [isManagerOfActive, isOwnerOfActive, activeStoreId]);


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


  // La clave NUNCA baja al cliente: solo se pregunta si está configurada.
  async function loadStoreAiStatus() {
    if (!activeStoreId) { setAiKeyConfigurada(false); return; }
    type Res = { data: boolean | null; error: { message: string; code?: string } | null };
    const { data, error } = await (supabase.rpc as unknown as (fn: string, args: Record<string, unknown>) => Promise<Res>)(
      'get_store_ai_status',
      { p_store_id: activeStoreId },
    );
    if (error) {
      if (isRpcMissing(error)) setAiSoportado(false);
      return;
    }
    setAiSoportado(true);
    setAiKeyConfigurada(Boolean(data));
    setAiKey('');
  }

  async function saveAiKey() {
    if (!activeStoreId) return;
    if (!aiKey.trim()) { toast.error('La clave no puede estar vacía'); return; }
    setSavingAiKey(true);
    type Res = { error: { message: string; code?: string } | null };
    const { error } = await (supabase.rpc as unknown as (fn: string, args: Record<string, unknown>) => Promise<Res>)(
      'upsert_store_ai_key',
      { p_store_id: activeStoreId, p_api_key: aiKey.trim() },
    );
    setSavingAiKey(false);
    if (error) {
      toast.error(isRpcMissing(error) ? 'Falta aplicar el SQL de la clave de IA por tienda' : 'No se pudo guardar', {
        description: isRpcMissing(error) ? undefined : error.message,
      });
      return;
    }
    setAiKey('');
    setAiKeyConfigurada(true);
    setAiTestResult(null);
    toast.success('Clave de IA guardada para esta tienda');
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
          // Con store_id la prueba usa la clave de ESTA tienda (la que van a
          // gastar sus asesoras), no la de la plataforma.
          store_id: activeStoreId ?? undefined,
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
    if (!activeStoreId) { setOperators([]); setLoading(false); return; }

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
    setOperators((profiles ?? []).map(p => ({
      user_id: p.user_id,
      display_name: p.display_name,
      roles: roleByUser.get(p.user_id) ? [roleByUser.get(p.user_id) as string] : [],
    })));

    // (La query de daily_reports que vivía acá era código muerto: llenaba un
    // estado `reports` que ningún JSX renderizaba — huérfano de un layout
    // anterior — y su await alargaba el skeleton del tab en cada montaje.
    // Los cierres se ven en la pestaña "Reportes diarios".)
    setLoading(false);
  }

  // ── Miembros y accesos (auditoría 2026-08-13: no existía offboarding — una
  // operadora despedida conservaba el acceso para siempre). Solo el DUEÑO de la
  // tienda; el rol 'owner' nunca se gestiona desde acá (es del admin de
  // plataforma), así una tienda jamás queda sin dueño. Las RPCs son nuevas: si
  // el SQL aún no se aplicó, el toast lo dice en vez de un error críptico.
  const SQL_MIEMBROS_FALTA = 'Falta aplicar el SQL del panel de miembros — pedímelo en el chat';
  type RpcVoidRes = { error: { message: string; code?: string } | null };
  const rpcMiembros = (fn: string, args: Record<string, unknown>) =>
    (supabase.rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<RpcVoidRes>)(fn, args);

  async function cambiarRol(userId: string, rol: 'operator' | 'supervisor') {
    if (!activeStoreId) return;
    setMemberBusy(userId);
    const { error } = await rpcMiembros('set_store_member_role', {
      p_store_id: activeStoreId, p_user_id: userId, p_role: rol,
    });
    setMemberBusy(null);
    if (error) {
      toast.error(isRpcMissing(error) ? SQL_MIEMBROS_FALTA : 'No se pudo cambiar el rol', {
        description: isRpcMissing(error) ? undefined : error.message,
      });
      return;
    }
    toast.success('Rol actualizado');
    loadData();
  }

  async function quitarMiembro(userId: string, nombre: string) {
    if (!activeStoreId) return;
    if (!window.confirm(`¿Sacar a ${nombre} de la tienda? Pierde el acceso al instante.`)) return;
    setMemberBusy(userId);
    const { error } = await rpcMiembros('remove_store_member', {
      p_store_id: activeStoreId, p_user_id: userId,
    });
    setMemberBusy(null);
    if (error) {
      toast.error(isRpcMissing(error) ? SQL_MIEMBROS_FALTA : 'No se pudo quitar al miembro', {
        description: isRpcMissing(error) ? undefined : error.message,
      });
      return;
    }
    toast.success(`${nombre} ya no tiene acceso a la tienda`);
    loadData();
  }

  if (!isManagerOfActive) return <div className="text-center py-10 text-muted-foreground">Acceso denegado</div>;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Page header — hero con aurora, mismo lenguaje que Logística */}
      <motion.header
        {...rise(0)}
        className="relative overflow-hidden rounded-3xl border border-border bg-card/40 p-5 shadow-card3d-lg hairline-top flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"
      >
        <AuroraBackdrop />
        <div className="relative min-w-0 space-y-1.5">
          <div className="hud-label mb-1 truncate">
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
        </div>
      </motion.header>

      <Tabs defaultValue="config" className="w-full">
        <motion.div {...rise(0.05)} className="overflow-x-auto -mx-1 px-1">
          <TabsList className="mb-5 inline-flex w-full flex-wrap gap-2 h-auto bg-transparent p-0 justify-start rounded-none" aria-label="Secciones de administración">
            <TabsTrigger value="config" className={TAB_PILL}><SlidersHorizontal size={13} aria-hidden="true" /> Configuración</TabsTrigger>
            <TabsTrigger value="productividad" className={TAB_PILL}><TrendingUp size={13} aria-hidden="true" /> Productividad</TabsTrigger>
            <TabsTrigger value="reportes" className={TAB_PILL}><ClipboardList size={13} aria-hidden="true" /> Reportes diarios</TabsTrigger>
          </TabsList>
        </motion.div>

        <TabsContent value="productividad" className="mt-0 space-y-5">
          <motion.div {...rise(0.12)}><WorkSchedulePanel /></motion.div>
          <motion.div {...rise(0.18)}><ProductivityDashboard /></motion.div>
        </TabsContent>

        <TabsContent value="reportes" className="mt-0">
          <motion.div {...rise(0.12)}><DailyReportsView /></motion.div>
        </TabsContent>

        <TabsContent value="config" className="mt-0 space-y-0">
          <div>

      {avisosProblema.length === 0 && avisosNormales.length > 0 && (
        <p className="mb-5 text-[11px] text-muted-foreground">
          {avisosNormales.length} aviso{avisosNormales.length > 1 ? 's' : ''} normal{avisosNormales.length > 1 ? 'es' : ''} de
          reparto entre tiendas en las últimas 24 h — el sistema los resuelve solo en la corrida siguiente.
          No hay nada que hacer.
        </p>
      )}

      {avisosProblema.length > 0 && (
        <motion.div {...fadeUp} className="relative mb-5 rounded-2xl border border-danger/30 bg-danger/10 px-4 pl-5 py-3 shadow-card3d">
          <span className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-danger" aria-hidden="true" />
          <div className="flex items-start gap-3">
            <span className="w-9 h-9 rounded-xl bg-danger/20 glow-danger text-danger flex items-center justify-center flex-shrink-0" aria-hidden="true">
              <AlertTriangle size={17} />
            </span>
            <div className="flex-1 min-w-0">
              <h4 className="text-sm font-semibold text-danger">Sincronización fallida</h4>
              <p className="text-xs text-muted-foreground mt-0.5 mb-2">
                {avisosProblema.length} error(es)/aviso(s) en las últimas 24 horas
              </p>
              <div className="space-y-1.5">
                {avisosProblema.map(sync => (
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
                      type="button"
                      onClick={() => setDismissedAlerts(prev => new Set([...prev, sync.id]))}
                      className="flex-shrink-0 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      aria-label="Descartar aviso"
                    >
                      <X size={12} aria-hidden="true" />
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

          {/* Compartir Guardian con un amigo (link /registro para dueños nuevos).
              Solo el admin de plataforma: es quien suma tiendas nuevas. */}
          {isAdmin && (
            <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.02 }} className="md:col-span-2">
              <CompartirGuardianPanel />
            </motion.div>
          )}

          {/* Clave de IA POR TIENDA: cada dueño pone la suya y paga su consumo.
              Antes era una sola clave global y el gasto de todas las tiendas caía
              en la cuenta del dueño de la plataforma (auditoría 2026-08-13). */}
          {isOwnerOfActive && aiSoportado && (
          <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.02 }} className="md:col-span-2">
          <TiltCard className="bg-card/40 border border-border rounded-2xl shadow-card3d">
            <div className="px-5 py-4 border-b border-border flex items-center gap-2.5">
              <span className="w-9 h-9 rounded-xl bg-accent/14 border border-accent/30 text-accent glow-accent flex items-center justify-center flex-shrink-0" aria-hidden="true">
                <Sparkles size={15} />
              </span>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-foreground">Clave de IA · {activeStore?.name ?? 'esta tienda'}</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Habilita el botón <strong>Perfil IA del cliente</strong>. Es opcional y se paga por uso:
                  esta clave es tuya y se cobra a tu cuenta de DashScope.
                </p>
              </div>
              {aiKeyConfigurada && (
                <span className="ml-auto flex-shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-success/14 border border-success/30 text-success">
                  CONFIGURADA
                </span>
              )}
            </div>
            <div className="px-5 py-4 flex gap-3 items-center">
              <div className="relative flex-1">
                <label className="sr-only" htmlFor="ai-key">Clave de IA de esta tienda</label>
                <input
                  id="ai-key"
                  type={showAiKey ? 'text' : 'password'}
                  value={aiKey}
                  autoComplete="off"
                  onChange={e => setAiKey(e.target.value)}
                  placeholder={aiKeyConfigurada ? '•••••• (pegá una nueva para cambiarla)' : 'Pegá tu clave de DashScope (sk-...)'}
                  className="w-full h-10 rounded-xl border border-border bg-card/40 px-3 pr-10 text-sm font-mono tabular-nums text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-accent/30"
                />
                <button type="button" onClick={() => setShowAiKey(!showAiKey)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors">
                  {showAiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
              <button onClick={saveAiKey} disabled={savingAiKey || !aiKey.trim()}
                className="btn-accent-3d h-10 px-4 rounded-xl text-sm font-semibold flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed">
                {savingAiKey ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                Guardar
              </button>
            </div>
            <div className="px-5 pb-4 flex items-center justify-between gap-3">
              <span className="text-xs flex items-center gap-1 min-w-0">
                {aiKeyConfigurada ? (
                  <><CheckCircle2 size={12} className="text-success flex-shrink-0" /> <span className="text-success">Clave configurada — la IA la cobra a esta tienda</span></>
                ) : (
                  <span className="text-muted-foreground">
                    Sin clave: el botón de IA avisa que falta configurarla. Guardian funciona igual sin esto.
                  </span>
                )}
              </span>
              {aiKeyConfigurada && (
                <button onClick={testAiConnection} disabled={testingAi}
                  className="h-8 px-3 rounded-xl border border-border bg-card/40 text-muted-foreground hover:text-foreground hover:border-border-strong text-xs font-medium flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0">
                  {testingAi ? <Loader2 size={12} className="animate-spin" /> : aiTestResult === 'ok' ? <Sparkles size={12} className="text-ai" /> : aiTestResult === 'fail' ? <WifiOff size={12} className="text-danger" /> : <Sparkles size={12} />}
                  {testingAi ? 'Probando…' : aiTestResult === 'ok' ? 'IA OK' : aiTestResult === 'fail' ? 'Falló' : 'Probar IA'}
                </button>
              )}
            </div>
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
              <span className="w-9 h-9 rounded-xl bg-accent/14 border border-accent/30 text-accent glow-accent flex items-center justify-center flex-shrink-0" aria-hidden="true">
                <Users size={15} />
              </span>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-foreground">Miembros y accesos</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  <span className="font-mono tabular-nums">{operators.length}</span> usuarios
                  {isOwnerOfActive && ' · cambiá el rol o quitá el acceso al instante'}
                </p>
              </div>
            </div>
            <div className="p-3 space-y-2">
              {operators.map(op => {
                const esOwner = op.roles.includes('owner');
                const rolActual = (op.roles[0] === 'supervisor' ? 'supervisor' : 'operator') as 'operator' | 'supervisor';
                const busy = memberBusy === op.user_id;
                return (
                <div key={op.user_id} className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl bg-card/40 border border-border hover:border-border-strong transition-colors">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-8 h-8 rounded-xl bg-accent-gradient flex items-center justify-center text-xs font-bold text-accent-foreground flex-shrink-0">
                      {op.display_name[0].toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-foreground truncate">{op.display_name}</div>
                      <div className="text-[10px] text-muted-foreground font-mono tabular-nums">{op.user_id.slice(0, 8)}…</div>
                    </div>
                  </div>
                  {/* El dueño gestiona a su equipo; a él no lo gestiona nadie desde acá. */}
                  {isOwnerOfActive && !esOwner ? (
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <label className="sr-only" htmlFor={`rol-${op.user_id}`}>Rol de {op.display_name}</label>
                      <select
                        id={`rol-${op.user_id}`}
                        value={rolActual}
                        disabled={busy}
                        onChange={e => cambiarRol(op.user_id, e.target.value as 'operator' | 'supervisor')}
                        className="h-8 rounded-lg border border-border bg-card/40 px-2 text-[11px] text-foreground focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-50"
                      >
                        <option value="operator">operadora</option>
                        <option value="supervisor">supervisor</option>
                      </select>
                      <button
                        onClick={() => quitarMiembro(op.user_id, op.display_name)}
                        disabled={busy}
                        className="h-8 px-2.5 rounded-lg border border-red/40 text-red hover:bg-red/5 text-[11px] font-semibold transition-colors disabled:opacity-50"
                      >
                        Quitar
                      </button>
                    </div>
                  ) : (
                    <div className="flex gap-1.5 flex-shrink-0">
                      {op.roles.map(r => (
                        <span
                          key={r}
                          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold ${
                            r === 'admin' || r === 'owner'
                              ? 'bg-warning/14 border border-warning/30 text-warning'
                              : 'bg-info/14 border border-info/30 text-info'
                          }`}
                        >{r === 'owner' ? 'dueño' : r}</span>
                      ))}
                    </div>
                  )}
                </div>
                );
              })}
            </div>
          </TiltCard>
          </motion.div>

          {/* ReportsTable (aperturas/cierres) se quitó de Configuración: era un
              duplicado de la vista "Apertura y cierre por operadora" de la
              pestaña "Reportes diarios" (con límite fijo y sin filtro de
              fechas) — dos hogares para los mismos turnos hacían divergir lo
              que veía el dueño. La pestaña Reportes es la única fuente. */}
        </div>
      )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}


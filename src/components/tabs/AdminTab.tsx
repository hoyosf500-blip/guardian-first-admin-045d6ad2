import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { CheckCircle2, XCircle, PhoneOff, Key, Save, Eye, EyeOff, Loader2, Wifi, WifiOff, AlertTriangle, X, Lock, RefreshCw } from 'lucide-react';
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

  // Dropi Bearer flow (login email+password → token) — used by dropi-update-order
  const WHITE_BRAND_DEFAULT = 'df3e6b0bb66ceaadca4f84cbc371fd66e04d20fe51fc414da8d1b84d31d178de';
  const [dropiEmail, setDropiEmail] = useState('');
  const [dropiEmailSaved, setDropiEmailSaved] = useState('');
  const [dropiPassword, setDropiPassword] = useState('');
  const [dropiPasswordSaved, setDropiPasswordSaved] = useState('');
  const [dropiWhiteBrandId, setDropiWhiteBrandId] = useState(WHITE_BRAND_DEFAULT);
  const [dropiWhiteBrandIdSaved, setDropiWhiteBrandIdSaved] = useState(WHITE_BRAND_DEFAULT);
  const [dropiTtl, setDropiTtl] = useState('25');
  const [dropiTtlSaved, setDropiTtlSaved] = useState('25');
  const [dropiEnv, setDropiEnv] = useState<'prod' | 'test'>('prod');
  const [dropiEnvSaved, setDropiEnvSaved] = useState<'prod' | 'test'>('prod');
  const [showPassword, setShowPassword] = useState(false);
  const [showWhiteBrandId, setShowWhiteBrandId] = useState(false);
  const [savingBearer, setSavingBearer] = useState(false);
  const [testingBearer, setTestingBearer] = useState(false);
  const [bearerTestResult, setBearerTestResult] = useState<'ok' | 'fail' | null>(null);
  const [tokenAt, setTokenAt] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(Date.now());

  useEffect(() => {
    if (!isAdmin) return;
    loadData();
    loadDropiKey();
    loadDropiBearerSettings();
    loadFailedSyncs();
  }, [isAdmin]);

  // Ticks every 10s so the "token valid · expires in …" indicator stays fresh.
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 10000);
    return () => clearInterval(id);
  }, []);

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

  async function loadDropiBearerSettings() {
    const keys = [
      'dropi_email',
      'dropi_password',
      'dropi_white_brand_id',
      'dropi_token_ttl_min',
      'dropi_env',
      'dropi_token_at',
    ];
    const { data } = await supabase
      .from('app_settings')
      .select('key, value')
      .in('key', keys);
    const map = new Map<string, string>();
    (data || []).forEach((row: { key: string; value: string }) => map.set(row.key, row.value || ''));

    const email = map.get('dropi_email') || '';
    const password = map.get('dropi_password') || '';
    const wbId = map.get('dropi_white_brand_id') || WHITE_BRAND_DEFAULT;
    const ttl = map.get('dropi_token_ttl_min') || '25';
    const envRaw = (map.get('dropi_env') || 'prod').toLowerCase();
    const env: 'prod' | 'test' = envRaw === 'test' ? 'test' : 'prod';
    const tAt = map.get('dropi_token_at') || '';

    setDropiEmail(email);
    setDropiEmailSaved(email);
    setDropiPassword(password);
    setDropiPasswordSaved(password);
    setDropiWhiteBrandId(wbId);
    setDropiWhiteBrandIdSaved(wbId);
    setDropiTtl(ttl);
    setDropiTtlSaved(ttl);
    setDropiEnv(env);
    setDropiEnvSaved(env);
    setTokenAt(tAt || null);
  }

  async function saveDropiBearerSettings() {
    // Validation
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(dropiEmail.trim())) {
      toast.error('Email inválido');
      return;
    }
    if (!dropiPassword.trim()) {
      toast.error('La contraseña no puede estar vacía');
      return;
    }
    if (dropiWhiteBrandId.trim().length < 10) {
      toast.error('white_brand_id demasiado corto');
      return;
    }
    const ttlNum = parseInt(dropiTtl, 10);
    if (isNaN(ttlNum) || ttlNum < 5 || ttlNum > 120) {
      toast.error('TTL debe estar entre 5 y 120 minutos');
      return;
    }

    setSavingBearer(true);
    try {
      const rows = [
        { key: 'dropi_email', value: dropiEmail.trim() },
        { key: 'dropi_password', value: dropiPassword.trim() },
        { key: 'dropi_white_brand_id', value: dropiWhiteBrandId.trim() },
        { key: 'dropi_token_ttl_min', value: String(ttlNum) },
        { key: 'dropi_env', value: dropiEnv },
      ];
      const { error } = await supabase
        .from('app_settings')
        .upsert(rows, { onConflict: 'key' });
      if (error) throw error;

      setDropiEmailSaved(dropiEmail.trim());
      setDropiPasswordSaved(dropiPassword.trim());
      setDropiWhiteBrandIdSaved(dropiWhiteBrandId.trim());
      setDropiTtlSaved(String(ttlNum));
      setDropiEnvSaved(dropiEnv);
      toast.success('Credenciales Dropi guardadas');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error al guardar';
      toast.error(msg);
    } finally {
      setSavingBearer(false);
    }
  }

  async function testDropiBearerLogin() {
    setTestingBearer(true);
    setBearerTestResult(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { toast.error('No hay sesión activa'); return; }
      const res = await supabase.functions.invoke('dropi-update-order', {
        body: { dryRun: true },
      });
      if (res.error) {
        setBearerTestResult('fail');
        toast.error(`Error: ${res.error.message}`);
      } else if (res.data?.ok === false || res.data?.error) {
        setBearerTestResult('fail');
        toast.error(res.data.error || 'Login falló');
      } else {
        setBearerTestResult('ok');
        toast.success('Login exitoso — token renovado');
        await loadDropiBearerSettings();
      }
    } catch (err: unknown) {
      setBearerTestResult('fail');
      const msg = err instanceof Error ? err.message : 'Error de conexión';
      toast.error(msg);
    } finally {
      setTestingBearer(false);
    }
  }

  // Token status helpers
  const ttlMinNum = parseInt(dropiTtlSaved || '25', 10) || 25;
  const tokenElapsedMs = tokenAt ? nowTick - new Date(tokenAt).getTime() : null;
  const tokenElapsedMin = tokenElapsedMs !== null ? tokenElapsedMs / 60000 : null;
  const tokenValid = tokenElapsedMin !== null && !isNaN(tokenElapsedMin) && tokenElapsedMin >= 0 && tokenElapsedMin < ttlMinNum;
  const tokenNeverSet = !tokenAt;
  const minutesLeft = tokenValid && tokenElapsedMin !== null ? Math.max(0, Math.ceil(ttlMinNum - tokenElapsedMin)) : 0;

  const bearerDirty =
    dropiEmail !== dropiEmailSaved ||
    dropiPassword !== dropiPasswordSaved ||
    dropiWhiteBrandId !== dropiWhiteBrandIdSaved ||
    dropiTtl !== dropiTtlSaved ||
    dropiEnv !== dropiEnvSaved;

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

          {/* Dropi Bearer Credentials (login email+password → token) */}
          <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.025 }} className="bg-card rounded-xl border border-border overflow-hidden md:col-span-2">
            <div className="px-5 py-4 border-b border-border flex items-center gap-2">
              <Lock size={16} className="text-primary" />
              <div>
                <h3 className="text-sm font-semibold text-foreground">Credenciales Dropi (flujo Bearer)</h3>
                <p className="text-xs text-muted-foreground mt-0.5">Login con email + contraseña para actualizar el estado de órdenes en Dropi al confirmar</p>
              </div>
            </div>

            <div className="px-5 py-4 space-y-3">
              {/* Email */}
              <div>
                <label className="block text-[10px] font-semibold text-muted-foreground mb-1 uppercase tracking-wide">Email</label>
                <input
                  type="email"
                  value={dropiEmail}
                  onChange={e => setDropiEmail(e.target.value)}
                  placeholder="usuario@gmail.com"
                  className="w-full h-10 rounded-lg border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>

              {/* Password + white_brand_id side by side on md+ */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-semibold text-muted-foreground mb-1 uppercase tracking-wide">Contraseña</label>
                  <div className="relative">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={dropiPassword}
                      onChange={e => setDropiPassword(e.target.value)}
                      placeholder="••••••••"
                      className="w-full h-10 rounded-lg border border-border bg-background px-3 pr-10 text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-[10px] font-semibold text-muted-foreground mb-1 uppercase tracking-wide">white_brand_id</label>
                  <div className="relative">
                    <input
                      type={showWhiteBrandId ? 'text' : 'password'}
                      value={dropiWhiteBrandId}
                      onChange={e => setDropiWhiteBrandId(e.target.value)}
                      placeholder="df3e6b..."
                      className="w-full h-10 rounded-lg border border-border bg-background px-3 pr-10 text-xs font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
                    <button
                      type="button"
                      onClick={() => setShowWhiteBrandId(!showWhiteBrandId)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {showWhiteBrandId ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </div>
              </div>

              {/* TTL + Env */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-semibold text-muted-foreground mb-1 uppercase tracking-wide">TTL token (minutos)</label>
                  <input
                    type="number"
                    min={5}
                    max={120}
                    value={dropiTtl}
                    onChange={e => setDropiTtl(e.target.value)}
                    className="w-full h-10 rounded-lg border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-muted-foreground mb-1 uppercase tracking-wide">Entorno</label>
                  <select
                    value={dropiEnv}
                    onChange={e => setDropiEnv(e.target.value as 'prod' | 'test')}
                    className="w-full h-10 rounded-lg border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
                  >
                    <option value="prod">Producción (api.dropi.co)</option>
                    <option value="test">Prueba (test-api.dropi.co)</option>
                  </select>
                </div>
              </div>

              {/* Actions */}
              <div className="flex gap-2 pt-1">
                <button
                  onClick={saveDropiBearerSettings}
                  disabled={savingBearer || !bearerDirty}
                  className="h-10 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium flex items-center gap-2 hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {savingBearer ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                  Guardar
                </button>
                <button
                  onClick={testDropiBearerLogin}
                  disabled={testingBearer || !dropiEmailSaved || !dropiPasswordSaved}
                  className="h-10 px-4 rounded-lg border border-border bg-secondary text-secondary-foreground text-sm font-medium flex items-center gap-2 hover:bg-secondary/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {testingBearer ? <Loader2 size={14} className="animate-spin" /> : bearerTestResult === 'ok' ? <Wifi size={14} className="text-green" /> : bearerTestResult === 'fail' ? <WifiOff size={14} className="text-red" /> : <RefreshCw size={14} />}
                  {testingBearer ? 'Probando…' : bearerTestResult === 'ok' ? 'Login OK' : bearerTestResult === 'fail' ? 'Falló' : 'Probar login'}
                </button>
              </div>
            </div>

            {/* Token status footer */}
            <div className="px-5 pb-4">
              {tokenNeverSet ? (
                <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <XCircle size={12} /> Nunca se hizo login — se hará automáticamente en el primer uso
                </span>
              ) : tokenValid ? (
                <span className="text-xs text-green flex items-center gap-1.5">
                  <CheckCircle2 size={12} /> Token vigente · caduca en ~{minutesLeft}m
                </span>
              ) : (
                <span className="text-xs text-yellow flex items-center gap-1.5">
                  <AlertTriangle size={12} /> Token expirado — se renovará en el próximo uso
                </span>
              )}
            </div>
          </motion.div>

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

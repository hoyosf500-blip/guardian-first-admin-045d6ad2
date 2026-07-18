import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useStore } from '@/contexts/StoreContext';
import { useAuth } from '@/contexts/AuthContext';
import { Key, Save, Eye, EyeOff, Loader2, Wifi, WifiOff, CheckCircle2, ExternalLink, Store as StoreIcon, Image as ImageIcon, ShoppingBag } from 'lucide-react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { TiltCard } from '@/components/ui3d';

const fadeUp = { initial: { opacity: 0, y: 16 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.35, ease: 'easeOut' } };

interface CfgRow {
  dropi_api_key: string | null;
  dropi_session_token: string | null;
  dropi_store_url: string | null;
  country_code: string;
}

/** Decodifica el `exp` (epoch en segundos) de un JWT sin verificar la firma.
 *  Lo usamos para mostrarle al dueño cuándo vence el token de sesión Dropi
 *  (la huella) — Dropi fija ese `exp` (~24 h) y no se puede alargar desde acá:
 *  el auto-refresh por login está bloqueado por el 2FA de la cuenta. */
function decodeJwtExp(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
    const payload = JSON.parse(atob(b64 + pad)) as { exp?: number };
    const exp = Number(payload.exp || 0);
    return exp > 0 ? exp : null;
  } catch {
    return null;
  }
}

/**
 * Panel de credenciales POR TIENDA (multi-tenant).
 * Lee/escribe `store_dropi_config` para la tienda ACTIVA vía RPCs gated por
 * `is_store_owner()`. Reemplazó el panel global `app_settings.dropi_*` que
 * era single-tenant y rompía cuando se agregaba una segunda tienda.
 */
export default function StoreCredentialsPanel() {
  const { activeStore, activeStoreId, isManagerOfActive, isOwnerOfActive, refresh } = useStore();
  const { user } = useAuth();

  const [loading, setLoading] = useState(true);
  const [apiKey, setApiKey] = useState('');
  const [sessionToken, setSessionToken] = useState('');
  const [storeUrl, setStoreUrl] = useState('');
  const [name, setName] = useState('');
  const [logoUrl, setLogoUrl] = useState('');

  // Login automático (renovación del session token): email+clave del panel
  // Dropi, columnas de la migración 20260706120000. La clave NUNCA se trae al
  // cliente — solo un flag de "hay clave guardada".
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [savedLoginEmail, setSavedLoginEmail] = useState('');
  const [hasLoginPassword, setHasLoginPassword] = useState(false);
  const [showLoginPass, setShowLoginPass] = useState(false);
  const [savingLogin, setSavingLogin] = useState(false);
  const [sessionRefreshedAt, setSessionRefreshedAt] = useState<string | null>(null);
  const [loginColsMissing, setLoginColsMissing] = useState(false);

  // saved snapshots (para detectar dirty)
  const [savedApiKey, setSavedApiKey] = useState('');
  const [savedSession, setSavedSession] = useState('');
  const [savedUrl, setSavedUrl] = useState('');
  const [savedName, setSavedName] = useState('');
  const [savedLogo, setSavedLogo] = useState('');

  const [showApi, setShowApi] = useState(false);
  const [showSession, setShowSession] = useState(false);
  const [savingCreds, setSavingCreds] = useState(false);
  const [savingBrand, setSavingBrand] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<'ok' | 'fail' | null>(null);

  // Shopify (por tienda) — reconciliación anti-fuga.
  // Dev Dashboard de Shopify: se guarda Client ID + Client Secret (shpss_…) y
  // la edge function obtiene el token de Admin API en runtime (vence cada 24h
  // pero se renueva solo). NO se pega un token estático.
  const [shopDomain, setShopDomain] = useState('');
  const [shopClientId, setShopClientId] = useState('');
  const [shopClientSecret, setShopClientSecret] = useState('');
  const [shopConfigured, setShopConfigured] = useState(false);
  const [shopAuthMode, setShopAuthMode] = useState<string | null>(null);
  const [showShopSecret, setShowShopSecret] = useState(false);
  const [savingShop, setSavingShop] = useState(false);
  const [testingShop, setTestingShop] = useState(false);
  const [shopTestMsg, setShopTestMsg] = useState<string | null>(null);
  // Auto-envío Shopify → Dropi (robot shopify-auto-push, cron cada 15 min).
  const [shopAutoPush, setShopAutoPush] = useState(false);
  const [shopAutoPushBusy, setShopAutoPushBusy] = useState(false);

  useEffect(() => {
    if (!activeStoreId || !isManagerOfActive) { setLoading(false); return; }
    let cancelled = false;
    void (async () => {
      setLoading(true);
      const { data } = await supabase
        .from('store_dropi_config')
        .select('dropi_api_key, dropi_session_token, dropi_store_url, country_code')
        .eq('store_id', activeStoreId)
        .maybeSingle<CfgRow>();
      if (cancelled) return;
      const ak = data?.dropi_api_key ?? '';
      const st = data?.dropi_session_token ?? '';
      const su = data?.dropi_store_url ?? '';
      setApiKey(ak); setSavedApiKey(ak);
      setSessionToken(st); setSavedSession(st);
      setStoreUrl(su); setSavedUrl(su);
      const nm = activeStore?.name ?? '';
      const lg = activeStore?.brand_logo_url ?? '';
      setName(nm); setSavedName(nm);
      setLogoUrl(lg); setSavedLogo(lg);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [activeStoreId, isManagerOfActive, activeStore]);

  // Login automático — query aparte y DEFENSIVA (mismo patrón que
  // useStoreSchedule): si las columnas no existen todavía (migración
  // 20260706120000 sin aplicar) el panel muestra el aviso y no rompe nada.
  useEffect(() => {
    if (!activeStoreId || !isManagerOfActive) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await supabase
          .from('store_dropi_config')
          .select('dropi_login_email, dropi_login_password, dropi_session_refreshed_at')
          .eq('store_id', activeStoreId)
          .maybeSingle();
        if (cancelled) return;
        if (res.error) { setLoginColsMissing(true); return; }
        const d = res.data as {
          dropi_login_email?: string | null;
          dropi_login_password?: string | null;
          dropi_session_refreshed_at?: string | null;
        } | null;
        setLoginColsMissing(false);
        setLoginEmail(d?.dropi_login_email ?? '');
        setSavedLoginEmail(d?.dropi_login_email ?? '');
        setHasLoginPassword(Boolean(d?.dropi_login_password));
        setLoginPassword('');
        setSessionRefreshedAt(d?.dropi_session_refreshed_at ?? null);
      } catch {
        if (!cancelled) setLoginColsMissing(true);
      }
    })();
    return () => { cancelled = true; };
  }, [activeStoreId, isManagerOfActive]);

  // Estado de Shopify (configurado + dominio; el token NUNCA se trae al cliente).
  useEffect(() => {
    if (!activeStoreId || !isManagerOfActive) return;
    let cancelled = false;
    void (async () => {
      const { data } = await (supabase.rpc as unknown as (
        fn: string, args: Record<string, unknown>
      ) => Promise<{ data: { configured: boolean; shop_domain: string | null; auth_mode: string | null }[] | null }>)(
        'get_store_shopify_status', { p_store_id: activeStoreId },
      );
      if (cancelled) return;
      const row = Array.isArray(data) ? data[0] : null;
      setShopConfigured(Boolean(row?.configured));
      setShopDomain(row?.shop_domain || '');
      setShopAuthMode(row?.auth_mode ?? null);
      setShopClientId('');
      setShopClientSecret('');
      // Estado del auto-envío (RPC aparte; degrada a false si la migración aún
      // no corrió → el toggle sale apagado sin romper).
      try {
        const { data: ap } = await (supabase.rpc as unknown as (
          fn: string, args: Record<string, unknown>
        ) => Promise<{ data: boolean | null }>)('get_store_shopify_auto_push', { p_store_id: activeStoreId });
        if (!cancelled) setShopAutoPush(Boolean(ap));
      } catch { if (!cancelled) setShopAutoPush(false); }
    })();
    return () => { cancelled = true; };
  }, [activeStoreId, isManagerOfActive]);

  async function saveCreds() {
    if (!activeStoreId || !activeStore) return;
    setSavingCreds(true);
    type RpcRes = { error: { message: string } | null };
    const { error } = await (supabase.rpc as unknown as (fn: string, args: Record<string, unknown>) => Promise<RpcRes>)(
      'upsert_store_dropi_config',
      {
        p_store_id: activeStoreId,
        p_country_code: activeStore.country_code,
        p_dropi_api_key: apiKey.trim(),
        p_dropi_session_token: sessionToken.trim(),
        p_dropi_store_url: storeUrl.trim(),
      },
    );
    setSavingCreds(false);
    if (error) { toast.error('No se pudo guardar', { description: error.message }); return; }
    setSavedApiKey(apiKey.trim());
    setSavedSession(sessionToken.trim());
    setSavedUrl(storeUrl.trim());
    toast.success('Credenciales Dropi guardadas');
    await refresh();
  }

  async function saveLogin() {
    if (!activeStoreId) return;
    setSavingLogin(true);
    type RpcRes = { error: { message: string } | null };
    const { error } = await (supabase.rpc as unknown as (fn: string, args: Record<string, unknown>) => Promise<RpcRes>)(
      'upsert_store_dropi_login',
      { p_store_id: activeStoreId, p_login_email: loginEmail.trim(), p_login_password: loginPassword },
    );
    setSavingLogin(false);
    if (error) {
      const missing = /does not exist|could not find|PGRST202|42883/i.test(error.message || '');
      toast.error(
        missing ? 'Falta aplicar la migración SQL del login automático' : 'No se pudo guardar el login',
        { description: error.message },
      );
      return;
    }
    setSavedLoginEmail(loginEmail.trim());
    if (loginPassword) setHasLoginPassword(true);
    setLoginPassword('');
    toast.success(loginEmail.trim() ? 'Login automático guardado' : 'Login automático desactivado');
  }

  async function saveBrand() {
    if (!activeStoreId) return;
    setSavingBrand(true);
    type RpcRes = { error: { message: string } | null };
    const { error } = await (supabase.rpc as unknown as (fn: string, args: Record<string, unknown>) => Promise<RpcRes>)(
      'update_store_branding',
      { p_store_id: activeStoreId, p_name: name.trim(), p_brand_logo_url: logoUrl.trim() },
    );
    setSavingBrand(false);
    if (error) { toast.error('No se pudo guardar', { description: error.message }); return; }
    setSavedName(name.trim());
    setSavedLogo(logoUrl.trim());
    toast.success('Branding actualizado');
    await refresh();
  }

  const [testDetail, setTestDetail] = useState<string | null>(null);

  /** Lee el motivo REAL aunque dropi-sync devuelva non-2xx. En supabase-js v2,
   *  `error.context` es un Response (no string): hay que leer su cuerpo. Antes
   *  solo se veía el genérico "Edge Function returned a non-2xx status code",
   *  que ocultaba el rechazo real de Dropi (ej. 401/403, IP block). */
  async function readInvokeError(error: unknown): Promise<string> {
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.text === 'function') {
      try {
        const body = await ctx.text();
        if (body) {
          try {
            const j = JSON.parse(body) as { error?: string; message?: string };
            return j.error || j.message || body.slice(0, 400);
          } catch { return body.slice(0, 400); }
        }
      } catch { /* sigue al fallback */ }
    }
    return (error as { message?: string }).message || 'Error de conexión';
  }

  async function testConnection() {
    if (!activeStoreId) return;
    setTesting(true); setTestResult(null); setTestDetail(null);
    try {
      const today = new Date().toISOString().split('T')[0];
      const res = await supabase.functions.invoke('dropi-sync', {
        body: { mode: 'probe', from: today, untill: today, store_id: activeStoreId },
      });
      if (res.error) {
        const detail = await readInvokeError(res.error);
        setTestResult('fail'); setTestDetail(detail);
        toast.error('Falló la conexión con Dropi', { description: detail });
      } else if (res.data?.error) {
        setTestResult('fail'); setTestDetail(res.data.error);
        toast.error('Falló la conexión con Dropi', { description: res.data.error });
      } else {
        setTestResult('ok');
        setTestDetail(res.data?.rateLimited ? 'Dropi limitó la prueba, pero autenticó la credencial.' : null);
        toast.success(res.data?.message || 'Conexión OK');
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Error de conexión';
      setTestResult('fail'); setTestDetail(detail);
      toast.error('Falló la conexión con Dropi', { description: detail });
    } finally {
      setTesting(false);
    }
  }

  async function saveShopify() {
    if (!activeStoreId) return;
    if (!shopDomain.trim() || !shopClientId.trim() || !shopClientSecret.trim()) {
      toast.error('Pegá dominio, Client ID y Client Secret de Shopify'); return;
    }
    setSavingShop(true);
    type RpcRes = { error: { message: string } | null };
    const { error } = await (supabase.rpc as unknown as (fn: string, args: Record<string, unknown>) => Promise<RpcRes>)(
      'upsert_store_shopify_credentials',
      {
        p_store_id: activeStoreId,
        p_shop_domain: shopDomain.trim(),
        p_client_id: shopClientId.trim(),
        p_client_secret: shopClientSecret.trim(),
      },
    );
    setSavingShop(false);
    if (error) { toast.error('No se pudo guardar Shopify', { description: error.message }); return; }
    setShopConfigured(true);
    setShopAuthMode('client_credentials');
    setShopClientId('');
    setShopClientSecret('');
    toast.success('Shopify conectado');
  }

  async function testShopify() {
    if (!activeStoreId) return;
    setTestingShop(true); setShopTestMsg(null);
    try {
      const { data, error } = await supabase.functions.invoke('shopify-reconcile', { body: { store_id: activeStoreId, days: 1 } });
      const r = data as { ok?: boolean; configured?: boolean; shopifyTotal?: number; pendingCount?: number; error?: string } | null;
      if (error || !r?.ok) { setShopTestMsg('Falló: ' + (error?.message || r?.error || 'error')); return; }
      if (!r.configured) { setShopTestMsg('Falta guardar dominio + token.'); return; }
      setShopTestMsg(`OK — ${r.shopifyTotal ?? 0} pedidos hoy en Shopify, ${r.pendingCount ?? 0} sin pasar a Dropi.`);
    } catch (e) {
      setShopTestMsg('Falló: ' + (e instanceof Error ? e.message : 'error'));
    } finally { setTestingShop(false); }
  }

  async function toggleAutoPush(next: boolean) {
    if (!activeStoreId || shopAutoPushBusy) return;
    const prev = shopAutoPush;
    setShopAutoPush(next);            // optimista
    setShopAutoPushBusy(true);
    const { error } = await (supabase.rpc as unknown as (
      fn: string, args: Record<string, unknown>
    ) => Promise<{ error: { message: string } | null }>)(
      'set_store_shopify_auto_push', { p_store_id: activeStoreId, p_enabled: next },
    );
    setShopAutoPushBusy(false);
    if (error) {
      setShopAutoPush(prev);          // revertir
      toast.error('No se pudo cambiar el auto-envío', { description: error.message });
      return;
    }
    toast.success(next ? 'Auto-envío a Dropi ACTIVADO' : 'Auto-envío a Dropi apagado');
  }

  if (!user) return null;
  if (!activeStore) {
    return (
      <div className="md:col-span-2 rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
        No hay tienda activa.
      </div>
    );
  }
  if (!isManagerOfActive) {
    return (
      <div className="md:col-span-2 rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
        Solo el dueño o supervisor de <span className="font-medium text-foreground">{activeStore.name}</span> puede ver/editar las credenciales.
      </div>
    );
  }
  if (loading) {
    return (
      <div className="md:col-span-2 rounded-xl border border-border bg-card p-5 flex items-center justify-center">
        <Loader2 className="animate-spin text-muted-foreground" size={18} />
      </div>
    );
  }

  const credsDirty = apiKey !== savedApiKey || sessionToken !== savedSession || storeUrl !== savedUrl;
  const brandDirty = name !== savedName || logoUrl !== savedLogo;

  // Host de Dropi según el país de la tienda (para las instrucciones de la huella).
  const dropiHost = activeStore.country_code === 'EC' ? 'app.dropi.ec' : 'app.dropi.co';
  const apiDropiHost = activeStore.country_code === 'EC' ? 'api.dropi.ec' : 'api.dropi.co';

  // Vencimiento REAL del token de sesión (decodificado del JWT). Le muestra al
  // dueño cuánto le queda de vida al token de la huella y le avisa antes de que
  // venza, así lo refresca a tiempo en vez de adivinar.
  const sessionExp = sessionToken.trim() ? decodeJwtExp(sessionToken.trim()) : null;
  const sessionExpired = sessionExp != null && sessionExp * 1000 < Date.now();
  const sessionHoursLeft = sessionExp != null
    ? Math.max(0, Math.round((sessionExp * 1000 - Date.now()) / 3_600_000))
    : null;

  return (
    <>
      {/* Credenciales Dropi (POR TIENDA) */}
      <motion.div {...fadeUp} className="md:col-span-2">
      <TiltCard sheen brackets className="bg-card/40 border border-border rounded-3xl shadow-card3d-lg">
        <div className="px-6 py-5 border-b border-border flex items-center gap-2.5">
          <span className="w-8 h-8 rounded-xl bg-info/14 border border-info/30 text-info flex items-center justify-center flex-shrink-0" aria-hidden="true">
            <Key size={15} />
          </span>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-foreground">Credenciales Dropi · {activeStore.name}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              País: <span className="font-medium text-foreground font-mono tabular-nums">{activeStore.country_code}</span> — cada tienda guarda sus propias credenciales.
            </p>
          </div>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* API Key */}
          <div>
            <label className="hud-label">API Key de Dropi (Bearer permanente)</label>
            <div className="mt-1 flex gap-2">
              <div className="relative flex-1">
                <input
                  type={showApi ? 'text' : 'password'}
                  value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                  placeholder="eyJ0eXAi..."
                  className="w-full h-10 rounded-xl border border-border bg-card/40 px-3 pr-10 text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-accent/30"
                />
                <button type="button" onClick={() => setShowApi(!showApi)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  {showApi ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>
          </div>
          {/* Session token */}
          <div>
            <label className="hud-label">Token de sesión (JWT — para wallet & huella)</label>
            <div className="mt-1 flex gap-2">
              <div className="relative flex-1">
                <input
                  type={showSession ? 'text' : 'password'}
                  value={sessionToken}
                  onChange={e => setSessionToken(e.target.value)}
                  placeholder="eyJhbGci... (vence ~12-24h)"
                  className="w-full h-10 rounded-xl border border-border bg-card/40 px-3 pr-10 text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-accent/30"
                />
                <button type="button" onClick={() => setShowSession(!showSession)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  {showSession ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>
            {/* Vencimiento real del token (decodificado del JWT) */}
            {sessionToken.trim() && (
              sessionExp == null ? (
                <p className="mt-1 text-[11px] text-muted-foreground">No se pudo leer el vencimiento de este token.</p>
              ) : sessionExpired ? (
                <p className="mt-1 text-[11px] text-danger font-medium">Token VENCIDO — refrescalo con los pasos de abajo.</p>
              ) : (
                <p className={`mt-1 text-[11px] ${sessionHoursLeft !== null && sessionHoursLeft <= 3 ? 'text-warning font-medium' : 'text-muted-foreground'}`}>
                  Vence: {new Date(sessionExp * 1000).toLocaleString('es-CO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  {sessionHoursLeft !== null && <> · en ~{sessionHoursLeft} h</>}
                </p>
              )
            )}
            {/* Cómo sacar el token de la huella (método localStorage, como antes) */}
            <details className="mt-2 text-[11px] text-muted-foreground">
              <summary className="cursor-pointer hover:text-foreground transition-colors">Cómo obtener el token de la huella</summary>
              <ol className="mt-2 ml-4 list-decimal space-y-1 leading-relaxed">
                <li>Abrí <strong>{dropiHost}</strong> y asegurate de estar logueado.</li>
                <li>Presioná <strong>F12</strong> para abrir las herramientas del navegador.</li>
                <li>Andá a la pestaña <strong>Console</strong> (Consola).</li>
                <li>Escribí: <code className="bg-muted px-1 rounded">JSON.parse(localStorage.getItem('DROPI_token'))</code></li>
                <li>Copiá el texto que aparece (empieza con <code className="bg-muted px-1 rounded">eyJ…</code>).</li>
                <li>Pegalo arriba en <strong>Token de sesión</strong> y dale <strong>Guardar credenciales</strong>.</li>
              </ol>
              <p className="mt-2">
                Si no aparece, también podés copiarlo desde DevTools → Network → header <code className="bg-muted px-1 rounded">x-authorization</code> de cualquier llamada a <code className="bg-muted px-1 rounded">{apiDropiHost}</code>.
              </p>
              <p className="mt-2 text-yellow-600 dark:text-yellow-400">
                Este token vence cada ~24 h (lo fija Dropi). Configurá el <strong>login automático</strong> de abajo para que se renueve solo.
              </p>
            </details>
          </div>

          {/* Login automático: renueva el session token solo cuando vence */}
          <div className="rounded-lg border border-border bg-muted/20 p-3">
            <label className="hud-label">
              Login automático (renueva el token solo)
            </label>
            <div className="mt-1.5 grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input
                type="email"
                value={loginEmail}
                onChange={e => setLoginEmail(e.target.value)}
                placeholder="email de app.dropi…"
                autoComplete="off"
                className="w-full h-10 rounded-xl border border-border bg-card/40 px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/30"
              />
              <div className="relative">
                <input
                  type={showLoginPass ? 'text' : 'password'}
                  value={loginPassword}
                  onChange={e => setLoginPassword(e.target.value)}
                  placeholder={hasLoginPassword ? '•••••• (guardada — escribí para cambiarla)' : 'contraseña de Dropi'}
                  autoComplete="new-password"
                  className="w-full h-10 rounded-xl border border-border bg-card/40 px-3 pr-10 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/30"
                />
                <button type="button" onClick={() => setShowLoginPass(!showLoginPass)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  {showLoginPass ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground leading-relaxed">
              Cuando el token venza, el sistema entra solo a Dropi con este email+clave y lo renueva
              (Cambiar transportadora, Cambiar valor y Subir a Dropi dejan de morirse cada día).{' '}
              <strong>No funciona si la cuenta tiene verificación en dos pasos (2FA)</strong> — Dropi
              bloquea ese login; en ese caso desactivá el 2FA de la cuenta o seguí pegando el token a
              mano. Para apagar el auto-login, borrá el email y guardá.
            </p>
            {sessionRefreshedAt && (
              <p className="mt-1 text-[11px] text-success">
                Última renovación automática: {new Date(sessionRefreshedAt).toLocaleString('es-CO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
              </p>
            )}
            {loginColsMissing && (
              <p className="mt-1 text-[11px] text-warning font-medium">
                Requiere aplicar la migración SQL 20260706120000 (columnas de login en store_dropi_config).
              </p>
            )}
            <div className="mt-2 flex justify-end">
              <button
                onClick={saveLogin}
                disabled={savingLogin || loginColsMissing || (loginEmail.trim() === savedLoginEmail && !loginPassword)}
                className="h-8 px-3 btn-accent-3d rounded-xl text-xs font-semibold flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {savingLogin ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                Guardar login
              </button>
            </div>
          </div>
          {/* Store URL */}
          <div>
            <label className="hud-label">URL de integración Dropi</label>
            <input
              type="url"
              value={storeUrl}
              onChange={e => setStoreUrl(e.target.value)}
              placeholder="https://rushmira.com/"
              className="mt-1 w-full h-10 rounded-xl border border-border bg-card/40 px-3 text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
          </div>

          <div className="flex items-center justify-between gap-3 pt-2 border-t border-border">
            <a href="https://app.dropi.co" target="_blank" rel="noreferrer" className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
              Ir a Dropi <ExternalLink size={11} />
            </a>
            <div className="flex gap-2">
              {savedApiKey && (
                <button onClick={testConnection} disabled={testing}
                  className="h-9 px-3 rounded-xl border border-border bg-card/40 text-muted-foreground hover:text-foreground hover:border-border-strong text-xs font-medium flex items-center gap-2 transition-colors disabled:opacity-50">
                  {testing ? <Loader2 size={12} className="animate-spin" /> : testResult === 'ok' ? <Wifi size={12} className="text-success" /> : testResult === 'fail' ? <WifiOff size={12} className="text-danger" /> : <Wifi size={12} />}
                  {testing ? 'Probando…' : testResult === 'ok' ? 'Conexión OK' : testResult === 'fail' ? 'Falló' : 'Probar conexión'}
                </button>
              )}
              <button onClick={saveCreds} disabled={savingCreds || !credsDirty}
                className="h-9 px-4 btn-accent-3d rounded-xl text-sm font-semibold flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed">
                {savingCreds ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                Guardar credenciales
              </button>
            </div>
          </div>
          {savedApiKey && (
            <div className="text-xs text-success flex items-center gap-1">
              <CheckCircle2 size={12} /> Credenciales cargadas
            </div>
          )}
          {testResult === 'fail' && testDetail && (
            <div className="relative rounded-2xl border border-border bg-card/40 px-3 py-2 pl-4 text-xs text-danger flex items-start gap-2 shadow-card3d">
              <span className="absolute left-0 top-2 bottom-2 w-1 rounded-full bg-danger" aria-hidden="true" />
              <WifiOff size={13} className="mt-0.5 flex-shrink-0" />
              <span className="break-words">Dropi rechazó la conexión: {testDetail}</span>
            </div>
          )}
        </div>
      </TiltCard>
      </motion.div>

      {/* Shopify (POR TIENDA) — reconciliación anti-fuga */}
      <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.04 }} className="md:col-span-2">
      <TiltCard className="bg-card/40 border border-border rounded-2xl shadow-card3d">
        <div className="px-5 py-4 border-b border-border flex items-center gap-2.5">
          <span className="w-8 h-8 rounded-xl bg-success/14 border border-success/30 text-success flex items-center justify-center flex-shrink-0" aria-hidden="true">
            <ShoppingBag size={15} />
          </span>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-foreground">Shopify · {activeStore.name}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Conectá Shopify para detectar pedidos que NO pasaron a Dropi. En el <strong>Dev Dashboard</strong> de Shopify creá una app con permiso <code className="bg-muted px-1 rounded">read_orders</code> e instalala en la tienda; después pegá el <strong>Client ID</strong> y el <strong>Client Secret</strong> (<code className="bg-muted px-1 rounded">shpss_…</code>). El token se renueva solo.
            </p>
          </div>
          {shopConfigured && <span className="flex-shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-success/14 border border-success/30 text-success"><CheckCircle2 size={11} /> Conectado</span>}
        </div>
        <div className="px-5 py-4 space-y-4">
          <div>
            <label className="hud-label">Dominio de la tienda</label>
            <input type="text" value={shopDomain} onChange={e => setShopDomain(e.target.value)} placeholder="mitienda.myshopify.com"
              className="mt-1 w-full h-10 rounded-xl border border-border bg-card/40 px-3 text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-accent/30" />
          </div>
          <div>
            <label className="hud-label">Client ID</label>
            <input type="text" value={shopClientId} onChange={e => setShopClientId(e.target.value)}
              placeholder={shopConfigured ? '•••••• (pegá uno nuevo para cambiarlo)' : '367fca75556ab8cb…'}
              className="mt-1 w-full h-10 rounded-xl border border-border bg-card/40 px-3 text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-accent/30" />
          </div>
          <div>
            <label className="hud-label">Client Secret (shpss_…)</label>
            <div className="mt-1 relative">
              <input type={showShopSecret ? 'text' : 'password'} value={shopClientSecret} onChange={e => setShopClientSecret(e.target.value)}
                placeholder={shopConfigured ? '•••••• (pegá uno nuevo para cambiarlo)' : 'shpss_...'}
                className="w-full h-10 rounded-xl border border-border bg-card/40 px-3 pr-10 text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-accent/30" />
              <button type="button" onClick={() => setShowShopSecret(!showShopSecret)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                {showShopSecret ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 pt-2 border-t border-border">
            {shopTestMsg ? <span className="text-xs text-muted-foreground">{shopTestMsg}</span>
              : shopConfigured && shopAuthMode === 'token'
                ? <span className="text-xs text-warning">Conectada con token viejo — repegá Client ID + Secret para que no venza.</span>
                : <span />}
            <div className="flex gap-2">
              {shopConfigured && (
                <button onClick={testShopify} disabled={testingShop}
                  className="h-9 px-3 rounded-xl border border-border bg-card/40 text-muted-foreground hover:text-foreground hover:border-border-strong text-xs font-medium flex items-center gap-2 transition-colors disabled:opacity-50">
                  {testingShop ? <Loader2 size={12} className="animate-spin" /> : <Wifi size={12} />} Probar
                </button>
              )}
              <button onClick={saveShopify} disabled={savingShop || !shopDomain.trim() || !shopClientId.trim() || !shopClientSecret.trim()}
                className="h-9 px-4 btn-accent-3d rounded-xl text-sm font-semibold flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed">
                {savingShop ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Guardar Shopify
              </button>
            </div>
          </div>

          {/* Auto-envío: un robot sube solo los pedidos limpios cada 15 min */}
          {shopConfigured && (
            <div className="flex items-center justify-between gap-3 pt-3 border-t border-border">
              <div className="flex-1">
                <div className="text-sm font-medium text-foreground">Auto-envío a Dropi</div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Un robot sube solo los pedidos <strong>limpios</strong> cada 15 min (los dudosos —duplicado, precio raro, sin cobertura— quedan para el panel). Así no depende de que alguien apriete el botón.
                  {!isOwnerOfActive && <span className="block text-warning mt-0.5">Solo el dueño puede cambiarlo.</span>}
                </p>
              </div>
              <button
                type="button" role="switch" aria-checked={shopAutoPush}
                disabled={!isOwnerOfActive || shopAutoPushBusy}
                onClick={() => toggleAutoPush(!shopAutoPush)}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${shopAutoPush ? 'bg-primary' : 'bg-muted'}`}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-card border border-border-strong shadow transition-transform ${shopAutoPush ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
            </div>
          )}
        </div>
      </TiltCard>
      </motion.div>

      {/* Branding (POR TIENDA) */}
      <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.05 }} className="md:col-span-2">
      <TiltCard className="bg-card/40 border border-border rounded-2xl shadow-card3d">
        <div className="px-5 py-4 border-b border-border flex items-center gap-2.5">
          <span className="w-8 h-8 rounded-xl bg-accent/14 border border-accent/30 text-accent flex items-center justify-center flex-shrink-0" aria-hidden="true">
            <StoreIcon size={15} />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">Branding de la tienda</h3>
            <p className="text-xs text-muted-foreground mt-0.5">Nombre y logo que aparecen en el sidebar.</p>
          </div>
        </div>
        <div className="px-5 py-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="hud-label">Nombre</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="mt-1 w-full h-10 rounded-xl border border-border bg-card/40 px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
          </div>
          <div>
            <label className="hud-label flex items-center gap-1"><ImageIcon size={10} /> URL del logo</label>
            <input
              type="url"
              value={logoUrl}
              onChange={e => setLogoUrl(e.target.value)}
              placeholder="https://..."
              className="mt-1 w-full h-10 rounded-xl border border-border bg-card/40 px-3 text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
          </div>
          <div className="sm:col-span-2 flex justify-end">
            <button onClick={saveBrand} disabled={savingBrand || !brandDirty}
              className="h-9 px-4 btn-accent-3d rounded-xl text-sm font-semibold flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed">
              {savingBrand ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              Guardar branding
            </button>
          </div>
        </div>
      </TiltCard>
      </motion.div>
    </>
  );
}

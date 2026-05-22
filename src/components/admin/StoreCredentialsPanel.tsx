import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useStore } from '@/contexts/StoreContext';
import { useAuth } from '@/contexts/AuthContext';
import { Key, Save, Eye, EyeOff, Loader2, Wifi, WifiOff, CheckCircle2, ExternalLink, Store as StoreIcon, Image as ImageIcon, ShoppingBag } from 'lucide-react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';

const fadeUp = { initial: { opacity: 0, y: 16 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.35, ease: 'easeOut' } };

interface CfgRow {
  dropi_api_key: string | null;
  dropi_session_token: string | null;
  dropi_store_url: string | null;
  country_code: string;
}

/**
 * Panel de credenciales POR TIENDA (multi-tenant).
 * Lee/escribe `store_dropi_config` para la tienda ACTIVA vía RPCs gated por
 * `is_store_owner()`. Reemplazó el panel global `app_settings.dropi_*` que
 * era single-tenant y rompía cuando se agregaba una segunda tienda.
 */
export default function StoreCredentialsPanel() {
  const { activeStore, activeStoreId, isManagerOfActive, refresh } = useStore();
  const { user } = useAuth();

  const [loading, setLoading] = useState(true);
  const [apiKey, setApiKey] = useState('');
  const [sessionToken, setSessionToken] = useState('');
  const [storeUrl, setStoreUrl] = useState('');
  const [name, setName] = useState('');
  const [logoUrl, setLogoUrl] = useState('');

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

  return (
    <>
      {/* Credenciales Dropi (POR TIENDA) */}
      <motion.div {...fadeUp} className="bg-card rounded-xl border border-border overflow-hidden md:col-span-2">
        <div className="px-5 py-4 border-b border-border flex items-center gap-2">
          <Key size={16} className="text-primary" />
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-foreground">Credenciales Dropi · {activeStore.name}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              País: <span className="font-medium text-foreground">{activeStore.country_code}</span> — cada tienda guarda sus propias credenciales.
            </p>
          </div>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* API Key */}
          <div>
            <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">API Key de Dropi (Bearer permanente)</label>
            <div className="mt-1 flex gap-2">
              <div className="relative flex-1">
                <input
                  type={showApi ? 'text' : 'password'}
                  value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                  placeholder="eyJ0eXAi..."
                  className="w-full h-10 rounded-lg border border-border bg-background px-3 pr-10 text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
                <button type="button" onClick={() => setShowApi(!showApi)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  {showApi ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>
          </div>
          {/* Session token */}
          <div>
            <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Token de sesión (JWT — para wallet & huella)</label>
            <div className="mt-1 flex gap-2">
              <div className="relative flex-1">
                <input
                  type={showSession ? 'text' : 'password'}
                  value={sessionToken}
                  onChange={e => setSessionToken(e.target.value)}
                  placeholder="eyJhbGci... (vence ~12-24h)"
                  className="w-full h-10 rounded-lg border border-border bg-background px-3 pr-10 text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
                <button type="button" onClick={() => setShowSession(!showSession)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  {showSession ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Refrescá en DevTools → Network → header <code className="bg-muted px-1 rounded">x-authorization</code> en cualquier llamada a <code className="bg-muted px-1 rounded">api.dropi.{activeStore.country_code === 'EC' ? 'ec' : 'co'}</code>.
            </p>
          </div>
          {/* Store URL */}
          <div>
            <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">URL de integración Dropi</label>
            <input
              type="url"
              value={storeUrl}
              onChange={e => setStoreUrl(e.target.value)}
              placeholder="https://rushmira.com/"
              className="mt-1 w-full h-10 rounded-lg border border-border bg-background px-3 text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div className="flex items-center justify-between gap-3 pt-2 border-t border-border">
            <a href="https://app.dropi.co" target="_blank" rel="noreferrer" className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
              Ir a Dropi <ExternalLink size={11} />
            </a>
            <div className="flex gap-2">
              {savedApiKey && (
                <button onClick={testConnection} disabled={testing}
                  className="h-9 px-3 rounded-lg border border-border bg-secondary text-secondary-foreground text-xs font-medium flex items-center gap-2 hover:bg-secondary/80 transition-colors disabled:opacity-50">
                  {testing ? <Loader2 size={12} className="animate-spin" /> : testResult === 'ok' ? <Wifi size={12} className="text-success" /> : testResult === 'fail' ? <WifiOff size={12} className="text-danger" /> : <Wifi size={12} />}
                  {testing ? 'Probando…' : testResult === 'ok' ? 'Conexión OK' : testResult === 'fail' ? 'Falló' : 'Probar conexión'}
                </button>
              )}
              <button onClick={saveCreds} disabled={savingCreds || !credsDirty}
                className="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium flex items-center gap-2 hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
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
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive flex items-start gap-2">
              <WifiOff size={13} className="mt-0.5 flex-shrink-0" />
              <span className="break-words">Dropi rechazó la conexión: {testDetail}</span>
            </div>
          )}
        </div>
      </motion.div>

      {/* Shopify (POR TIENDA) — reconciliación anti-fuga */}
      <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.04 }} className="bg-card rounded-xl border border-border overflow-hidden md:col-span-2">
        <div className="px-5 py-4 border-b border-border flex items-center gap-2">
          <ShoppingBag size={16} className="text-primary" />
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-foreground">Shopify · {activeStore.name}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Conectá Shopify para detectar pedidos que NO pasaron a Dropi. En el <strong>Dev Dashboard</strong> de Shopify creá una app con permiso <code className="bg-muted px-1 rounded">read_orders</code> e instalala en la tienda; después pegá el <strong>Client ID</strong> y el <strong>Client Secret</strong> (<code className="bg-muted px-1 rounded">shpss_…</code>). El token se renueva solo.
            </p>
          </div>
          {shopConfigured && <span className="text-xs text-success flex items-center gap-1"><CheckCircle2 size={12} /> Conectado</span>}
        </div>
        <div className="px-5 py-4 space-y-4">
          <div>
            <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Dominio de la tienda</label>
            <input type="text" value={shopDomain} onChange={e => setShopDomain(e.target.value)} placeholder="mitienda.myshopify.com"
              className="mt-1 w-full h-10 rounded-lg border border-border bg-background px-3 text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30" />
          </div>
          <div>
            <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Client ID</label>
            <input type="text" value={shopClientId} onChange={e => setShopClientId(e.target.value)}
              placeholder={shopConfigured ? '•••••• (pegá uno nuevo para cambiarlo)' : '367fca75556ab8cb…'}
              className="mt-1 w-full h-10 rounded-lg border border-border bg-background px-3 text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30" />
          </div>
          <div>
            <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Client Secret (shpss_…)</label>
            <div className="mt-1 relative">
              <input type={showShopSecret ? 'text' : 'password'} value={shopClientSecret} onChange={e => setShopClientSecret(e.target.value)}
                placeholder={shopConfigured ? '•••••• (pegá uno nuevo para cambiarlo)' : 'shpss_...'}
                className="w-full h-10 rounded-lg border border-border bg-background px-3 pr-10 text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30" />
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
                  className="h-9 px-3 rounded-lg border border-border bg-secondary text-secondary-foreground text-xs font-medium flex items-center gap-2 hover:bg-secondary/80 disabled:opacity-50">
                  {testingShop ? <Loader2 size={12} className="animate-spin" /> : <Wifi size={12} />} Probar
                </button>
              )}
              <button onClick={saveShopify} disabled={savingShop || !shopDomain.trim() || !shopClientId.trim() || !shopClientSecret.trim()}
                className="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium flex items-center gap-2 hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed">
                {savingShop ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Guardar Shopify
              </button>
            </div>
          </div>
        </div>
      </motion.div>

      {/* Branding (POR TIENDA) */}
      <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.05 }} className="bg-card rounded-xl border border-border overflow-hidden md:col-span-2">
        <div className="px-5 py-4 border-b border-border flex items-center gap-2">
          <StoreIcon size={16} className="text-primary" />
          <div>
            <h3 className="text-sm font-semibold text-foreground">Branding de la tienda</h3>
            <p className="text-xs text-muted-foreground mt-0.5">Nombre y logo que aparecen en el sidebar.</p>
          </div>
        </div>
        <div className="px-5 py-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Nombre</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="mt-1 w-full h-10 rounded-lg border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
          <div>
            <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1"><ImageIcon size={10} /> URL del logo</label>
            <input
              type="url"
              value={logoUrl}
              onChange={e => setLogoUrl(e.target.value)}
              placeholder="https://..."
              className="mt-1 w-full h-10 rounded-lg border border-border bg-background px-3 text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
          <div className="sm:col-span-2 flex justify-end">
            <button onClick={saveBrand} disabled={savingBrand || !brandDirty}
              className="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium flex items-center gap-2 hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
              {savingBrand ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              Guardar branding
            </button>
          </div>
        </div>
      </motion.div>
    </>
  );
}

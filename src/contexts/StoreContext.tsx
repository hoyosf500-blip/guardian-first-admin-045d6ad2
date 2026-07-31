import { createContext, useContext, useEffect, useState, useCallback, useRef, ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './AuthContext';
import { setTrackingCountry } from '@/lib/orderUtils';
import { setCurrencyCountry } from '@/lib/utils';

export type StoreRole = 'owner' | 'supervisor' | 'operator';

export interface StoreMembership {
  id: string;
  name: string;
  country_code: string;
  role: StoreRole;
  brand_logo_url: string | null;
  status: string;
  // ¿La tienda tiene credenciales Dropi cargadas? (sólo visible para owner)
  hasDropiKey?: boolean;
}

interface StoreState {
  loading: boolean;
  stores: StoreMembership[];
  activeStoreId: string | null;
  activeStore: StoreMembership | null;
  isOwnerOfActive: boolean;
  // owner O supervisor de la tienda activa — pueden entrar a Admin/Logística.
  isManagerOfActive: boolean;
  needsSetup: boolean;        // owner + tienda activa sin dropi_api_key
  /**
   * ¿Quedó sincronizada la tienda activa EN EL SERVIDOR (profiles.active_store_id)?
   *
   * Importa porque las RPC de reportes/logística/productividad no reciben la
   * tienda: la resuelven solas con `_resolve_scope_store()`, que para un admin
   * lee esa columna. Si la sync falla, el encabezado dice "Ecuador" y las
   * tablas responden por otra tienda (o vacías, desde el fix fail-closed del
   * 2026-07-21). Con esta bandera la UI puede avisar en vez de mostrar números
   * del país equivocado como si fueran los buenos.
   */
  scopeSynced: boolean;
  /**
   * ¿Falló la CARGA de tiendas (red/RLS)? Distinto de "cero tiendas": un error
   * de consulta jamás se muestra como vacío — sin esta bandera, un timeout de
   * WiFi dejaba stores=[] y ProtectedLayout mandaba a una operadora CON tienda
   * a la pantalla de alta autoservicio "Creá tu tienda" (podía crear una
   * tienda fantasma). La UI debe ofrecer reintentar (refresh) en vez de tratar
   * el vacío como real: solo stores.length===0 SIN esta bandera es un vacío legítimo.
   */
  storesError: boolean;
  setActiveStoreId: (id: string) => void;
  refresh: () => Promise<void>;
}

const StoreContext = createContext<StoreState | undefined>(undefined);
const LS_KEY = 'guardian.activeStoreId';
// Precedencia de roles: si un usuario tiene varias membresías en la misma
// tienda (pasa con filas duplicadas viejas), gana el rol más fuerte.
const ROLE_RANK: Record<StoreRole, number> = { owner: 3, supervisor: 2, operator: 1 };

/**
 * Sincroniza la tienda activa en el servidor. Devuelve si QUEDÓ sincronizada.
 *
 * ⚠️ El bug que arregla (2026-07-21): antes esto era
 * `try { await supabase.rpc(...) } catch { console.warn }`. Pero **supabase.rpc
 * NO lanza excepción cuando el RPC falla** — resuelve con `{ data, error }`.
 * O sea que el catch solo atrapaba caídas de red, y un fallo real del RPC
 * (permisos, función inexistente, firma cambiada) pasaba como éxito. El código
 * seguía creyendo que la tienda estaba sincronizada mientras el servidor
 * mezclaba Colombia con Ecuador.
 *
 * Ahora se mira `error` de verdad y se reintenta una vez: esta llamada decide
 * de qué país son TODOS los números de reportes, así que un tropiezo de red no
 * puede dejarla a medias sin que nadie se entere.
 */
async function syncActiveStore(storeId: string): Promise<boolean> {
  for (let intento = 0; intento < 2; intento++) {
    try {
      const { error } = await (supabase.rpc as unknown as (
        fn: string, args: Record<string, unknown>
      ) => Promise<{ error: { message?: string } | null }>)('set_active_store', { p_store_id: storeId });
      if (!error) return true;
      console.warn('[StoreContext] set_active_store devolvió error:', error);
    } catch (e) {
      console.warn('[StoreContext] set_active_store lanzó:', e);
    }
    if (intento === 0) await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [stores, setStores] = useState<StoreMembership[]>([]);
  const [activeStoreId, setActiveStoreIdState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Arranca en true para no mostrar el aviso durante la carga inicial: recién
  // se pone en false si una sincronización REAL falla.
  const [scopeSynced, setScopeSynced] = useState(true);
  // Error de carga de tiendas — ver doc en StoreState.storesError.
  const [storesError, setStoresError] = useState(false);
  // Solo bloqueamos la UI (loading=true) en la PRIMERA carga. Refreshes
  // posteriores (token refresh al volver de pestaña, etc.) NO deben bloquear,
  // o ProtectedLayout desmonta toda la app y la operadora pierde su lugar.
  const hasLoadedRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!user) {
      setStores([]); setActiveStoreIdState(null); setLoading(false);
      setStoresError(false);
      hasLoadedRef.current = false;
      return;
    }
    if (!hasLoadedRef.current) setLoading(true);

    // Membresías del user (RLS asegura que solo vea las suyas). OJO: un fallo
    // de red acá NO es "cero membresías" — si se descarta `error`, la rama de
    // abajo deja stores=[] y eso se lee como "no sos miembro de nada" (pantalla
    // de alta autoservicio). Reintento con backoff DENTRO de refresh porque no
    // vuelve a correr solo: su única dep es la identidad de `user`, estable a
    // propósito (invariante single-app-mount).
    let memberships: { store_id: string; role: string }[] | null = null;
    for (let intento = 0; intento < 3; intento++) {
      const { data, error } = await supabase
        .from('store_members')
        .select('store_id, role')
        .eq('user_id', user.id);
      if (!error) { memberships = data ?? []; break; }
      console.warn(`[StoreContext] store_members falló (intento ${intento + 1}):`, error);
      if (intento < 2) await new Promise(r => setTimeout(r, 500 * (intento + 1)));
    }
    if (memberships === null) {
      // Error persistente: conservar stores/activeStoreId anteriores (mejor
      // aproximación que un vacío falso) y marcar el error para que la UI
      // avise y ofrezca reintentar. Se suelta loading para no colgar la app;
      // hasLoadedRef queda como está (si nunca hubo carga buena, el próximo
      // refresh vuelve a bloquear como primera carga).
      setStoresError(true);
      setLoading(false);
      return;
    }

    const storeIds = memberships.map(m => m.store_id);
    if (storeIds.length === 0) {
      // Query EXITOSA con cero filas: este sí es el vacío legítimo que
      // habilita el alta autoservicio.
      setStoresError(false);
      setStores([]); setActiveStoreIdState(null); setLoading(false);
      hasLoadedRef.current = true;
      return;
    }

    const { data: storeRows, error: storesQueryError } = await supabase
      .from('stores')
      .select('id, name, country_code, status, brand_logo_url')
      .in('id', storeIds);
    if (storesQueryError) {
      // Mismo criterio que arriba: error ≠ "cero tiendas". No pisar lo cargado.
      console.warn('[StoreContext] stores falló:', storesQueryError);
      setStoresError(true);
      setLoading(false);
      return;
    }
    setStoresError(false);

    // Para tiendas donde soy owner, verificar si hay credenciales Dropi.
    // Sólo el BOOLEANO: la integration-key de Dropi es permanente (exp año
    // 2126) y con ella se leen/crean/cancelan todos los pedidos de la cuenta —
    // no puede bajar al navegador para calcular un Boolean(). El RPC
    // (SECURITY DEFINER) devuelve la bandera y nada más.
    const ownerStoreIds = (memberships ?? [])
      .filter(m => m.role === 'owner').map(m => m.store_id);
    let dropiByStore = new Map<string, boolean>();
    if (ownerStoreIds.length > 0) {
      const { data: cfgs, error: cfgError } = await (supabase.rpc as unknown as (
        fn: string, args: Record<string, unknown>
      ) => Promise<{ data: { store_id: string; has_api_key: boolean }[] | null; error: { message?: string } | null }>)(
        'get_my_stores_dropi_status', {},
      );
      if (cfgError || !cfgs) {
        // No se pudo saber: asumimos que SÍ hay credenciales. needsSetup manda
        // al SetupWizard a pantalla completa, así que un fallo de red (o la
        // migración 20260731100000 sin aplicar) no puede dejar al dueño
        // encerrado en el asistente de alta. Si de verdad falta la clave, el
        // panel de /admin lo dice.
        console.warn('[StoreContext] get_my_stores_dropi_status falló:', cfgError);
        dropiByStore = new Map(ownerStoreIds.map(id => [id, true]));
      } else {
        dropiByStore = new Map(cfgs.map(c => [c.store_id, Boolean(c.has_api_key)]));
      }
    }

    // Rol por tienda: el MÁS FUERTE entre las membresías (owner > supervisor > operator).
    const roleByStore = new Map<string, StoreRole>();
    for (const m of memberships ?? []) {
      const cur = m.role as StoreRole;
      const prev = roleByStore.get(m.store_id);
      if (!prev || (ROLE_RANK[cur] ?? 0) > (ROLE_RANK[prev] ?? 0)) roleByStore.set(m.store_id, cur);
    }
    const list: StoreMembership[] = (storeRows ?? [])
      .filter(s => s.status === 'active')
      .map(s => ({
        id: s.id,
        name: s.name,
        country_code: s.country_code,
        role: roleByStore.get(s.id) ?? 'operator',
        brand_logo_url: (s as { brand_logo_url?: string | null }).brand_logo_url ?? null,
        status: s.status,
        hasDropiKey: dropiByStore.get(s.id),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    setStores(list);

    // Restaurar activa desde localStorage si sigue siendo miembro, sino primera
    const stored = typeof window !== 'undefined' ? localStorage.getItem(LS_KEY) : null;
    const valid = stored && list.some(s => s.id === stored) ? stored : list[0]?.id ?? null;
    setActiveStoreIdState(valid);
    if (valid && stored !== valid) localStorage.setItem(LS_KEY, valid);

    // Persistir la tienda activa server-side ANTES de soltar el loading. Las
    // RPCs admin de logística/reportes/productividad resuelven su alcance con
    // _resolve_scope_store(), que para un admin lee profiles.active_store_id.
    // Al esperar acá, los reportes (que montan recién con loading=false) ya leen
    // la tienda correcta y NO combinan CO+EC.
    if (valid) {
      const ok = await syncActiveStore(valid);
      setScopeSynced(ok);
    }

    hasLoadedRef.current = true;
    setLoading(false);
  }, [user]);

  useEffect(() => { void refresh(); }, [refresh]);

  const setActiveStoreId = useCallback((id: string) => {
    // Optimista: el UI cambia de inmediato, no bloqueamos la navegación.
    setActiveStoreIdState(id);
    try { localStorage.setItem(LS_KEY, id); } catch { /* noop */ }

    // Sincronizar la tienda activa SERVER-SIDE (profiles.active_store_id), igual
    // que el load inicial (~:120). Sin esto, las RPCs que resuelven su alcance con
    // _resolve_scope_store() seguían devolviendo la tienda VIEJA al cambiar de
    // tienda en el selector (el load solo lo sincronizaba una vez) → un admin
    // veía CO estando en EC. Tras confirmarse el cambio, invalidamos las queries
    // que dependen del resolver para que refetcheen contra la tienda ya
    // sincronizada (las de fecha-only no refetchean solas porque su key no tiene
    // store; las de store-key podrían haber corrido contra la tienda vieja).
    void (async () => {
      const ok = await syncActiveStore(id);
      setScopeSynced(ok);
      // Si no se sincronizó NO invalidamos: refetchear ahora traería la tienda
      // vieja (o vacío, con el resolver fail-closed). Mejor dejar lo que hay y
      // que el banner avise, que pintar datos del país equivocado.
      if (!ok) return;
      for (const key of [
        'ganancia-neta-dropi', 'operativo-cohorte', 'orders-estado-breakdown',
        'financial-summary', 'wallet_daily_series', 'wallet_movements',
        'logistics', 'logistics-cost-basis', 'product-profitability',
        'logistics_dashboard',
        // Auditoría 2026-07-07: faltaban — el heatmap/recomendaciones, el saldo
        // de hoy y el dropdown de ciudades quedaban con la tienda anterior si
        // su refetch por cambio de key corría ANTES de set_active_store.
        'logistics-city-carrier-matrix', 'wallet_saldo_hoy', 'logistics-cities-list',
      ]) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }
    })();
  }, [queryClient]);

  const activeStore = stores.find(s => s.id === activeStoreId) ?? null;
  // Sincroniza el país del rastreo de transportadoras (getTrackingUrl) con la
  // tienda activa: EC usa GINTRACOM/LAAR/Servientrega-EC, CO sus propias URLs.
  useEffect(() => {
    setTrackingCountry(activeStore?.country_code);
    // Misma sincronización para la MONEDA: EC muestra USD con centavos en
    // formatCOP (los montos EC como COP sin decimales perdían los centavos).
    setCurrencyCountry(activeStore?.country_code);
  }, [activeStore?.country_code]);
  const isOwnerOfActive = activeStore?.role === 'owner';
  const isManagerOfActive = activeStore?.role === 'owner' || activeStore?.role === 'supervisor';
  // needsSetup solo es relevante para owners; operadoras no manejan credenciales.
  const needsSetup = Boolean(isOwnerOfActive && activeStore && !activeStore.hasDropiKey);

  return (
    <StoreContext.Provider value={{
      loading, stores, activeStoreId, activeStore, isOwnerOfActive, isManagerOfActive, needsSetup,
      scopeSynced, storesError, setActiveStoreId, refresh,
    }}>
      {children}
    </StoreContext.Provider>
  );
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be used inside StoreProvider');
  return ctx;
}

/** Helper para componentes que solo necesitan el id activo. Devuelve null
 *  durante el primer load — usalo con `if (!storeId) return;` antes de fetchear. */
export function useActiveStoreId(): string | null {
  return useStore().activeStoreId;
}

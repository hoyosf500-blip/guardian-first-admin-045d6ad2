import { createContext, useContext, useEffect, useState, useCallback, useRef, ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './AuthContext';
import { setTrackingCountry } from '@/lib/orderUtils';

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
  setActiveStoreId: (id: string) => void;
  refresh: () => Promise<void>;
}

const StoreContext = createContext<StoreState | undefined>(undefined);
const LS_KEY = 'guardian.activeStoreId';
// Precedencia de roles: si un usuario tiene varias membresías en la misma
// tienda (pasa con filas duplicadas viejas), gana el rol más fuerte.
const ROLE_RANK: Record<StoreRole, number> = { owner: 3, supervisor: 2, operator: 1 };

export function StoreProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [stores, setStores] = useState<StoreMembership[]>([]);
  const [activeStoreId, setActiveStoreIdState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Solo bloqueamos la UI (loading=true) en la PRIMERA carga. Refreshes
  // posteriores (token refresh al volver de pestaña, etc.) NO deben bloquear,
  // o ProtectedLayout desmonta toda la app y la operadora pierde su lugar.
  const hasLoadedRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!user) {
      setStores([]); setActiveStoreIdState(null); setLoading(false);
      hasLoadedRef.current = false;
      return;
    }
    if (!hasLoadedRef.current) setLoading(true);

    // Membresías del user (RLS asegura que solo vea las suyas)
    const { data: memberships } = await supabase
      .from('store_members')
      .select('store_id, role')
      .eq('user_id', user.id);

    const storeIds = (memberships ?? []).map(m => m.store_id);
    if (storeIds.length === 0) {
      setStores([]); setActiveStoreIdState(null); setLoading(false);
      hasLoadedRef.current = true;
      return;
    }

    const { data: storeRows } = await supabase
      .from('stores')
      .select('id, name, country_code, status, brand_logo_url')
      .in('id', storeIds);

    // Para tiendas donde soy owner, verificar si hay credenciales Dropi
    const ownerStoreIds = (memberships ?? [])
      .filter(m => m.role === 'owner').map(m => m.store_id);
    let dropiByStore = new Map<string, boolean>();
    if (ownerStoreIds.length > 0) {
      const { data: cfgs } = await supabase
        .from('store_dropi_config')
        .select('store_id, dropi_api_key')
        .in('store_id', ownerStoreIds);
      dropiByStore = new Map((cfgs ?? []).map(c => [c.store_id, Boolean(c.dropi_api_key)]));
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
    // RPCs admin de logística/billetera/finanzas resuelven su alcance con
    // _resolve_scope_store(), que para un admin lee profiles.active_store_id.
    // Al esperar acá, los reportes (que montan recién con loading=false) ya leen
    // la tienda correcta y NO combinan CO+EC. Best-effort: si falla, el resolver
    // cae a su default (admin = todas) y la app igual carga.
    if (valid) {
      try {
        await (supabase.rpc as unknown as (
          fn: string, args: Record<string, unknown>
        ) => Promise<unknown>)('set_active_store', { p_store_id: valid });
      } catch (e) {
        // No bloquea el arranque (el resolver del backend tiene fallback), pero
        // sí logueamos para diagnosticar desincronización server-side de la
        // tienda activa cuando un admin reporta "reportes mezclan tiendas".
        console.warn('[StoreContext] set_active_store falló:', e);
      }
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
      try {
        await (supabase.rpc as unknown as (
          fn: string, args: Record<string, unknown>
        ) => Promise<unknown>)('set_active_store', { p_store_id: id });
      } catch (e) {
        // No rompe la navegación; logueamos para diagnosticar desincronización.
        console.warn('[StoreContext] set_active_store (cambio de tienda) falló:', e);
        return; // si no se sincronizó, no invalidamos (evita refetch a la vieja)
      }
      for (const key of [
        'ganancia-neta-dropi', 'operativo-cohorte', 'financial-summary',
        'wallet_daily_series', 'wallet_movements', 'logistics',
        'logistics-cost-basis', 'product-profitability', 'logistics_dashboard',
      ]) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }
    })();
  }, [queryClient]);

  const activeStore = stores.find(s => s.id === activeStoreId) ?? null;
  // Sincroniza el país del rastreo de transportadoras (getTrackingUrl) con la
  // tienda activa: EC usa GINTRACOM/LAAR/Servientrega-EC, CO sus propias URLs.
  useEffect(() => { setTrackingCountry(activeStore?.country_code); }, [activeStore?.country_code]);
  const isOwnerOfActive = activeStore?.role === 'owner';
  const isManagerOfActive = activeStore?.role === 'owner' || activeStore?.role === 'supervisor';
  // needsSetup solo es relevante para owners; operadoras no manejan credenciales.
  const needsSetup = Boolean(isOwnerOfActive && activeStore && !activeStore.hasDropiKey);

  return (
    <StoreContext.Provider value={{
      loading, stores, activeStoreId, activeStore, isOwnerOfActive, isManagerOfActive, needsSetup,
      setActiveStoreId, refresh,
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

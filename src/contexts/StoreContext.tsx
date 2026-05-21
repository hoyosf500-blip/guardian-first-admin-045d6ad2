import { createContext, useContext, useEffect, useState, useCallback, useRef, ReactNode } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './AuthContext';

export interface StoreMembership {
  id: string;
  name: string;
  country_code: string;
  role: 'owner' | 'operator';
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
  needsSetup: boolean;        // owner + tienda activa sin dropi_api_key
  setActiveStoreId: (id: string) => void;
  refresh: () => Promise<void>;
}

const StoreContext = createContext<StoreState | undefined>(undefined);
const LS_KEY = 'guardian.activeStoreId';

export function StoreProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
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

    const roleByStore = new Map((memberships ?? []).map(m => [m.store_id, m.role as 'owner' | 'operator']));
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

    hasLoadedRef.current = true;
    setLoading(false);
  }, [user]);

  useEffect(() => { void refresh(); }, [refresh]);

  const setActiveStoreId = useCallback((id: string) => {
    setActiveStoreIdState(id);
    try { localStorage.setItem(LS_KEY, id); } catch { /* noop */ }
  }, []);

  const activeStore = stores.find(s => s.id === activeStoreId) ?? null;
  const isOwnerOfActive = activeStore?.role === 'owner';
  // needsSetup solo es relevante para owners; operadoras no manejan credenciales.
  const needsSetup = Boolean(isOwnerOfActive && activeStore && !activeStore.hasDropiKey);

  return (
    <StoreContext.Provider value={{
      loading, stores, activeStoreId, activeStore, isOwnerOfActive, needsSetup,
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

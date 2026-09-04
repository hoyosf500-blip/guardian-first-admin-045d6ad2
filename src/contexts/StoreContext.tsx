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
   * La tienda que el SERVIDOR tiene confirmada como activa
   * (`profiles.active_store_id`, vía `set_active_store`), o `null` mientras
   * viaja la sincronización. Las RPCs que resuelven su alcance server-side
   * (`_resolve_scope_store`) tienen que esperar `scopeStoreId === activeStoreId`
   * antes de preguntar; si no, contestan con los números de la tienda ANTERIOR
   * bajo el nombre de la nueva. `scopeSynced` no alcanzaba: arranca en true y
   * nadie lo bajaba al cambiar de tienda (4-sep-2026).
   */
  scopeStoreId: string | null;
  /**
   * ¿Falló la CARGA de tiendas (red/RLS)? Distinto de "cero tiendas": un error
   * de consulta jamás se muestra como vacío — sin esta bandera, un timeout de
   * WiFi dejaba stores=[] y ProtectedLayout mandaba a una operadora CON tienda
   * a la pantalla de alta autoservicio "Creá tu tienda" (podía crear una
   * tienda fantasma). La UI debe ofrecer reintentar (refresh) en vez de tratar
   * el vacío como real: solo stores.length===0 SIN esta bandera es un vacío legítimo.
   */
  storesError: boolean;
  /**
   * ¿El usuario tiene membresías PERO todas sus tiendas están suspendidas
   * (ninguna `active`)? Distinto de "cero tiendas". Sin esta bandera, suspender
   * una tienda (palanca de cobro) dejaba `stores=[]` con `storesError=false` →
   * ProtectedLayout caía en "Creá tu tienda": callejón sin salida para el dueño
   * suspendido, y tienda fantasma para sus operadoras. La UI muestra en su lugar
   * una pantalla de "cuenta suspendida" con logout.
   */
  hasSuspendedOnly: boolean;
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
  // Ver el doc de `scopeStoreId` en StoreState. `null` hasta que el servidor
  // confirme; se vuelve a null SINCRÓNICAMENTE al cambiar de tienda.
  const [scopeStoreId, setScopeStoreId] = useState<string | null>(null);
  // Error de carga de tiendas — ver doc en StoreState.storesError.
  const [storesError, setStoresError] = useState(false);
  // Todas las tiendas del usuario suspendidas — ver doc en StoreState.hasSuspendedOnly.
  const [hasSuspendedOnly, setHasSuspendedOnly] = useState(false);
  // Solo bloqueamos la UI (loading=true) en la PRIMERA carga. Refreshes
  // posteriores (token refresh al volver de pestaña, etc.) NO deben bloquear,
  // o ProtectedLayout desmonta toda la app y la operadora pierde su lugar.
  const hasLoadedRef = useRef(false);

  // ── Serialización de la sincronización del scope server-side ──────────────
  // `set_active_store` escribe profiles.active_store_id, de donde las RPCs
  // admin resuelven su tienda. Es un UPDATE con reintento (+400 ms) y sin
  // timeout: una llamada LENTA de la tienda vieja puede aterrizar en el server
  // DESPUÉS de que la nueva ya sincronizó — y deja el scope apuntando a la
  // tienda equivocada mientras la UI muestra la nueva. Un simple "descartar el
  // callback viejo" no alcanza: el UPDATE viejo YA aterrizó en la base, así
  // que al detectar la carrera hay que RE-sincronizar la vigente, no callar.
  const syncSeqRef = useRef(0);
  const idVigenteRef = useRef<string | null>(null);

  const sincronizarScope = useCallback(async (id: string): Promise<boolean> => {
    idVigenteRef.current = id;
    const token = ++syncSeqRef.current;
    const ok = await syncActiveStore(id);
    if (token !== syncSeqRef.current) {
      // Llegó tarde: mientras esperábamos se pidió sincronizar otra tienda.
      // Nuestro UPDATE pudo haber PISADO el de la más nueva → se re-sincroniza
      // la vigente. Acotado: cada aterrizaje tardío dispara a lo sumo un
      // reintento, y el más nuevo siempre termina siendo el que manda.
      void sincronizarScope(idVigenteRef.current!);
      return false;
    }
    setScopeSynced(ok);
    setScopeStoreId(ok ? id : null);
    return ok;
  }, []);

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
      setHasSuspendedOnly(false);
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
    // Suspendida = tiene tiendas pero ninguna activa. Se computa sobre storeRows
    // (que trae TODOS los estados) contra list (solo activas).
    setHasSuspendedOnly((storeRows ?? []).length > 0 && list.length === 0);

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
      await sincronizarScope(valid);
    }

    hasLoadedRef.current = true;
    setLoading(false);
  }, [user, sincronizarScope]);

  // ⛔ EL .catch QUE FALTABA (4-sep-2026). Era `void refresh()`, que se traga
  // cualquier excepción: si `refresh` reventaba en medio (un throw de
  // `sincronizarScope`, un await que rechaza), el `setLoading(false)` del final
  // NO corría y `store.loading` quedaba en `true` PARA SIEMPRE. `ProtectedLayout`
  // muestra "Cargando..." mientras `loading || store.loading`, así que la
  // operadora quedaba mirando un spinner sin salida.
  //
  // Los errores DEVUELTOS ya estaban bien tratados (cada rama suelta el
  // loading y marca `storesError`); lo que faltaba era la red para los
  // errores LANZADOS.
  useEffect(() => {
    refresh().catch((e) => {
      console.warn('[StoreContext] refresh reventó; se suelta la pantalla:', e);
      setStoresError(true);
      setLoading(false);
    });
  }, [refresh]);

  // ⛔ Reintento del scope (revisión 3-sep-2026). Si `set_active_store` falló
  // (un blip de red al entrar), `scopeStoreId` quedaba en null PARA SIEMPRE:
  // `refresh` solo corre al cambiar de usuario y `setActiveStoreId` solo con
  // un cambio manual de tienda. Todo lo que espera el scope del servidor
  // (Reportes, el ranking del Dashboard, Jornada) quedaba en "cargando" hasta
  // F5. Ahora se reintenta al volver la red, al volver a la pestaña, y cada
  // 30 s mientras siga caído.
  useEffect(() => {
    if (scopeSynced || !activeStoreId) return;
    const id = activeStoreId;
    const otraVez = () => {
      if (document.visibilityState !== 'visible') return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      void sincronizarScope(id);
    };
    window.addEventListener('online', otraVez);
    document.addEventListener('visibilitychange', otraVez);
    const t = setInterval(otraVez, 30_000);
    return () => {
      window.removeEventListener('online', otraVez);
      document.removeEventListener('visibilitychange', otraVez);
      clearInterval(t);
    };
  }, [scopeSynced, activeStoreId, sincronizarScope]);

  const setActiveStoreId = useCallback((id: string) => {
    // Optimista: el UI cambia de inmediato, no bloqueamos la navegación.
    setActiveStoreIdState(id);
    // Y el scope del servidor deja de estar confirmado HASTA que aterrice el
    // UPDATE: quien pregunte por RPC con scope server-side espera.
    setScopeStoreId(null);
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
      const ok = await sincronizarScope(id);
      // Si no se sincronizó NO invalidamos: refetchear ahora traería la tienda
      // vieja (o vacío, con el resolver fail-closed). Mejor dejar lo que hay y
      // que el banner avise, que pintar datos del país equivocado. También
      // cubre el caso "llegó tarde" (otro cambio más nuevo en el medio): la
      // invalidación le corresponde a ese cambio, no a este.
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
        // Auditoria 2026-08-20: 'costos-unitarios' faltaba. Su RPC resuelve el
        // scope server-side y su staleTime es de 60s, asi que si el refetch por
        // cambio de key le ganaba la carrera a set_active_store, el dueno de la
        // tienda B veia los costos de la tienda A durante un minuto, rotulados
        // como suyos (se dibujan en /logistica → Resumen y en el simulador).
        'costos-unitarios',
        // 'logistics-recommendations' comparte el defecto (queryKey sin tienda)
        // pero hoy no tiene ni un consumidor; se invalida igual por si vuelve.
        'logistics-recommendations',
      ]) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }
    })();
  }, [queryClient, sincronizarScope]);

  const activeStore = stores.find(s => s.id === activeStoreId) ?? null;
  // Sincroniza el país del rastreo de transportadoras (getTrackingUrl) con la
  // tienda activa: EC usa GINTRACOM/LAAR/Servientrega-EC, CO sus propias URLs.
  // Misma sincronización para la MONEDA: EC muestra USD con centavos en
  // formatCOP (los montos EC como COP sin decimales perdían los centavos).
  //
  // ⛔ EN EL CUERPO DEL RENDER, no en un efecto (4-sep-2026). Las dos escriben
  // una variable de MÓDULO, no estado: un `useEffect` corre DESPUÉS del commit
  // y mutarla no agenda ningún re-render, así que el primer paint con la tienda
  // nueva usaba el país anterior — montos de Ecuador sin centavos, una guía
  // LAAR contra el mapa colombiano. Intermitente y no reproducible a pedido,
  // que es lo peor. La asignación es idempotente y barata: va antes de que
  // los hijos rendericen. El efecto queda por si algo vuelve a montar tarde.
  setTrackingCountry(activeStore?.country_code);
  setCurrencyCountry(activeStore?.country_code);
  useEffect(() => {
    setTrackingCountry(activeStore?.country_code);
    setCurrencyCountry(activeStore?.country_code);
  }, [activeStore?.country_code]);
  const isOwnerOfActive = activeStore?.role === 'owner';
  const isManagerOfActive = activeStore?.role === 'owner' || activeStore?.role === 'supervisor';
  // needsSetup solo es relevante para owners; operadoras no manejan credenciales.
  const needsSetup = Boolean(isOwnerOfActive && activeStore && !activeStore.hasDropiKey);

  return (
    <StoreContext.Provider value={{
      loading, stores, activeStoreId, activeStore, isOwnerOfActive, isManagerOfActive, needsSetup,
      scopeSynced, scopeStoreId, storesError, hasSuspendedOnly, setActiveStoreId, refresh,
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

import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useOperatorHeartbeat } from '@/hooks/useOperatorHeartbeat';
import { useReportAppVersion } from '@/hooks/useReportAppVersion';
import { useVersionCheck } from '@/hooks/useVersionCheck';
import InactivityGuard from '@/components/InactivityGuard';
import { OrderProvider } from '@/contexts/OrderContext';
import { StoreProvider, useStore } from '@/contexts/StoreContext';
import { WaChatProvider } from '@/contexts/WaChatContext';
import { useTheme } from '@/hooks/useTheme';
import { useIsMobile } from '@/hooks/use-mobile';
import { useState, useEffect, useRef, Suspense } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { History, BarChart3, Phone, Package, Settings, LogOut, Menu, AlertTriangle, RefreshCw, X, Truck, DollarSign, Building2, BookOpen, Inbox } from 'lucide-react';
import SiguienteAccionBar from '@/components/SiguienteAccionBar';
import WelcomeGate from '@/components/WelcomeGate';
import NovedadesButton from '@/components/NovedadesButton';
import SetupWizard from '@/components/SetupWizard';
import ConectarDropiBanner from '@/components/ConectarDropiBanner';
import CreateStoreScreen from '@/components/CreateStoreScreen';
import { leerTiendaPendiente, olvidarTiendaPendiente, type TiendaPendiente } from '@/lib/tiendaPendiente';
import { esSesionFantasma, MENSAJE_SESION_FANTASMA } from '@/lib/sesionFantasma';
import StoreSelector from '@/components/StoreSelector';
import SyncFreshness from '@/components/SyncFreshness';
import ImporchatSyncBadge from '@/components/chat/ImporchatSyncBadge';
import type { LucideIcon } from 'lucide-react';
import { IconRail, HudTopbar } from '@/components/ui3d';

const CFO_ENABLED = import.meta.env.VITE_ENABLE_CFO === 'true';

/** Crea la tienda que el dueño nombró al registrarse.
 *
 *  El alta quedó en UNA pantalla: nombre, correo, clave, nombre de la tienda y
 *  país. Como la confirmación por correo corta la sesión en el medio, el nombre
 *  viaja por localStorage y la tienda nace acá, en el primer ingreso.
 *
 *  Devuelve true solo si la tienda quedó creada. Ante cualquier error se
 *  devuelve false y se cae a `CreateStoreScreen`: un fallo no puede dejar a
 *  nadie sin forma de abrir su tienda. */
async function crearTiendaPendiente(t: TiendaPendiente): Promise<{ ok: boolean; motivo?: string }> {
  // Bindeado: guardar `supabase.rpc` suelto pierde `this`, ver memoria del repo.
  type Rpc = (fn: string, p: Record<string, unknown>) => Promise<{ error: { message: string } | null }>;
  const rpc = supabase.rpc.bind(supabase) as unknown as Rpc;
  try {
    const { error } = await rpc('create_my_store', { p_name: t.nombre, p_country_code: t.pais });
    // El motivo se DEVUELVE, no se traga. Sin esto, el dueño nuevo aterrizaba en
    // "Creá tu tienda" sin una sola pista de por qué su nombre no se usó, que es
    // el peor momento posible para dejar a alguien adivinando.
    return error ? { ok: false, motivo: error.message.replace(/^.*Exception: /, '') } : { ok: true };
  } catch (e) {
    return { ok: false, motivo: e instanceof Error ? e.message : String(e) };
  }
}

function InlineRouteLoader() {
  return (
    <div className="flex flex-col items-center justify-center py-20 gap-3" role="status" aria-live="polite">
      <RefreshCw size={24} className="text-accent animate-spin" aria-hidden="true" />
      <p className="text-xs text-muted-foreground">Cargando...</p>
    </div>
  );
}

// adminOnly  → solo admin GLOBAL (Fabian). managerOnly → owner/supervisor de la tienda activa.
// section    → rótulo mono de la topbar HUD ("Dashboard / OPERADORA"), tomado del handoff.
interface NavItem { path: string; icon: LucideIcon; label: string; section: string; adminOnly?: boolean; managerOnly?: boolean }

const NAV_ITEMS: NavItem[] = [
  { path: '/dashboard', icon: BarChart3, label: 'Dashboard', section: 'Operadora' },
  { path: '/confirmar', icon: Phone, label: 'Confirmar', section: 'Operadora' },
  { path: '/seguimiento', icon: Package, label: 'Seguimiento', section: 'CRM' },
  { path: '/inbox', icon: Inbox, label: 'Escribieron', section: 'CRM' },
  { path: '/novedades', icon: AlertTriangle, label: 'Novedades', section: 'Gestión' },
  // Sin `managerOnly`: cada quien ve SU bitacora, el jefe ve la de todas. La
  // reja vive en la RLS de `order_events`. Ver ActividadPage.
  { path: '/actividad', icon: History, label: 'Actividad', section: 'Gestión' },
  // Para TODOS: el protocolo del turno. No hay rol que no necesite saber qué
  // se hace primero — y hasta hoy ninguno de los ocho destinos lo explicaba.
  { path: '/como-se-trabaja', icon: BookOpen, label: 'Cómo se trabaja', section: 'Protocolo' },
  { path: '/admin', icon: Settings, label: 'Admin', section: 'Sistema', managerOnly: true },
  { path: '/logistica', icon: Truck, label: 'Logística', section: 'Operación', managerOnly: true },
  ...(CFO_ENABLED ? [{ path: '/cfo', icon: DollarSign, label: 'CFO', section: 'Finanzas', adminOnly: true } as NavItem] : []),
  // Panel multi-inquilino: SOLO el admin global (dueño de la plataforma). Los
  // owners terceros ni lo ven, y la DB los rechaza si entran por URL.
  { path: '/plataforma', icon: Building2, label: 'Plataforma', section: 'Sistema', adminOnly: true },
];

function LiveClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30 * 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="font-mono text-xs text-muted-foreground tabular-nums hidden sm:block">
      {now.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })}
    </span>
  );
}

/**
 * La carga de tiendas FALLÓ (red/RLS). Va antes del branch "cero tiendas":
 * sin esta pantalla, una operadora que recarga con WiFi malo veía el alta
 * autoservicio "Creá tu tienda" — la seguía (era la única opción visible) y
 * quedaba de dueña de una tienda fantasma, fuera de su cola real.
 */
function StoresErrorScreen({ onRetry, onSignOut }: { onRetry: () => Promise<void>; onSignOut: () => void }) {
  const [retrying, setRetrying] = useState(false);
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card/40 p-6 text-center shadow-card3d" role="alert">
        <div className="w-12 h-12 rounded-xl bg-danger/14 border border-danger/30 flex items-center justify-center mx-auto mb-4">
          <AlertTriangle size={22} className="text-danger" aria-hidden="true" />
        </div>
        <h1 className="text-base font-semibold text-foreground">No se pudieron cargar tus tiendas</h1>
        <p className="mt-2 text-xs text-muted-foreground leading-relaxed">
          Falló la conexión, no que no tengas tiendas. Revisá el internet y reintentá —
          no crees una tienda nueva desde acá.
        </p>
        <button
          onClick={() => { setRetrying(true); void onRetry().finally(() => setRetrying(false)); }}
          disabled={retrying}
          className="mt-5 w-full h-10 btn-accent-3d rounded-xl text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <RefreshCw size={14} className={retrying ? 'animate-spin' : ''} aria-hidden="true" />
          {retrying ? 'Reintentando…' : 'Reintentar'}
        </button>
        <button
          onClick={onSignOut}
          className="mt-2 w-full h-9 rounded-xl border border-border bg-card/40 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          Cerrar sesión
        </button>
      </div>
    </div>
  );
}

// Cuenta suspendida: el usuario tiene tiendas, pero TODAS están suspendidas.
// Antes esto caía en "Creá tu tienda" — callejón sin salida para el dueño que no
// pagó, y sus operadoras podían crear tiendas fantasma. Ahora se les dice qué
// pasa y se les deja cerrar sesión.
function CuentaSuspendidaScreen({ onSignOut }: { onSignOut: () => void }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card/40 p-6 text-center shadow-card3d" role="alert">
        <div className="w-12 h-12 rounded-xl bg-warning/14 border border-warning/30 flex items-center justify-center mx-auto mb-4">
          <AlertTriangle size={22} className="text-warning" aria-hidden="true" />
        </div>
        <h1 className="text-base font-semibold text-foreground">Tu cuenta está suspendida</h1>
        <p className="mt-2 text-xs text-muted-foreground leading-relaxed">
          El acceso a tu tienda está pausado. Escribile al administrador de Guardian
          para reactivarla. Tus datos y tus pedidos siguen guardados.
        </p>
        <button
          onClick={onSignOut}
          className="mt-5 w-full h-10 rounded-xl border border-border bg-card/40 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          Cerrar sesión
        </button>
      </div>
    </div>
  );
}

// Inner layout: tiene acceso a useStore() porque StoreProvider lo envuelve.
function ProtectedLayoutInner() {
  const { user, profile, isAdmin, loading, signOut } = useAuth();
  // Tema único oscuro: el hook ya no togglea, solo garantiza la clase.
  useTheme();
  const isMobile = useIsMobile();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const store = useStore();

  // Latch del wizard de setup. Una vez abierto sigue montado hasta que el dueño
  // lo cierra desde la pantalla de resultado (onDone). SIN esto, al guardar las
  // El asistente de Dropi NO se abre solo. Decisión del dueño (2026-08-13):
  // "que cuando se registren los deje entrar a Guardian y adentro configuremos
  // las APIs". El dueño entra directo y lo llama cuando quiere, desde el botón
  // del aviso (ConectarDropiBanner) o desde Configuración.
  const [wizardOpen, setWizardOpen] = useState(false);
  // Redención de invite EN VUELO: mientras se canjea el token, mostrar "uniéndote"
  // en vez de la pantalla "Creá tu tienda" (que invitaba al invitado a abrir su
  // propia tienda por medio segundo).
  const [redeeming, setRedeeming] = useState(false);
  /** Creando la tienda que nombró al registrarse (alta de una sola pantalla). */
  const [creandoTienda, setCreandoTienda] = useState(false);
  const tiendaIntentada = useRef(false);

  // Alta en un paso: si al registrarse dejó anotado el nombre de su tienda y
  // todavía no tiene ninguna, se crea acá y entra directo a Guardian.
  // El ref evita que un re-render dispare una segunda creación — sin él, dos
  // pasadas rápidas dejarían al dueño con dos tiendas iguales, que es peor que
  // no haber automatizado nada.
  useEffect(() => {
    if (!user || store.loading || tiendaIntentada.current) return;
    if (store.stores.length > 0) return;
    // Un invitado se suma a una tienda existente: no le abrimos una propia.
    let hayInvite = false;
    try { hayInvite = Boolean(localStorage.getItem('guardian.pendingInvite')); } catch { /* noop */ }
    if (hayInvite || redeeming) return;
    const pendiente = leerTiendaPendiente();
    if (!pendiente) return;
    tiendaIntentada.current = true;
    setCreandoTienda(true);
    void (async () => {
      const r = await crearTiendaPendiente(pendiente);
      // Se olvida SIEMPRE, salga bien o mal: si falló, el respaldo es la
      // pantalla de crear tienda, y reintentar solo en cada recarga podría
      // crear la tienda dos veces cuando el error fue solo de red al responder.
      olvidarTiendaPendiente();
      if (r.ok) {
        toast.success(`¡Tu tienda "${pendiente.nombre}" está lista!`);
        await store.refresh();
      } else if (esSesionFantasma(r.motivo)) {
        // Token de una cuenta borrada: no hay pantalla que arregle esto.
        toast.error(MENSAJE_SESION_FANTASMA, { duration: 10000 });
        await signOut();
      } else if (r.motivo) {
        // Cae a "Creá tu tienda", pero sabiendo POR QUÉ. Un formulario que
        // reaparece sin explicación se lee como que la app perdió los datos.
        toast.error('No pudimos crear tu tienda automáticamente', {
          description: `${r.motivo} — cargala acá abajo.`,
          duration: 9000,
        });
      }
      setCreandoTienda(false);
    })();
  }, [user, store.loading, store.stores.length, redeeming, store]);

  // Heartbeat de jornada (tracking de inicio + tiempo activo/idle). El hook
  // tiene sus propios gates: solo emite ping para no-admin con tienda activa.
  // Mantener acá (no en un sub-componente) para que viva toda la sesión.
  useOperatorHeartbeat();
  // Sella qué versión del CRM tiene cargada esta pestaña → panel /plataforma.
  useReportAppVersion();
  // Avisa (sin recargar solo) cuando se publicó una versión nueva: una pestaña
  // abierta días seguía con el bundle viejo y sin los arreglos ya publicados.
  useVersionCheck();

  // Redención de invitación por link: si el usuario llegó por
  // /auth?invite=TOKEN, AuthPage guardó el token en localStorage. Apenas hay
  // sesión, lo canjeamos (lo mete en store_members de esa tienda) y refrescamos
  // las tiendas. Un solo intento por sesión (ref guard).
  const redeemAttempted = useRef(false);
  useEffect(() => {
    if (!user || redeemAttempted.current) return;
    let token: string | null = null;
    try { token = localStorage.getItem('guardian.pendingInvite'); } catch { /* noop */ }
    if (!token) return;
    redeemAttempted.current = true;
    setRedeeming(true);
    void (async () => {
      const { error } = await (supabase.rpc as unknown as (
        fn: string, args: Record<string, unknown>
      ) => Promise<{ data: string | null; error: { message: string } | null }>)(
        'redeem_store_invite', { p_token: token },
      );
      if (error) {
        // Permanente (ya usada / expiró / inválida) → descartar el token, no
        // reintentar. Transitorio (red/timeout) → CONSERVAR el token y permitir
        // reintento en el próximo montaje: un WiFi caído no debe quemar la
        // invitación ni mandar al invitado a "Creá tu tienda" sin acceso.
        const permanente = /usad|expir|inv[aá]lid|no existe|not found|no encontr/i.test(error.message || '');
        if (permanente) {
          try { localStorage.removeItem('guardian.pendingInvite'); } catch { /* noop */ }
          toast.error('No se pudo unir a la tienda', { description: error.message });
        } else {
          redeemAttempted.current = false; // reintentar al re-montar
        }
        setRedeeming(false);
        return;
      }
      try { localStorage.removeItem('guardian.pendingInvite'); } catch { /* noop */ }
      toast.success('¡Listo! Te uniste a la tienda.');
      await store.refresh();
      setRedeeming(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  if (loading || store.loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="text-center">
          <div className="w-12 h-12 rounded-xl bg-accent/20 flex items-center justify-center mx-auto mb-4 animate-pulse">
            <Package size={22} className="text-accent" />
          </div>
          <p className="text-sm text-muted-foreground font-semibold tracking-wide">Cargando...</p>
        </div>
      </div>
    );
  }

  if (!user) return <Navigate to="/auth" replace />;

  // Un error de consulta JAMÁS se muestra como vacío: sólo stores.length===0
  // SIN esta bandera es un vacío legítimo (ver StoreState.storesError).
  if (store.storesError) {
    return <StoresErrorScreen onRetry={() => store.refresh()} onSignOut={signOut} />;
  }

  // Todas las tiendas suspendidas: pantalla propia (NO "Creá tu tienda").
  if (store.hasSuspendedOnly) {
    return <CuentaSuspendidaScreen onSignOut={signOut} />;
  }

  // Canje de invitación en vuelo: NO mostrar "Creá tu tienda" mientras el token
  // se está canjeando — el invitado vería, por un instante, una pantalla que lo
  // invita a abrir SU propia tienda en vez de unirse a la que lo invitó.
  if (redeeming && store.stores.length === 0) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="text-center">
          <div className="w-12 h-12 rounded-xl bg-accent/20 flex items-center justify-center mx-auto mb-4 animate-pulse">
            <Package size={22} className="text-accent" />
          </div>
          <p className="text-sm text-muted-foreground font-semibold tracking-wide">Uniéndote a la tienda…</p>
        </div>
      </div>
    );
  }

  // El user no es miembro de ninguna tienda → alta autoservicio: crea la SUYA
  // y queda de owner (antes era un callejón "Sin tiendas asignadas" y las
  // tiendas se creaban a mano). El camino de invitación sigue intacto: si vino
  // con ?invite=TOKEN ya se canjeó arriba y stores.length > 0.
  // Naciendo la tienda del alta de un paso. Es corto, pero sin este cartel el
  // dueño vería parpadear "Creá tu tienda" justo cuando ya la había nombrado.
  if (creandoTienda) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="text-center">
          <div className="w-12 h-12 rounded-xl bg-accent/20 flex items-center justify-center mx-auto mb-4 animate-pulse">
            <Package size={22} className="text-accent" />
          </div>
          <p className="text-sm text-muted-foreground font-semibold tracking-wide">Preparando tu tienda…</p>
        </div>
      </div>
    );
  }

  if (store.stores.length === 0) {
    return <CreateStoreScreen onCreated={() => store.refresh()} onSignOut={signOut} />;
  }

  // El asistente ya NO es un portón: se muestra mientras está abierto, y se
  // cierra desde adentro con "lo hago después". Antes la condición incluía
  // `store.needsSetup`, así que sin credenciales era IMPOSIBLE ver la app —
  // y si la verificación fallaba, el botón de salida ni siquiera se dibujaba.
  // Cerrado el asistente, lo que queda es el aviso de abajo (ConectarDropiBanner).
  if (wizardOpen) {
    return (
      <SetupWizard
        onDone={() => { setWizardOpen(false); void store.refresh(); }}
        onLater={() => setWizardOpen(false)}
        onSignOut={signOut}
      />
    );
  }

  const brandName = store.activeStore?.name ?? 'CRM';
  const brandLogoUrl = store.activeStore?.brand_logo_url ?? null;
  // CFO es la vista financiera PERSONAL del dueño (tarjetas, deuda, pauta) y
  // solo aplica a Colombia. Se oculta en otras tiendas (Ecuador) — los datos
  // además están protegidos por RLS admin-only a nivel DB, así que un amigo
  // (operator/owner, nunca admin) jamás los ve aunque navegue a /cfo directo.
  const visibleTabs = NAV_ITEMS.filter(t => {
    if (t.adminOnly && !isAdmin) return false;
    if (t.managerOnly && !store.isManagerOfActive) return false;
    if (t.path === '/cfo' && store.activeStore?.country_code !== 'CO') return false;
    return true;
  });
  // Para las operadoras (ni admin ni manager) el menú se ordena por el FLUJO
  // de trabajo: Confirmar → Seguimiento → Novedades, y el Dashboard (consulta)
  // queda al final. Managers/admin mantienen el orden original.
  const isOperatorOnly = !isAdmin && !store.isManagerOfActive;
  const orderedTabs = isOperatorOnly
    ? [
        ...visibleTabs.filter(t => t.path !== '/dashboard'),
        ...visibleTabs.filter(t => t.path === '/dashboard'),
      ]
    : visibleTabs;
  const activePath = location.pathname;
  const activeTab = visibleTabs.find(t => activePath.startsWith(t.path));
  const activeLabel = activeTab?.label
    || (activePath.startsWith('/pedido') ? 'Detalle Pedido' : 'Panel');
  const activeSection = activeTab?.section
    || (activePath.startsWith('/pedido') ? 'Pedido' : '');

  const isConfirmar = activePath === '/confirmar';
  const userInitial = (profile?.display_name || 'U')[0].toUpperCase();

  return (
    <OrderProvider>
      <WaChatProvider>
      <div className="flex h-screen overflow-hidden bg-background">
        {isMobile && sidebarOpen && (
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 transition-opacity duration-200"
            onClick={() => setSidebarOpen(false)}
            aria-hidden="true"
          />
        )}

        <aside
          aria-label="Navegación principal"
          className={[
            'flex flex-col flex-shrink-0 z-50',
            'bg-surface/70 border-r border-border',
            isMobile
              ? 'fixed inset-y-0 left-0 w-64 transition-transform duration-300 ease-out'
              : 'relative w-20',
            isMobile && !sidebarOpen ? '-translate-x-full' : 'translate-x-0',
          ].join(' ')}
        >
          <IconRail
            className="w-full"
            items={orderedTabs}
            activePath={activePath}
            showLabels={isMobile}
            onNavigate={(path) => { navigate(path); if (isMobile) setSidebarOpen(false); }}
            top={
              <>
                <div className={`h-[52px] flex items-center border-b border-border ${isMobile ? 'px-4 gap-2.5' : 'px-2 justify-center'}`}>
                  <div
                    className="w-9 h-9 rounded-xl bg-accent-gradient flex items-center justify-center shadow-glow flex-shrink-0 overflow-hidden"
                    title={brandName}
                  >
                    {brandLogoUrl
                      ? <img src={brandLogoUrl} alt="" className="w-full h-full object-cover" />
                      : <Package size={17} className="text-accent-foreground" aria-hidden="true" />}
                  </div>
                  {isMobile && (
                    <>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-bold text-foreground leading-tight truncate">{brandName}</div>
                        <div className="hud-label text-subtle leading-tight">Panel COD</div>
                      </div>
                      <button
                        onClick={() => setSidebarOpen(false)}
                        aria-label="Cerrar menú"
                        className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-card transition-colors duration-200 cursor-pointer"
                      >
                        <X size={16} />
                      </button>
                    </>
                  )}
                </div>
                {isMobile && (
                  <div className="px-3 pt-3">
                    <StoreSelector />
                  </div>
                )}
              </>
            }
            bottom={
              <div className={`border-t border-border p-2 flex items-center gap-2 ${isMobile ? '' : 'flex-col'}`}>
                <div
                  className="w-9 h-9 rounded-xl bg-accent/20 border border-accent/30 flex items-center justify-center text-xs font-bold text-accent flex-shrink-0"
                  title={`${profile?.display_name || 'Usuario'} · ${
                    isAdmin ? 'Administrador'
                    : store.activeStore?.role === 'owner' ? 'Dueño'
                    : store.activeStore?.role === 'supervisor' ? 'Supervisor'
                    : 'Operadora'
                  }`}
                  aria-hidden="true"
                >
                  {userInitial}
                </div>
                {isMobile && (
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold text-foreground truncate">{profile?.display_name || 'Usuario'}</div>
                    <div className="text-[10px] text-muted-foreground">{
                      isAdmin ? 'Administrador'
                      : store.activeStore?.role === 'owner' ? 'Dueño'
                      : store.activeStore?.role === 'supervisor' ? 'Supervisor'
                      : 'Operadora'
                    }</div>
                  </div>
                )}
                <button onClick={signOut} aria-label="Cerrar sesión" title="Cerrar sesión"
                  className="p-2.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-card transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none">
                  <LogOut size={15} aria-hidden="true" />
                </button>
              </div>
            }
          />
        </aside>

        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <HudTopbar
            title={activeLabel}
            section={activeSection}
            onMenu={isMobile ? () => setSidebarOpen(true) : undefined}
            right={
              <>
                {/* En escritorio el rail mide 80px y no cabe el selector de
                    tienda: vive acá para que cambiar entre Colombia y Ecuador
                    siga a un click. Es lo más importante de esta barra —
                    equivocarse de tienda significa mirar los datos de otro país. */}
                {!isMobile && (
                  <div className="w-52 shrink-0">
                    <StoreSelector />
                  </div>
                )}
                {/* Novedades: NUNCA se abre sola y no va en la franja de
                    avisos de abajo — esa es para lo que exige accion. */}
                <NovedadesButton />
                <LiveClock />
                <div className="w-8 h-8 rounded-lg bg-accent/20 border border-accent/30 flex items-center justify-center text-xs font-bold text-accent"
                  aria-label={`Usuario: ${profile?.display_name || 'Usuario'}`}
                  title={profile?.display_name || 'Usuario'}>
                  {userInitial}
                </div>
              </>
            }
          />

          {/* SUPERFICIE QUIETA (rediseño, 4-sep-2026). Acá vivían la aurora
              (tres manchas de luz de 400-500 px) y un degradado radial de fondo.
              Las tarjetas son translúcidas (`bg-card/40`), así que ese fondo se
              veía A TRAVÉS de cientos de tarjetas y el navegador lo componía en
              cada pasada de scroll. El rediseño aprobado pide una mesa de
              trabajo, no un tablero de mando: fondo plano, y el relieve lo dan
              tres niveles de superficie (fondo → columna → tarjeta). El archivo
              `AuroraBackdrop.tsx` se conserva (lo referencia un guardián). */}
          <main className="relative flex-1 overflow-y-auto p-4 md:px-6 md:py-4 bg-background">
            <div className="relative">
              {/* Era `OpeningReportGate`: un formulario de 4 pasos que BLOQUEABA
                  la app hasta enviarlo. Ahora es una bienvenida que se va sola
                  (decisión del dueño; el costo — 3 columnas de Reportes diarios
                  que dejan de llenarse — está documentado en WelcomeGate). */}
              <WelcomeGate>
                {/* AVISO DE PAÍS SIN SINCRONIZAR. Los reportes no reciben la
                    tienda: la resuelven server-side con profiles.active_store_id.
                    Si esa sincronización falla, el encabezado dice un país y las
                    tablas responden por otro (antes MEZCLABA CO+EC; desde el fix
                    del 2026-07-21 salen vacías). En cualquiera de los dos casos
                    el dueño tiene que saberlo ANTES de leer un número y tomar
                    una decisión de plata con él. */}
                {!store.scopeSynced && (
                  <div
                    role="alert"
                    className="mb-3 flex items-start gap-3 rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3 shadow-card3d"
                  >
                    <AlertTriangle size={17} className="text-danger flex-shrink-0 mt-0.5" aria-hidden="true" />
                    <div className="min-w-0 text-xs text-danger">
                      <span className="font-semibold">No se pudo confirmar la tienda activa en el servidor.</span>{' '}
                      Los reportes, Productividad y Logística pueden salir vacíos o no corresponder a{' '}
                      <b>{brandName}</b>. Recargá la página antes de tomar decisiones con estos números.
                    </div>
                  </div>
                )}
                {store.needsSetup && <ConectarDropiBanner onAbrir={() => setWizardOpen(true)} />}
                {/* ⛔ LA FRESCURA DE IMPORCHAT VA AL LADO DE LA DE DROPI
                    (28-ago-2026). El badge existía y estaba probado, pero solo
                    se dibujaba en `/admin` —que es managerOnly, o sea que la
                    asesora NUNCA lo veía— y en `/inbox`.
                    Y de `orders.chat_*` cuelga TODO el vocabulario nuevo de
                    Confirmar y Seguimiento: la rayita verde, "Te respondió",
                    "toca llamar", el ciclo entero. Lo escribe `importchat-sync`,
                    que se ha quedado colgado en `running`. Con ese sync trabado
                    un cliente que escribió hace dos horas no aparece esperando y
                    la pantalla se ve igual de tranquila que si no hubiera nadie
                    — el "cero que sustituye a no se pudo medir", aplicado a
                    todas las etiquetas a la vez.
                    En tiendas sin ImporChat el badge devuelve `null`. */}
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <div className="min-w-0 flex-1"><SyncFreshness /></div>
                  <ImporchatSyncBadge />
                </div>
                {/* "Lo que sigue" — pieza A del protocolo del turno. Va DEBAJO
                    de los banners de salud (si el sync está roto, eso manda) y
                    ARRIBA del contador y del contenido: es lo primero que se
                    lee al entrar a cualquier pantalla. */}
                {/* ⛔ NO se monta dentro de un pedido (28-ago-2026).
                    La barra CARGA las colas de Seguimiento y Novedades, más el
                    índice de 90 días de touchpoints y una llamada a Dropi. En
                    `/pedido/:id` eso competía con la ficha por el mismo pool de
                    conexiones — el pedido que la asesora quiere ver quedaba
                    haciendo fila detrás de la descarga del tablero entero.
                    Y ni siquiera se dibujaba: sin colas leídas `siguienteAccion`
                    devuelve `'cargando'` y la barra renderiza `null`. O sea que
                    pagaba tres cargas para no mostrar nada.
                    No puede volver el bug del 21-ago ("Todo al día" con trabajo
                    pendiente): `al_dia` exige `segCargado === true`; sin datos la
                    barra queda MUDA, nunca equivocada. Y `/pedido/:id` no es una
                    pantalla de dirección: ahí la persona ya está en una tarea. */}
                {!activePath.startsWith('/pedido/') && <SiguienteAccionBar />}
                {/* La franja "EQUIPO HOY" (CounterBar) se fundió DENTRO del hero
                    de Confirmar: mostraba los mismos conf/canc/noresp del equipo
                    que las StatTiles del hero, más la barra de cobertura — que
                    ahora vive ahí. Una franja ancha menos apilada arriba. */}
                <Suspense fallback={<InlineRouteLoader />}>
                  <Outlet />
                </Suspense>
              </WelcomeGate>
            </div>
          </main>
        </div>
      </div>
      <InactivityGuard />
      </WaChatProvider>
    </OrderProvider>
  );
}

export default function ProtectedLayout() {
  return (
    <StoreProvider>
      <ProtectedLayoutInner />
    </StoreProvider>
  );
}

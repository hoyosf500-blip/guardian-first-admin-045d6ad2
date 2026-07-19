import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useOperatorHeartbeat } from '@/hooks/useOperatorHeartbeat';
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
import { BarChart3, Phone, Package, Settings, LogOut, Menu, AlertTriangle, RefreshCw, X, Truck, DollarSign } from 'lucide-react';
import CounterBar from '@/components/CounterBar';
import OpeningReportGate from '@/components/OpeningReportGate';
import SetupWizard from '@/components/SetupWizard';
import StoreSelector from '@/components/StoreSelector';
import SyncFreshness from '@/components/SyncFreshness';
import type { LucideIcon } from 'lucide-react';
import { IconRail, HudTopbar, AuroraBackdrop } from '@/components/ui3d';

const CFO_ENABLED = import.meta.env.VITE_ENABLE_CFO === 'true';

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
  { path: '/novedades', icon: AlertTriangle, label: 'Novedades', section: 'Gestión' },
  { path: '/admin', icon: Settings, label: 'Admin', section: 'Sistema', managerOnly: true },
  { path: '/logistica', icon: Truck, label: 'Logística', section: 'Operación', managerOnly: true },
  ...(CFO_ENABLED ? [{ path: '/cfo', icon: DollarSign, label: 'CFO', section: 'Finanzas', adminOnly: true } as NavItem] : []),
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

  // Heartbeat de jornada (tracking de inicio + tiempo activo/idle). El hook
  // tiene sus propios gates: solo emite ping para no-admin con tienda activa.
  // Mantener acá (no en un sub-componente) para que viva toda la sesión.
  useOperatorHeartbeat();

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
    void (async () => {
      const { error } = await (supabase.rpc as unknown as (
        fn: string, args: Record<string, unknown>
      ) => Promise<{ data: string | null; error: { message: string } | null }>)(
        'redeem_store_invite', { p_token: token },
      );
      try { localStorage.removeItem('guardian.pendingInvite'); } catch { /* noop */ }
      if (error) {
        toast.error('No se pudo unir a la tienda', { description: error.message });
        return;
      }
      toast.success('¡Listo! Te uniste a la tienda.');
      await store.refresh();
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

  // El user no es miembro de ninguna tienda.
  if (store.stores.length === 0) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="max-w-md w-full bg-card border border-border rounded-2xl p-8 text-center space-y-3">
          <div className="w-12 h-12 rounded-xl bg-warning/10 border border-warning/25 flex items-center justify-center mx-auto">
            <Package size={22} className="text-warning" />
          </div>
          <h1 className="text-lg font-bold text-foreground">Sin tiendas asignadas</h1>
          <p className="text-sm text-muted-foreground">
            Tu cuenta no pertenece a ninguna tienda todavía. Pedile al dueño que te agregue como miembro.
          </p>
          <button onClick={signOut} className="text-xs text-muted-foreground hover:text-foreground">
            Cerrar sesión
          </button>
        </div>
      </div>
    );
  }

  // Gate: si la tienda activa no tiene credenciales Dropi cargadas Y el usuario
  // es dueño, mostrar wizard por-tienda.
  if (store.needsSetup) {
    return <SetupWizard onDone={() => store.refresh()} />;
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
                      : <Package size={17} className="text-white" aria-hidden="true" />}
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
                  className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-card transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none">
                  <LogOut size={14} />
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
                <LiveClock />
                <div className="w-8 h-8 rounded-lg bg-accent/20 border border-accent/30 flex items-center justify-center text-xs font-bold text-accent"
                  aria-label={`Usuario: ${profile?.display_name || 'Usuario'}`}
                  title={profile?.display_name || 'Usuario'}>
                  {userInitial}
                </div>
              </>
            }
          />

          <main className="relative flex-1 overflow-y-auto p-4 md:p-6 bg-aurora">
            <AuroraBackdrop />
            <div className="relative">
              <OpeningReportGate>
                <div className="mb-3"><SyncFreshness /></div>
                {isConfirmar && <CounterBar />}
                <Suspense fallback={<InlineRouteLoader />}>
                  <Outlet />
                </Suspense>
              </OpeningReportGate>
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

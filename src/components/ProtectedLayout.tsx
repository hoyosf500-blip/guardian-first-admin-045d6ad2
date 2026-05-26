import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { OrderProvider } from '@/contexts/OrderContext';
import { StoreProvider, useStore } from '@/contexts/StoreContext';
import { useTheme } from '@/hooks/useTheme';
import { useIsMobile } from '@/hooks/use-mobile';
import { useState, useEffect, useRef, Suspense } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { BarChart3, Phone, Package, Settings, Sun, Moon, LogOut, Menu, AlertTriangle, RefreshCw, X, Truck, DollarSign } from 'lucide-react';
import CounterBar from '@/components/CounterBar';
import OpeningReportGate from '@/components/OpeningReportGate';
import SetupWizard from '@/components/SetupWizard';
import StoreSelector from '@/components/StoreSelector';
import type { LucideIcon } from 'lucide-react';

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
interface NavItem { path: string; icon: LucideIcon; label: string; adminOnly?: boolean; managerOnly?: boolean }

const NAV_ITEMS: NavItem[] = [
  { path: '/dashboard', icon: BarChart3, label: 'Dashboard' },
  { path: '/confirmar', icon: Phone, label: 'Confirmar' },
  { path: '/seguimiento', icon: Package, label: 'Seguimiento' },
  { path: '/novedades', icon: AlertTriangle, label: 'Novedades' },
  { path: '/admin', icon: Settings, label: 'Admin', managerOnly: true },
  { path: '/logistica', icon: Truck, label: 'Logística', managerOnly: true },
  ...(CFO_ENABLED ? [{ path: '/cfo', icon: DollarSign, label: 'CFO', adminOnly: true } as NavItem] : []),
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
  const { theme, toggleTheme } = useTheme();
  const isMobile = useIsMobile();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const store = useStore();

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
  const activeLabel = visibleTabs.find(t => activePath.startsWith(t.path))?.label
    || (activePath.startsWith('/pedido') ? 'Detalle Pedido' : 'Panel');

  const isConfirmar = activePath === '/confirmar';
  const userInitial = (profile?.display_name || 'U')[0].toUpperCase();

  return (
    <OrderProvider>
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
            'bg-surface border-r border-border',
            isMobile
              ? 'fixed inset-y-0 left-0 w-64 transition-transform duration-300 ease-out'
              : 'relative w-56',
            isMobile && !sidebarOpen ? '-translate-x-full' : 'translate-x-0',
          ].join(' ')}
        >
          <div className="h-14 px-4 flex items-center justify-between border-b border-border flex-shrink-0">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center shadow-lg shadow-accent/25 flex-shrink-0 overflow-hidden">
                {brandLogoUrl
                  ? <img src={brandLogoUrl} alt="" className="w-full h-full object-cover" />
                  : <Package size={16} className="text-accent-foreground" aria-hidden="true" />}
              </div>
              <div className="min-w-0">
                <div className="text-sm font-bold text-foreground leading-tight truncate">{brandName}</div>
                <div className="text-[10px] text-muted-foreground leading-tight">Panel COD</div>
              </div>
            </div>
            {isMobile && (
              <button
                onClick={() => setSidebarOpen(false)}
                aria-label="Cerrar menú"
                className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-card transition-colors duration-200 cursor-pointer"
              >
                <X size={16} />
              </button>
            )}
          </div>

          <div className="px-3 pt-3">
            <StoreSelector />
          </div>

          <nav className="flex-1 py-3 px-2 space-y-0.5 overflow-y-auto" aria-label="Secciones del CRM">
            {orderedTabs.map(tab => {
              const Icon = tab.icon;
              const isActive = activePath.startsWith(tab.path);
              return (
                <button
                  key={tab.path}
                  onClick={() => { navigate(tab.path); if (isMobile) setSidebarOpen(false); }}
                  aria-current={isActive ? 'page' : undefined}
                  className={[
                    'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium',
                    'transition-colors duration-200 cursor-pointer',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                    isActive
                      ? 'bg-accent text-accent-foreground shadow-sm shadow-accent/20'
                      : 'text-muted-foreground hover:text-foreground hover:bg-card',
                  ].join(' ')}
                >
                  <Icon size={17} aria-hidden="true" />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </nav>

          <div className="p-3 border-t border-border flex-shrink-0">
            <div className="flex items-center gap-2.5 px-2 py-2">
              <div className="w-8 h-8 rounded-lg bg-accent/20 border border-accent/30 flex items-center justify-center text-xs font-bold text-accent flex-shrink-0" aria-hidden="true">
                {userInitial}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold text-foreground truncate">{profile?.display_name || 'Usuario'}</div>
                <div className="text-[10px] text-muted-foreground">{
                  isAdmin ? 'Administrador'
                  : store.activeStore?.role === 'owner' ? 'Dueño'
                  : store.activeStore?.role === 'supervisor' ? 'Supervisor'
                  : 'Operadora'
                }</div>
              </div>
              <button onClick={signOut} aria-label="Cerrar sesión" title="Cerrar sesión"
                className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-card transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none">
                <LogOut size={14} />
              </button>
            </div>
          </div>
        </aside>

        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <header className="h-12 bg-surface/80 backdrop-blur-md border-b border-border flex items-center justify-between px-4 flex-shrink-0 gap-3">
            <div className="flex items-center gap-3 min-w-0">
              {isMobile && (
                <button onClick={() => setSidebarOpen(true)} aria-label="Abrir menú"
                  className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-card transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none">
                  <Menu size={18} />
                </button>
              )}
              <h1 className="text-sm font-semibold text-foreground truncate">{activeLabel}</h1>
            </div>

            <div className="flex items-center gap-2 flex-shrink-0">
              <LiveClock />
              <button onClick={toggleTheme}
                aria-label={theme === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'}
                className="w-8 h-8 rounded-lg bg-card border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:border-border-strong transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none">
                {theme === 'dark' ? <Sun size={14} aria-hidden="true" /> : <Moon size={14} aria-hidden="true" />}
              </button>
              <div className="w-8 h-8 rounded-lg bg-accent/20 border border-accent/30 flex items-center justify-center text-xs font-bold text-accent"
                aria-label={`Usuario: ${profile?.display_name || 'Usuario'}`}
                title={profile?.display_name || 'Usuario'}>
                {userInitial}
              </div>
            </div>
          </header>

          <main className="flex-1 overflow-y-auto p-4 md:p-6">
            <OpeningReportGate>
              {isConfirmar && <CounterBar />}
              <Suspense fallback={<InlineRouteLoader />}>
                <Outlet />
              </Suspense>
            </OpeningReportGate>
          </main>
        </div>
      </div>
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

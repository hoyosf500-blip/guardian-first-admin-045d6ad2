import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { OrderProvider } from '@/contexts/OrderContext';
import { useTheme } from '@/hooks/useTheme';
import { useIsMobile } from '@/hooks/use-mobile';
import { useState, useEffect, Suspense } from 'react';
import { useNavigate } from 'react-router-dom';
import { BarChart3, Phone, Package, LifeBuoy, Settings, Sun, Moon, LogOut, Menu, AlertTriangle, RefreshCw, X } from 'lucide-react';
import CounterBar from '@/components/CounterBar';
import type { LucideIcon } from 'lucide-react';

function InlineRouteLoader() {
  return (
    <div className="flex flex-col items-center justify-center py-20 gap-3" role="status" aria-live="polite">
      <RefreshCw size={24} className="text-accent animate-spin" aria-hidden="true" />
      <p className="text-xs text-muted-foreground">Cargando...</p>
    </div>
  );
}

interface NavItem { path: string; icon: LucideIcon; label: string; adminOnly?: boolean }

const NAV_ITEMS: NavItem[] = [
  { path: '/dashboard', icon: BarChart3, label: 'Dashboard' },
  { path: '/confirmar', icon: Phone, label: 'Confirmar' },
  { path: '/seguimiento', icon: Package, label: 'Seguimiento' },
  { path: '/novedades', icon: AlertTriangle, label: 'Novedades' },
  { path: '/rescate', icon: LifeBuoy, label: 'Rescate' },
  { path: '/admin', icon: Settings, label: 'Admin', adminOnly: true },
];

function LiveClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="font-mono text-xs text-muted-foreground tabular-nums hidden sm:block">
      {now.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
    </span>
  );
}

export default function ProtectedLayout() {
  const { user, profile, isAdmin, loading, signOut } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const isMobile = useIsMobile();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="text-center">
          <div className="w-12 h-12 rounded-xl bg-accent/20 flex items-center justify-center mx-auto mb-4 animate-pulse">
            <Package size={22} className="text-accent" />
          </div>
          <p className="text-sm text-muted-foreground font-semibold tracking-wide">Cargando Panel Operadora...</p>
        </div>
      </div>
    );
  }

  if (!user) return <Navigate to="/auth" replace />;

  const visibleTabs = NAV_ITEMS.filter(t => !t.adminOnly || isAdmin);
  const activePath = location.pathname;
  const activeLabel = visibleTabs.find(t => activePath.startsWith(t.path))?.label
    || (activePath.startsWith('/pedido') ? 'Detalle Pedido' : 'Panel');

  const isConfirmar = activePath === '/confirmar';
  const userInitial = (profile?.display_name || 'U')[0].toUpperCase();

  return (
    <OrderProvider>
      <div className="flex h-screen overflow-hidden bg-background">
        {/* Mobile overlay */}
        {isMobile && sidebarOpen && (
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 transition-opacity duration-200"
            onClick={() => setSidebarOpen(false)}
            aria-hidden="true"
          />
        )}

        {/* ── Sidebar ── */}
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
          {/* Logo / brand */}
          <div className="h-14 px-4 flex items-center justify-between border-b border-border flex-shrink-0">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center shadow-lg shadow-accent/25">
                <Package size={16} className="text-accent-foreground" aria-hidden="true" />
              </div>
              <div>
                <div className="text-sm font-bold text-foreground leading-tight">Guardian CRM</div>
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

          {/* Nav items */}
          <nav className="flex-1 py-3 px-2 space-y-0.5 overflow-y-auto" aria-label="Secciones del CRM">
            {visibleTabs.map(tab => {
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

          {/* User footer */}
          <div className="p-3 border-t border-border flex-shrink-0">
            <div className="flex items-center gap-2.5 px-2 py-2">
              <div
                className="w-8 h-8 rounded-lg bg-accent/20 border border-accent/30 flex items-center justify-center text-xs font-bold text-accent flex-shrink-0"
                aria-hidden="true"
              >
                {userInitial}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold text-foreground truncate">{profile?.display_name || 'Usuario'}</div>
                <div className="text-[10px] text-muted-foreground">{isAdmin ? 'Administrador' : 'Operadora'}</div>
              </div>
              <button
                onClick={signOut}
                aria-label="Cerrar sesión"
                title="Cerrar sesión"
                className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-card transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
              >
                <LogOut size={14} />
              </button>
            </div>
          </div>
        </aside>

        {/* ── Main area ── */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {/* Topbar */}
          <header className="h-12 bg-surface/80 backdrop-blur-md border-b border-border flex items-center justify-between px-4 flex-shrink-0 gap-3">
            <div className="flex items-center gap-3 min-w-0">
              {isMobile && (
                <button
                  onClick={() => setSidebarOpen(true)}
                  aria-label="Abrir menú"
                  className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-card transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
                >
                  <Menu size={18} />
                </button>
              )}
              <h1 className="text-sm font-semibold text-foreground truncate">{activeLabel}</h1>
            </div>

            <div className="flex items-center gap-2 flex-shrink-0">
              <LiveClock />
              <button
                onClick={toggleTheme}
                aria-label={theme === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'}
                className="w-8 h-8 rounded-lg bg-card border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:border-border-strong transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
              >
                {theme === 'dark' ? <Sun size={14} aria-hidden="true" /> : <Moon size={14} aria-hidden="true" />}
              </button>
              <div
                className="w-8 h-8 rounded-lg bg-accent/20 border border-accent/30 flex items-center justify-center text-xs font-bold text-accent"
                aria-label={`Usuario: ${profile?.display_name || 'Usuario'}`}
                title={profile?.display_name || 'Usuario'}
              >
                {userInitial}
              </div>
            </div>
          </header>

          {/* Page content */}
          <main className="flex-1 overflow-y-auto p-4 md:p-6">
            {isConfirmar && <CounterBar />}
            <Suspense fallback={<InlineRouteLoader />}>
              <Outlet />
            </Suspense>
          </main>
        </div>
      </div>
    </OrderProvider>
  );
}

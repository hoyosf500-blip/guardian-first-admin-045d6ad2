import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { OrderProvider } from '@/contexts/OrderContext';
import { useTheme } from '@/hooks/useTheme';
import { useIsMobile } from '@/hooks/use-mobile';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BarChart3, Phone, Package, LifeBuoy, Settings, Sun, Moon, LogOut, Menu, AlertTriangle } from 'lucide-react';
import CounterBar from '@/components/CounterBar';
import type { LucideIcon } from 'lucide-react';

interface NavItem { path: string; icon: LucideIcon; label: string; adminOnly?: boolean }

const NAV_ITEMS: NavItem[] = [
  { path: '/dashboard', icon: BarChart3, label: 'Dashboard' },
  { path: '/confirmar', icon: Phone, label: 'Confirmar' },
  { path: '/seguimiento', icon: Package, label: 'Seguimiento' },
  { path: '/novedades', icon: AlertTriangle, label: 'Novedades' },
  { path: '/rescate', icon: LifeBuoy, label: 'Rescate' },
  { path: '/admin', icon: Settings, label: 'Admin', adminOnly: true },
];

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
          <div className="w-10 h-10 rounded-2xl bg-primary/20 flex items-center justify-center mx-auto mb-3 animate-pulse">
            <Package size={20} className="text-primary" />
          </div>
          <p className="text-sm text-muted-foreground font-semibold">Cargando Panel Operadora...</p>
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

  return (
    <OrderProvider>
      <div className="flex h-screen overflow-hidden bg-background">
        {isMobile && sidebarOpen && (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40" onClick={() => setSidebarOpen(false)} />
        )}
        <aside className={`
          ${isMobile ? 'fixed inset-y-0 left-0 z-50 w-64 transition-transform duration-300 ease-out' : 'relative w-60 flex-shrink-0'}
          ${isMobile && !sidebarOpen ? '-translate-x-full' : 'translate-x-0'}
          bg-card border-r border-border flex flex-col
        `}>
          <div className="px-5 h-16 flex items-center gap-3 border-b border-border">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center text-primary-foreground text-sm font-bold shadow-lg shadow-primary/20">
              P
            </div>
            <div>
              <div className="text-sm font-bold text-foreground leading-tight">Panel COD</div>
              <div className="text-[10px] text-muted-foreground">Operadora</div>
            </div>
          </div>

          <nav className="flex-1 py-4 px-3 space-y-1 overflow-y-auto">
            {visibleTabs.map(tab => {
              const Icon = tab.icon;
              const isActive = activePath.startsWith(tab.path);
              return (
                <button
                  key={tab.path}
                  onClick={() => { navigate(tab.path); if (isMobile) setSidebarOpen(false); }}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 ${
                    isActive
                      ? 'bg-gradient-to-r from-primary to-primary/80 text-primary-foreground shadow-md shadow-primary/15'
                      : 'text-muted-foreground hover:text-foreground hover:bg-secondary/80'
                  }`}
                >
                  <Icon size={18} />
                  {tab.label}
                </button>
              );
            })}
          </nav>

          <div className="p-3 border-t border-border">
            <div className="flex items-center gap-3 px-2 py-2.5">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500 to-violet-500 flex items-center justify-center text-xs font-bold text-white shadow-md">
                {(profile?.display_name || 'U')[0].toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-foreground truncate">{profile?.display_name || 'Usuario'}</div>
                <div className="text-[10px] text-muted-foreground">{isAdmin ? 'Administrador' : 'Operadora'}</div>
              </div>
              <button onClick={signOut} className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors" title="Cerrar sesión">
                <LogOut size={14} />
              </button>
            </div>
          </div>
        </aside>

        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <header className="h-14 bg-card/80 backdrop-blur-md border-b border-border flex items-center justify-between px-5 flex-shrink-0">
            <div className="flex items-center gap-3">
              {isMobile && (
                <button onClick={() => setSidebarOpen(true)} className="text-muted-foreground hover:text-foreground p-1">
                  <Menu size={20} />
                </button>
              )}
              <h1 className="text-base font-bold text-foreground">{activeLabel}</h1>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={toggleTheme}
                className="w-8 h-8 rounded-xl bg-secondary flex items-center justify-center text-muted-foreground hover:text-foreground transition-all hover:bg-secondary/80"
              >
                {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
              </button>
              <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center text-primary-foreground text-xs font-bold">
                {(profile?.display_name || 'U')[0].toUpperCase()}
              </div>
            </div>
          </header>

          <main className="flex-1 overflow-y-auto p-4 md:p-6">
            {isConfirmar && <CounterBar />}
            <Outlet />
          </main>
        </div>
      </div>
    </OrderProvider>
  );
}

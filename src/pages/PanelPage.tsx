import { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import ConfirmarTab from '@/components/tabs/ConfirmarTab';
import SeguimientoTab from '@/components/tabs/SeguimientoTab';
import RescateTab from '@/components/tabs/RescateTab';
import DashboardTab from '@/components/tabs/DashboardTab';
import AdminTab from '@/components/tabs/AdminTab';
import { OrderProvider } from '@/contexts/OrderContext';
import { useTheme } from '@/hooks/useTheme';
import { useIsMobile } from '@/hooks/use-mobile';

type Tab = 'dashboard' | 'confirmar' | 'seguimiento' | 'rescate' | 'admin';

const NAV_ITEMS: { id: Tab; icon: string; label: string; adminOnly?: boolean }[] = [
  { id: 'dashboard', icon: '📊', label: 'Dashboard' },
  { id: 'confirmar', icon: '📞', label: 'Confirmar' },
  { id: 'seguimiento', icon: '📦', label: 'Seguimiento' },
  { id: 'rescate', icon: '🆘', label: 'Rescate' },
  { id: 'admin', icon: '⚙️', label: 'Admin', adminOnly: true },
];

export default function PanelPage() {
  const { profile, isAdmin, signOut } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');
  const { theme, toggleTheme } = useTheme();
  const isMobile = useIsMobile();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const visibleTabs = NAV_ITEMS.filter(t => !t.adminOnly || isAdmin);

  return (
    <OrderProvider>
      <div className="flex h-screen overflow-hidden bg-background">
        {/* ─── Sidebar (desktop) / Drawer (mobile) ─── */}
        {isMobile && sidebarOpen && (
          <div className="fixed inset-0 bg-foreground/20 z-40" onClick={() => setSidebarOpen(false)} />
        )}
        <aside className={`
          ${isMobile ? 'fixed inset-y-0 left-0 z-50 w-64 transition-transform duration-200' : 'relative w-60 flex-shrink-0'}
          ${isMobile && !sidebarOpen ? '-translate-x-full' : 'translate-x-0'}
          bg-surface border-r border-border flex flex-col
        `}>
          {/* Logo area */}
          <div className="px-5 h-16 flex items-center gap-3 border-b border-border">
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center text-primary-foreground text-sm font-bold">
              P
            </div>
            <div>
              <div className="text-sm font-semibold text-foreground leading-tight">Panel COD</div>
              <div className="text-[10px] text-muted-foreground">Operadora</div>
            </div>
          </div>

          {/* Nav */}
          <nav className="flex-1 py-3 px-3 space-y-0.5 overflow-y-auto">
            {visibleTabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => { setActiveTab(tab.id); if (isMobile) setSidebarOpen(false); }}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  activeTab === tab.id
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
                }`}
              >
                <span className="text-base">{tab.icon}</span>
                {tab.label}
              </button>
            ))}
          </nav>

          {/* User section */}
          <div className="p-3 border-t border-border">
            <div className="flex items-center gap-3 px-2 py-2">
              <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center text-xs font-bold text-foreground">
                {(profile?.display_name || 'U')[0].toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-foreground truncate">{profile?.display_name || 'Usuario'}</div>
                <div className="text-[10px] text-muted-foreground">{isAdmin ? 'Administrador' : 'Operadora'}</div>
              </div>
              <button onClick={signOut} className="text-muted-foreground hover:text-foreground text-xs" title="Cerrar sesión">
                ↪
              </button>
            </div>
          </div>
        </aside>

        {/* ─── Main content ─── */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {/* Top bar */}
          <header className="h-16 bg-surface border-b border-border flex items-center justify-between px-5 flex-shrink-0">
            <div className="flex items-center gap-3">
              {isMobile && (
                <button onClick={() => setSidebarOpen(true)} className="text-muted-foreground hover:text-foreground p-1">
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                </button>
              )}
              <div>
                <h1 className="text-lg font-semibold text-foreground">
                  {visibleTabs.find(t => t.id === activeTab)?.label}
                </h1>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={toggleTheme}
                className="w-8 h-8 rounded-lg bg-secondary flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors text-sm"
              >
                {theme === 'dark' ? '☀️' : '🌙'}
              </button>
              <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-primary-foreground text-xs font-bold">
                {(profile?.display_name || 'U')[0].toUpperCase()}
              </div>
            </div>
          </header>

          {/* Page content */}
          <main className="flex-1 overflow-y-auto p-5 md:p-8">
            {activeTab === 'dashboard' && <DashboardTab />}
            {activeTab === 'confirmar' && <ConfirmarTab profile={profile} onLogout={signOut} />}
            {activeTab === 'seguimiento' && <SeguimientoTab />}
            {activeTab === 'rescate' && <RescateTab />}
            {activeTab === 'admin' && isAdmin && <AdminTab />}
          </main>
        </div>
      </div>
    </OrderProvider>
  );
}

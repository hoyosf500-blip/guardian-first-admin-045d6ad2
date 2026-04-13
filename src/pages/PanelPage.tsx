import { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import ConfirmarTab from '@/components/tabs/ConfirmarTab';
import SeguimientoTab from '@/components/tabs/SeguimientoTab';
import RescateTab from '@/components/tabs/RescateTab';
import DashboardTab from '@/components/tabs/DashboardTab';
import AdminTab from '@/components/tabs/AdminTab';
import CounterBar from '@/components/CounterBar';
import { OrderProvider } from '@/contexts/OrderContext';
import { useTheme } from '@/hooks/useTheme';
import { useIsMobile } from '@/hooks/use-mobile';
import { motion, AnimatePresence } from 'framer-motion';
import { BarChart3, Phone, Package, LifeBuoy, Settings, Sun, Moon, LogOut, Menu } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

type Tab = 'dashboard' | 'confirmar' | 'seguimiento' | 'rescate' | 'admin';

const NAV_ITEMS: { id: Tab; icon: LucideIcon; label: string; adminOnly?: boolean }[] = [
  { id: 'dashboard', icon: BarChart3, label: 'Dashboard' },
  { id: 'confirmar', icon: Phone, label: 'Confirmar' },
  { id: 'seguimiento', icon: Package, label: 'Seguimiento' },
  { id: 'rescate', icon: LifeBuoy, label: 'Rescate' },
  { id: 'admin', icon: Settings, label: 'Admin', adminOnly: true },
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
        {isMobile && sidebarOpen && (
          <div className="fixed inset-0 bg-foreground/20 z-40" onClick={() => setSidebarOpen(false)} />
        )}
        <aside className={`
          ${isMobile ? 'fixed inset-y-0 left-0 z-50 w-64 transition-transform duration-200' : 'relative w-60 flex-shrink-0'}
          ${isMobile && !sidebarOpen ? '-translate-x-full' : 'translate-x-0'}
          bg-surface border-r border-border flex flex-col
        `}>
          <div className="px-5 h-16 flex items-center gap-3 border-b border-border">
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center text-primary-foreground text-sm font-bold">
              P
            </div>
            <div>
              <div className="text-sm font-semibold text-foreground leading-tight">Panel COD</div>
              <div className="text-[10px] text-muted-foreground">Operadora</div>
            </div>
          </div>

          <nav className="flex-1 py-3 px-3 space-y-0.5 overflow-y-auto">
            {visibleTabs.map(tab => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => { setActiveTab(tab.id); if (isMobile) setSidebarOpen(false); }}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                    activeTab === tab.id
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
                  }`}
                >
                  <Icon size={18} />
                  {tab.label}
                </button>
              );
            })}
          </nav>

          <div className="p-3 border-t border-border">
            <div className="flex items-center gap-3 px-2 py-2">
              <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center text-xs font-bold text-foreground">
                {(profile?.display_name || 'U')[0].toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-foreground truncate">{profile?.display_name || 'Usuario'}</div>
                <div className="text-[10px] text-muted-foreground">{isAdmin ? 'Administrador' : 'Operadora'}</div>
              </div>
              <button onClick={signOut} className="text-muted-foreground hover:text-foreground" title="Cerrar sesión">
                <LogOut size={14} />
              </button>
            </div>
          </div>
        </aside>

        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <header className="h-16 bg-surface border-b border-border flex items-center justify-between px-5 flex-shrink-0">
            <div className="flex items-center gap-3">
              {isMobile && (
                <button onClick={() => setSidebarOpen(true)} className="text-muted-foreground hover:text-foreground p-1">
                  <Menu size={20} />
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
                className="w-8 h-8 rounded-lg bg-secondary flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
              >
                {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
              </button>
              <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-primary-foreground text-xs font-bold">
                {(profile?.display_name || 'U')[0].toUpperCase()}
              </div>
            </div>
          </header>

          <main className="flex-1 overflow-y-auto p-5 md:p-8">
            {activeTab === 'confirmar' && <CounterBar />}
            <AnimatePresence mode="wait">
              <motion.div
                key={activeTab}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
              >
                {activeTab === 'dashboard' && <DashboardTab />}
                {activeTab === 'confirmar' && <ConfirmarTab profile={profile} onLogout={signOut} />}
                {activeTab === 'seguimiento' && <SeguimientoTab />}
                {activeTab === 'rescate' && <RescateTab />}
                {activeTab === 'admin' && isAdmin && <AdminTab />}
              </motion.div>
            </AnimatePresence>
          </main>
        </div>
      </div>
    </OrderProvider>
  );
}

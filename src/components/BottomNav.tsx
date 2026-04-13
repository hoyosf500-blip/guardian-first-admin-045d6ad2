import { BarChart3, Phone, Package, LifeBuoy, Settings } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

type Tab = 'confirmar' | 'seguimiento' | 'rescate' | 'dashboard' | 'admin';

interface Props {
  activeTab: Tab;
  setActiveTab: (tab: Tab) => void;
  isAdmin: boolean;
}

const TABS: { id: Tab; icon: LucideIcon; label: string; adminOnly?: boolean }[] = [
  { id: 'confirmar', icon: Phone, label: 'Confirmar' },
  { id: 'seguimiento', icon: Package, label: 'Seguimiento' },
  { id: 'rescate', icon: LifeBuoy, label: 'Rescate' },
  { id: 'dashboard', icon: BarChart3, label: 'Dashboard' },
  { id: 'admin', icon: Settings, label: 'Admin', adminOnly: true },
];

export default function BottomNav({ activeTab, setActiveTab, isAdmin }: Props) {
  const tabs = TABS.filter(t => !t.adminOnly || isAdmin);

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 bg-surface border-t border-border flex p-1.5 pb-[calc(6px+env(safe-area-inset-bottom))] gap-1">
      {tabs.map(tab => {
        const Icon = tab.icon;
        return (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 flex flex-col items-center gap-0.5 py-2 px-1 rounded-xl text-[10px] font-semibold transition-all ${
              activeTab === tab.id
                ? 'text-cyan bg-cyan/10'
                : 'text-muted-foreground'
            }`}
          >
            <Icon size={20} />
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}

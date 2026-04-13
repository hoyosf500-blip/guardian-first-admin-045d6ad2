type Tab = 'confirmar' | 'seguimiento' | 'rescate' | 'dashboard' | 'admin';

interface Props {
  activeTab: Tab;
  setActiveTab: (tab: Tab) => void;
  isAdmin: boolean;
}

export default function BottomNav({ activeTab, setActiveTab, isAdmin }: Props) {
  const tabs: { id: Tab; icon: string; label: string; adminOnly?: boolean }[] = [
    { id: 'confirmar', icon: '📞', label: 'Confirmar' },
    { id: 'seguimiento', icon: '📦', label: 'Seguimiento' },
    { id: 'rescate', icon: '🆘', label: 'Rescate' },
    { id: 'dashboard', icon: '📊', label: 'Dashboard' },
    ...(isAdmin ? [{ id: 'admin' as Tab, icon: '🔧', label: 'Admin', adminOnly: true }] : []),
  ];

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 bg-surface border-t border-border flex p-1.5 pb-[calc(6px+env(safe-area-inset-bottom))] gap-1">
      {tabs.map(tab => (
        <button
          key={tab.id}
          onClick={() => setActiveTab(tab.id)}
          className={`flex-1 flex flex-col items-center gap-0.5 py-2 px-1 rounded-xl text-[10px] font-semibold transition-all ${
            activeTab === tab.id
              ? 'text-cyan bg-cyan/10'
              : 'text-muted-foreground'
          }`}
        >
          <span className="text-xl">{tab.icon}</span>
          {tab.label}
        </button>
      ))}
    </nav>
  );
}

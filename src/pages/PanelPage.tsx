import { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import BottomNav from '@/components/BottomNav';
import ConfirmarTab from '@/components/tabs/ConfirmarTab';
import SeguimientoTab from '@/components/tabs/SeguimientoTab';
import RescateTab from '@/components/tabs/RescateTab';
import DashboardTab from '@/components/tabs/DashboardTab';
import AdminTab from '@/components/tabs/AdminTab';
import CounterBar from '@/components/CounterBar';
import { OrderProvider } from '@/contexts/OrderContext';

type Tab = 'confirmar' | 'seguimiento' | 'rescate' | 'dashboard' | 'admin';

export default function PanelPage() {
  const { profile, isAdmin, signOut } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>('confirmar');

  return (
    <OrderProvider>
      <div className="min-h-screen bg-background pb-24">
        {activeTab === 'confirmar' && <CounterBar />}
        
        <div className="px-4 md:px-10 pt-4">
          {activeTab === 'confirmar' && <ConfirmarTab profile={profile} onLogout={signOut} />}
          {activeTab === 'seguimiento' && <SeguimientoTab />}
          {activeTab === 'rescate' && <RescateTab />}
          {activeTab === 'dashboard' && <DashboardTab />}
          {activeTab === 'admin' && isAdmin && <AdminTab />}
        </div>

        <BottomNav activeTab={activeTab} setActiveTab={setActiveTab} isAdmin={isAdmin} />
      </div>
    </OrderProvider>
  );
}

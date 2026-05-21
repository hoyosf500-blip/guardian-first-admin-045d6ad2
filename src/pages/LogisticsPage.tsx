import { useStore } from '@/contexts/StoreContext';
import { Navigate } from 'react-router-dom';
import LogisticaTab from '@/components/tabs/LogisticaTab';

// /logistica — accesible para owner o supervisor de la tienda activa (no admin
// global). Una operadora que navegue acá directo rebota a /dashboard.
export default function LogisticsPage() {
  const { isManagerOfActive } = useStore();
  if (!isManagerOfActive) return <Navigate to="/dashboard" replace />;
  return <LogisticaTab />;
}

import { useStore } from '@/contexts/StoreContext';
import { Navigate } from 'react-router-dom';
import AdminTab from '@/components/tabs/AdminTab';

// /admin — accesible para owner o supervisor de la tienda activa (no admin
// global). Una operadora que navegue acá directo rebota a /dashboard.
export default function AdminPage() {
  const { isManagerOfActive } = useStore();
  if (!isManagerOfActive) return <Navigate to="/dashboard" replace />;
  return <AdminTab />;
}

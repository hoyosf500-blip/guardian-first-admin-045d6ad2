import { useAuth } from '@/contexts/AuthContext';
import { useStore } from '@/contexts/StoreContext';
import { Navigate } from 'react-router-dom';
import CfoTab from '@/components/tabs/CfoTab';

// /cfo — vista financiera PERSONAL del dueño (tarjetas, deuda, pauta). Solo
// admin (= Fabian; los amigos invitados son operator/owner, nunca admin) y
// SOLO cuando la tienda activa es Colombia. En Ecuador u otra tienda rebota a
// /dashboard. Defensa en profundidad: los datos CFO ya están protegidos por
// RLS admin-only a nivel DB, esto es el gate de UI/ruta.
export default function CfoPage() {
  const { isAdmin } = useAuth();
  const { activeStore } = useStore();
  if (!isAdmin || activeStore?.country_code !== 'CO') return <Navigate to="/dashboard" replace />;
  return <CfoTab />;
}

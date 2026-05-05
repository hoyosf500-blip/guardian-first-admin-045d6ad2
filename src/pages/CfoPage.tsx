import { useAuth } from '@/contexts/AuthContext';
import { Navigate } from 'react-router-dom';
import CfoTab from '@/components/tabs/CfoTab';

// /cfo — vista "Cómo voy" para el dueño. Mismo guard que /admin (solo
// admin puede entrar). Si una operadora intenta navegar acá, la
// rebotamos a /dashboard.
export default function CfoPage() {
  const { isAdmin } = useAuth();
  if (!isAdmin) return <Navigate to="/dashboard" replace />;
  return <CfoTab />;
}

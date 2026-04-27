import { useAuth } from '@/contexts/AuthContext';
import { Navigate } from 'react-router-dom';
import LogisticaTab from '@/components/tabs/LogisticaTab';

export default function LogisticsPage() {
  const { isAdmin } = useAuth();
  if (!isAdmin) return <Navigate to="/dashboard" replace />;
  return <LogisticaTab />;
}

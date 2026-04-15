import { useAuth } from '@/contexts/AuthContext';
import { Navigate } from 'react-router-dom';
import AdminTab from '@/components/tabs/AdminTab';
export default function AdminPage() {
  const { isAdmin } = useAuth();
  if (!isAdmin) return <Navigate to="/dashboard" replace />;
  return <AdminTab />;
}

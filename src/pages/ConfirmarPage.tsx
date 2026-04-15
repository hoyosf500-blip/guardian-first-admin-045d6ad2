import { useAuth } from '@/contexts/AuthContext';
import ConfirmarTab from '@/components/tabs/ConfirmarTab';
export default function ConfirmarPage() {
  const { profile, signOut } = useAuth();
  return <ConfirmarTab profile={profile} onLogout={signOut} />;
}

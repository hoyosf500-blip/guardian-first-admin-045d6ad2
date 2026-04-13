import { useAuth } from '@/contexts/AuthContext';
import AuthPage from './AuthPage';
import PanelPage from './PanelPage';

export default function Index() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="text-center">
          <div className="text-5xl mb-3 animate-bounce">📞</div>
          <p className="text-sm text-muted-foreground font-semibold">Cargando Panel Operadora...</p>
        </div>
      </div>
    );
  }

  return user ? <PanelPage /> : <AuthPage />;
}

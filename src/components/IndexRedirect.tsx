import { Navigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useStore } from '@/contexts/StoreContext';

/**
 * Aterrizaje del index (`/`) según rol. Las operadoras caen directo en su
 * primera tarea del día (Confirmar) en vez del Dashboard de gráficas — uno de
 * los puntos donde más "se perdían" al entrar. Managers/admin siguen yendo al
 * Dashboard.
 *
 * Se renderiza dentro del outlet de ProtectedLayout, que ya bloqueó el render
 * mientras auth/store cargaban, así que `isManagerOfActive`/`isAdmin` ya son
 * confiables aquí.
 */
export default function IndexRedirect() {
  const { isAdmin } = useAuth();
  const { isManagerOfActive } = useStore();
  const target = isAdmin || isManagerOfActive ? '/dashboard' : '/confirmar';
  return <Navigate to={target} replace />;
}

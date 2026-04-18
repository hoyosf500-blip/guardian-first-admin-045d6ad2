import { useAuth } from "@/contexts/AuthContext";
import { Package } from "lucide-react";
import AuthPage from "./AuthPage";
import PanelPage from "./PanelPage";

export default function Index() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="text-center">
          <div className="w-14 h-14 rounded-2xl bg-accent/20 flex items-center justify-center mx-auto mb-4 animate-pulse">
            <Package size={26} className="text-accent" aria-hidden="true" />
          </div>
          <p className="text-sm text-muted-foreground font-semibold">Cargando Panel Operadora...</p>
        </div>
      </div>
    );
  }

  return user ? <PanelPage /> : <AuthPage />;
}

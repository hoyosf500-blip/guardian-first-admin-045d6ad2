import { lazy, Suspense } from 'react';
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes, Navigate } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MotionConfig } from "framer-motion";
import { AuthProvider } from "@/contexts/AuthContext";
import ErrorBoundary from "@/components/ErrorBoundary";
import ProtectedLayout from "@/components/ProtectedLayout";
import { RefreshCw } from 'lucide-react';

// Lazy-load page components so the initial bundle only contains the auth page
// and shared layout. Each route chunk loads on first navigation (~2-5 KB each).
const AuthPage = lazy(() => import("@/pages/AuthPage"));
const DashboardPage = lazy(() => import("@/pages/DashboardPage"));
const ConfirmarPage = lazy(() => import("@/pages/ConfirmarPage"));
const SeguimientoPage = lazy(() => import("@/pages/SeguimientoPage"));
const NovedadesPage = lazy(() => import("@/pages/NovedadesPage"));
const RescatePage = lazy(() => import("@/pages/RescatePage"));
const AdminPage = lazy(() => import("@/pages/AdminPage"));
const OrderDetailPage = lazy(() => import("@/pages/OrderDetailPage"));
const NotFound = lazy(() => import("@/pages/NotFound"));

const queryClient = new QueryClient();

function PageLoader() {
  return (
    <div className="flex flex-col items-center justify-center py-20 gap-3">
      <RefreshCw size={24} className="text-primary animate-spin" />
      <p className="text-xs text-muted-foreground">Cargando...</p>
    </div>
  );
}

// OLD-1: ErrorBoundary granular por ruta. Antes había uno solo a nivel
// raíz: un crash en OrderCard tiraba la app entera (sidebar incluido)
// y bloqueaba a las 2-3 operadoras en simultáneo. Ahora un crash en
// /confirmar no afecta a /seguimiento ni al sidebar.
const route = (Element: React.ReactElement) => (
  <ErrorBoundary>{Element}</ErrorBoundary>
);

const App = () => (
  <MotionConfig reducedMotion="user">
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Sonner />
      <ErrorBoundary>
        <AuthProvider>
          <BrowserRouter>
            <Suspense fallback={<PageLoader />}>
              <Routes>
                <Route path="/auth" element={route(<AuthPage />)} />
                <Route element={<ProtectedLayout />}>
                  <Route path="/" element={<Navigate to="/dashboard" replace />} />
                  <Route path="/dashboard" element={route(<DashboardPage />)} />
                  <Route path="/confirmar" element={route(<ConfirmarPage />)} />
                  <Route path="/seguimiento" element={route(<SeguimientoPage />)} />
                  <Route path="/novedades" element={route(<NovedadesPage />)} />
                  <Route path="/rescate" element={route(<RescatePage />)} />
                  <Route path="/admin" element={route(<AdminPage />)} />
                  <Route path="/pedido/:externalId" element={route(<OrderDetailPage />)} />
                </Route>
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
          </BrowserRouter>
        </AuthProvider>
      </ErrorBoundary>
    </TooltipProvider>
  </QueryClientProvider>
  </MotionConfig>
);

export default App;

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
                <Route path="/auth" element={<AuthPage />} />
                <Route element={<ProtectedLayout />}>
                  <Route path="/" element={<Navigate to="/dashboard" replace />} />
                  <Route path="/dashboard" element={<DashboardPage />} />
                  <Route path="/confirmar" element={<ConfirmarPage />} />
                  <Route path="/seguimiento" element={<SeguimientoPage />} />
                  <Route path="/novedades" element={<NovedadesPage />} />
                  <Route path="/rescate" element={<RescatePage />} />
                  <Route path="/admin" element={<AdminPage />} />
                  <Route path="/pedido/:externalId" element={<OrderDetailPage />} />
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

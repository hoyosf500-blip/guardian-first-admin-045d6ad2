import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes, Navigate } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/contexts/AuthContext";
import ProtectedLayout from "@/components/ProtectedLayout";
import AuthPage from "@/pages/AuthPage";
import DashboardPage from "@/pages/DashboardPage";
import ConfirmarPage from "@/pages/ConfirmarPage";
import SeguimientoPage from "@/pages/SeguimientoPage";
import NovedadesPage from "@/pages/NovedadesPage";
import RescatePage from "@/pages/RescatePage";
import AdminPage from "@/pages/AdminPage";
import OrderDetailPage from "@/pages/OrderDetailPage";
import NotFound from "./pages/NotFound.tsx";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Sonner />
      <AuthProvider>
        <BrowserRouter>
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
        </BrowserRouter>
      </AuthProvider>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;

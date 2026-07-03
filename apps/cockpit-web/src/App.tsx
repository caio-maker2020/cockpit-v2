import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/contexts/AuthContext";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import { AppLayout } from "@/components/layout/AppLayout";
import { EnvBanner } from "@/components/layout/EnvBanner";
import Login from "./pages/Login";
import Inbox from "./pages/Inbox";
import CardDetail from "./pages/CardDetail";
import Resolvidos from "./pages/Resolvidos";
import Configuracoes from "./pages/Configuracoes";
import Auditoria from "./pages/Auditoria";
import Cadastros from "./pages/Cadastros";
import CancelamentosReentrega from "./pages/CancelamentosReentrega";
import CancelamentoReentregaDetalhe from "./pages/CancelamentoReentregaDetalhe";
import Indicadores from "./pages/Indicadores";
import Extravios from "./pages/Extravios";
import Conflitos from "./pages/Conflitos";
import Administracao from "./pages/Administracao";

import Placeholder from "./pages/Placeholder";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      // Pausa polling/refetch quando aba não está visível (default do RQ é false aqui já)
      refetchOnWindowFocus: false,
      refetchIntervalInBackground: false,
      // Evita refetch agressivo quando vários componentes pedem a mesma query —
      // mantém em cache por 30s; realtime invalida quando há mudança de verdade.
      staleTime: 30_000,
      gcTime: 5 * 60_000,
    },
  },
});

const AppRoutes = () => (
  <Routes>
    <Route path="/login" element={<Login />} />

    <Route
      element={
        <ProtectedRoute>
          <AppLayout />
        </ProtectedRoute>
      }
    >
      <Route path="/" element={<Navigate to="/inbox" replace />} />
      <Route path="/inbox" element={<Inbox />} />
      <Route path="/cards/:id" element={<CardDetail />} />
      <Route path="/resolvidos" element={<Resolvidos />} />
      <Route path="/auditoria" element={<Auditoria />} />
      <Route path="/cadastros" element={<Cadastros />} />
      <Route path="/cancelamentos-reentrega" element={<CancelamentosReentrega />} />
      <Route path="/cancelamentos-reentrega/:acao_id" element={<CancelamentoReentregaDetalhe />} />
      <Route path="/indicadores" element={<Indicadores />} />
      <Route path="/extravios" element={<Extravios />} />
      <Route path="/conflitos" element={<Conflitos />} />
      <Route path="/administracao" element={<Administracao />} />
      <Route path="/configuracoes" element={<Configuracoes />} />
    </Route>

    {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
    <Route path="*" element={<NotFound />} />
  </Routes>
);

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <EnvBanner />
      <BrowserRouter>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;

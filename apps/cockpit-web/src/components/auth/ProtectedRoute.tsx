import { Navigate, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "@/contexts/AuthContext";

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { session, loading, configured } = useAuth();
  const location = useLocation();

  // While Supabase isn't configured, allow the app shell to render so the
  // operator/dev can see the layout. Once configured, enforce auth.
  if (!configured) return <>{children}</>;

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
        Carregando sessão…
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <>{children}</>;
}

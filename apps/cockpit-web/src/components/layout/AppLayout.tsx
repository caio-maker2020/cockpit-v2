import { Outlet } from "react-router-dom";
import { AppSidebar } from "./AppSidebar";
import { AppHeader } from "./AppHeader";
import { BannerFiltroOperador } from "./BannerFiltroOperador";
import { useAuth } from "@/contexts/AuthContext";

export function AppLayout() {
  const { configured } = useAuth();

  return (
    <div
      className="relative z-[2] flex h-screen w-full flex-col overflow-hidden"
      style={{ backgroundColor: "var(--bg)" }}
    >
      <AppHeader />
      <BannerFiltroOperador />
      <div className="flex min-h-0 flex-1">
        <AppSidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          {!configured && (
            <div
              className="px-4 py-2 font-mono text-[10px] uppercase tracking-widest"
              style={{
                background: "var(--warning-soft)",
                color: "var(--warning)",
                borderBottom: "1px solid var(--c-border)",
              }}
            >
              Lovable Cloud não conectado — habilite a integração para autenticação e dados.
            </div>
          )}
          <main className="min-w-0 flex-1 overflow-auto">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}

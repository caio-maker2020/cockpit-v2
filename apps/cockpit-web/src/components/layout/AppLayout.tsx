import { useState } from "react";
import { Outlet } from "react-router-dom";
import { AppSidebar } from "./AppSidebar";
import { AppHeader } from "./AppHeader";
import { BannerFiltroOperador } from "./BannerFiltroOperador";
import { AgenteChamando } from "./AgenteChamando";
import { useAuth } from "@/contexts/AuthContext";
import { Sheet, SheetContent } from "@/components/ui/sheet";

export function AppLayout() {
  const { configured } = useAuth();
  // Mobile: a sidebar vira drawer. Abre pelo hamburger do header, fecha ao
  // navegar (onNavigate) ou tocar fora. No desktop (md+) nada muda: sidebar fixa.
  const [menuAberto, setMenuAberto] = useState(false);

  return (
    <div
      className="relative z-[2] flex h-screen w-full flex-col overflow-hidden"
      style={{ backgroundColor: "var(--bg)" }}
    >
      <AppHeader onMenuClick={() => setMenuAberto(true)} />
      <BannerFiltroOperador />
      <div className="flex min-h-0 flex-1">
        <AppSidebar className="hidden md:flex" />
        <Sheet open={menuAberto} onOpenChange={setMenuAberto}>
          <SheetContent side="left" className="w-64 border-r-0 p-0">
            <AppSidebar className="flex w-full border-r-0" onNavigate={() => setMenuAberto(false)} />
          </SheetContent>
        </Sheet>
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
          {/* INV-068: o agente chamando o operador (barra inferior + conversa).
              Fica no layout pra aparecer em qualquer tela. Some ao marcar LIDO. */}
          <AgenteChamando />
        </div>
      </div>
    </div>
  );
}

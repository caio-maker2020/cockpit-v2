import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ChevronDown, LogOut, Menu } from "lucide-react";

import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/lib/supabase";
import { SalLogo } from "@/components/SalLogo";
import { FiltroOperadorAdmin } from "@/components/layout/FiltroOperadorAdmin";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function fmtClock(d: Date): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function AppHeader({ onMenuClick }: { onMenuClick?: () => void } = {}) {
  const { user, operador, signOut } = useAuth();
  const navigate = useNavigate();
  const now = useClock();

  // Último sync do Bastão — usa RPC com data+hora absoluta já formatada no servidor (BRT).
  const { data: syncStatus } = useQuery({
    queryKey: ["header", "status-ultimo-sync-bastao"],
    enabled: !!supabase,
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const { data } = await supabase!.rpc("status_ultimo_sync_bastao");
      return data as {
        ultimo_sync_bastao: string | null;
        ultimo_sync_bastao_fmt: string | null;
        minutos: number | null;
      } | null;
    },
  });

  const syncFmt = syncStatus?.ultimo_sync_bastao_fmt ?? null;
  const syncMin = syncStatus?.minutos ?? null;
  const syncOk = syncMin != null && syncMin <= 40;

  const name = operador?.nome ?? user?.email ?? "Operador";
  const handleSignOut = async () => {
    await signOut();
    navigate("/login", { replace: true });
  };

  return (
    <header
      className="relative flex h-[60px] shrink-0 items-center justify-between px-3 md:px-6"
      style={{
        backgroundColor: "var(--bg)",
        borderBottom: "1px solid var(--c-border)",
        color: "var(--c-ink)",
      }}
    >
      {/* Brand (+ hamburger no mobile: abre o drawer da navegação) */}
      <div className="flex items-center gap-2 md:gap-3">
        <button
          type="button"
          onClick={onMenuClick}
          aria-label="Abrir menu"
          className="grid h-9 w-9 place-items-center rounded-md transition-colors hover:bg-bg-subtle md:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>
        <SalLogo size={18} subtag="Operacional · Cockpit" />
      </div>

      {/* Centro: sync + clock */}
      <div className="hidden items-center gap-4 md:flex" style={{ color: "var(--c-ink-mute)" }}>
        <div className="flex items-center gap-1.5 font-mono" style={{ fontSize: "11px", letterSpacing: "0.06em" }}>
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${syncOk ? "animate-pulse-dot" : ""}`}
            style={{ background: syncOk ? "var(--positive)" : "var(--warning)" }}
            aria-hidden
          />
          <span className="uppercase">Sync</span>
          <span style={{ color: "var(--c-ink-soft)" }}>
            {syncFmt ? `· Atualizado ${syncFmt}` : "· —"}
          </span>
        </div>
        <span style={{ color: "var(--c-border-strong)" }}>·</span>
        <span className="tabular font-mono" style={{ fontSize: "12px", color: "var(--c-ink-soft)" }}>
          {fmtClock(now)}
        </span>
      </div>

      {/* Filtro global de operador (somente gestor) + Operador */}
      <div className="flex items-center gap-3">
        {operador?.pode_executar === false && (
          <span
            className="rounded-sm border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest"
            style={{ color: "var(--warning)", borderColor: "var(--warning)" }}
            title="Seu usuário vê tudo mas não executa ações (aprovações, e-mails, cadastros)."
          >
            Modo visualização
          </span>
        )}
        <FiltroOperadorAdmin />
      <DropdownMenu>
        <DropdownMenuTrigger
          className="flex items-center gap-2 rounded-md px-2.5 py-1.5 transition-colors hover:bg-bg-subtle focus-visible:outline-none"
          style={{ color: "var(--c-ink)" }}
        >
          <span className="font-body font-medium" style={{ fontSize: "13px" }}>
            {name}
          </span>
          <ChevronDown className="h-3.5 w-3.5" style={{ color: "var(--c-ink-mute)" }} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuLabel className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            {user?.email ?? "Sem sessão"}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleSignOut} className="text-[12px]">
            <LogOut className="mr-2 h-3.5 w-3.5" />
            Sair
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      </div>
    </header>
  );
}

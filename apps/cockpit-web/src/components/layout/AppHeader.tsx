// =============================================================================
// Header do redesign hifi (handoff design_handoff_cockpit — comum a todas as
// telas): logo + COCKPIT · nav em PÍLULAS · SYNC · "VENDO:" · avatar.
// A pílula ativa é vermelha (#E03131) com sombra; contagens críticas em
// vermelho. Desktop-first (o mobile mantém o drawer com a AppSidebar).
// Nada saiu do produto: as abas que não são pílulas moram no menu "Mais ▾".
// =============================================================================
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { NavLink, useNavigate } from "react-router-dom";
import { ChevronDown, LogOut, Menu, Moon, Sun } from "lucide-react";

import { useAuth, useIsGestor } from "@/contexts/AuthContext";
import { supabase } from "@/lib/supabase";
import { FiltroOperadorAdmin } from "@/components/layout/FiltroOperadorAdmin";
import { useNavCounts } from "@/components/layout/useNavCounts";
import { initials } from "@/lib/format";
import { alternarTema, lerTema, type Tema } from "@/lib/theme";
import logoSal from "@/assets/sal-express-logo.png";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** Modo escuro OPCIONAL (Caio 2026-08-27): um clique, por pessoa/navegador,
 *  padrão claro. Puramente visual — nenhuma lógica lê o tema (INV-112). */
function BotaoTema() {
  const [tema, setTema] = useState<Tema>(() => lerTema());
  return (
    <button
      type="button"
      onClick={() => setTema(alternarTema())}
      aria-label={tema === "escuro" ? "Mudar para modo claro" : "Mudar para modo escuro"}
      title={tema === "escuro" ? "Modo claro" : "Modo escuro"}
      className="grid h-8 w-8 place-items-center rounded-full text-ink-mute transition-colors hover:bg-subtle hover:text-ink"
    >
      {tema === "escuro" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function Pilula({
  to,
  rotulo,
  count,
  critica,
}: {
  to: string;
  rotulo: string;
  count?: number | null;
  critica?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={to === "/inbox"}
      className={({ isActive }) =>
        isActive
          ? "flex items-center gap-1.5 rounded-[20px] px-[15px] py-[7px] text-[12.5px] font-medium text-white"
          : "flex items-center gap-1.5 rounded-[20px] px-[15px] py-[7px] text-[12.5px] font-medium text-ink-soft-2 hover:bg-subtle"
      }
      style={({ isActive }) =>
        isActive
          ? { background: "var(--signal)", boxShadow: "0 4px 10px rgba(224,49,49,.22)" }
          : undefined
      }
    >
      {({ isActive }) => (
        <>
          {rotulo}
          {count != null && count > 0 && (
            <span
              className="font-mono text-[11px] font-bold"
              style={{ color: isActive ? "#fff" : critica ? "var(--signal)" : "var(--c-ink-soft)" }}
            >
              {count}
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}

export function AppHeader({ onMenuClick }: { onMenuClick?: () => void } = {}) {
  const { user, operador, signOut } = useAuth();
  const isGestor = useIsGestor();
  const isAdmin = user?.email?.toLowerCase() === "caio@salexpress.com.br";
  const navigate = useNavigate();
  const now = useClock();
  const counts = useNavCounts();

  const { data: syncStatus } = useQuery({
    queryKey: ["header", "status-ultimo-sync-bastao"],
    enabled: !!supabase,
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const { data } = await supabase!.rpc("status_ultimo_sync_bastao");
      return data as { ultimo_sync_bastao_fmt: string | null; minutos: number | null } | null;
    },
  });
  const syncMin = syncStatus?.minutos ?? null;
  const syncOk = syncMin != null && syncMin <= 40;
  const horaSync = syncStatus?.ultimo_sync_bastao_fmt?.match(/\d{2}:\d{2}/)?.[0]
    ?? `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  const name = operador?.nome ?? user?.email ?? "Operador";
  const handleSignOut = async () => {
    await signOut();
    navigate("/login", { replace: true });
  };

  return (
    <header
      className="relative flex shrink-0 items-center gap-4 border-b px-4 py-[10px] md:px-7"
      style={{ background: "#fff", borderColor: "var(--c-border)" }}
    >
      {/* hamburger (mobile) + brand */}
      <div className="flex shrink-0 items-center gap-2.5">
        <button
          type="button"
          onClick={onMenuClick}
          aria-label="Abrir menu"
          className="grid h-9 w-9 place-items-center rounded-md hover:bg-subtle md:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>
        <img src={logoSal} alt="Sal Express" className="h-6 w-auto" />
        <span className="hidden font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-mute sm:inline">
          Cockpit
        </span>
      </div>

      {/* nav em pílulas (desktop) */}
      <nav className="hidden min-w-0 flex-1 items-center gap-1 overflow-x-auto md:flex">
        <Pilula to="/inbox" rotulo="Inbox" count={counts.inbox} />
        <Pilula to="/conflitos" rotulo="Conflitos" count={counts.conflitos} critica />
        <Pilula to="/extravios" rotulo="Extravios" />
        <Pilula to="/cancelamentos-reentrega" rotulo="Reentregas" count={counts.reentregas} critica />
        {!isGestor && operador != null && <Pilula to="/seu-dashboard" rotulo="Seu Dashboard" />}
        {isGestor && (
          <>
            <Pilula to="/gestao-agentes" rotulo="Gestão Agentes" />
            <Pilula to="/gestao-operadores" rotulo="Gestão Operadores" />
            <Pilula to="/aprendizado" rotulo="Aprendizado" />
          </>
        )}
        {/* Mais ▾ — nada sumiu do produto */}
        <DropdownMenu>
          <DropdownMenuTrigger className="flex items-center gap-1 rounded-[20px] px-[13px] py-[7px] text-[12.5px] font-medium text-ink-soft-2 hover:bg-subtle focus-visible:outline-none">
            Mais
            <ChevronDown className="h-3.5 w-3.5 text-ink-mute" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            <DropdownMenuItem onClick={() => navigate("/auditoria")} className="text-[12.5px]">Auditoria</DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate("/cadastros")} className="text-[12.5px]">Cadastros</DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate("/configuracoes")} className="text-[12.5px]">Configurações</DropdownMenuItem>
            {isAdmin && (
              <DropdownMenuItem onClick={() => navigate("/administracao")} className="text-[12.5px]">Administração</DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </nav>

      <div className="flex-1 md:hidden" />

      {/* direita: SYNC · modo visualização · VENDO · avatar */}
      <div className="flex shrink-0 items-center gap-3">
        <div
          className="hidden items-center gap-1.5 font-mono text-[11px] lg:flex"
          style={{ color: "var(--c-ink-soft)" }}
          title={syncStatus?.ultimo_sync_bastao_fmt ? `Último sync: ${syncStatus.ultimo_sync_bastao_fmt}` : "Sem sync registrado"}
        >
          <span
            className={`inline-block h-[7px] w-[7px] rounded-full ${syncOk ? "animate-pulse-dot" : ""}`}
            style={{ background: syncOk ? "#37B24D" : "var(--warning)" }}
            aria-hidden
          />
          <span className="uppercase tracking-[0.08em]">Sync {horaSync}</span>
        </div>

        {operador?.pode_executar === false && (
          <span
            className="hidden rounded-[20px] border px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest md:inline"
            style={{ color: "var(--warning)", borderColor: "var(--warning)" }}
            title="Seu usuário vê tudo mas não executa ações."
          >
            Visualização
          </span>
        )}

        <FiltroOperadorAdmin />

        <BotaoTema />

        <DropdownMenu>
          <DropdownMenuTrigger
            className="flex items-center gap-2 rounded-full focus-visible:outline-none"
            aria-label={name}
          >
            <span
              className="grid h-7 w-7 place-items-center rounded-full text-[11px] font-bold text-white"
              style={{ background: "var(--c-ink)" }}
            >
              {initials(name)}
            </span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              {name}
              <br />
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

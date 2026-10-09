// =============================================================================
// Header do redesign hifi (handoff design_handoff_cockpit — comum a todas as
// telas): logo + COCKPIT · nav em PÍLULAS · SYNC · "VENDO:" · avatar.
// A pílula ativa é vermelha (#E03131) com sombra; contagens críticas em
// vermelho. Desktop-first (o mobile mantém o drawer com a AppSidebar).
// Nada saiu do produto: as abas que não são pílulas moram no menu "Mais ▾".
// =============================================================================
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { LogOut, Menu, Moon, Sun } from "lucide-react";

import { useAuth, useIsGestor } from "@/contexts/AuthContext";
import { useAreas, useOpSessao } from "@/contexts/OperacaoContext";
import { supabase } from "@/lib/supabase";
import { FiltroOperadorAdmin } from "@/components/layout/FiltroOperadorAdmin";
import { useNavCounts } from "@/components/layout/useNavCounts";
import { initials } from "@/lib/format";
import { alternarTema, lerTema, type Tema } from "@/lib/theme";
import logoSal from "@/assets/sal-express-logo.png";
import { SeletorArea } from "@/components/layout/SeletorArea";
import { NavegacaoHeader } from "@/components/layout/NavegacaoHeader";
import { itensNavegacao } from "@/components/layout/navegacao";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ROTA_INICIO, veHub } from "@/lib/inicio/hub";
import { OPERACAO_DEMO } from "@/lib/operacao/modoDemo";

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

export function AppHeader({ onMenuClick }: { onMenuClick?: () => void } = {}) {
  const { user, operador, signOut } = useAuth();
  const isGestor = useIsGestor();
  const isAdmin = user?.email?.toLowerCase() === "caio@salexpress.com.br";
  // PDI da Isadora (Caio 16/09): aba pessoal — só ela e o Caio veem (RLS reforça no banco)
  const vePdi =
    isAdmin || user?.email?.toLowerCase() === "isadora.baldoni@salexpress.com.br";
  const navigate = useNavigate();
  const now = useClock();
  // ADR 0041 D2 (INV-180): quem é só da Operação não vê nem consulta o Relacionamento.
  const areas = useAreas();
  const { sessao } = useOpSessao();
  const rel = areas.veRelacionamento;
  const counts = useNavCounts(rel);
  // Hub do gestor: logo leva ao /inicio e o seletor de área aparece. Para os outros, nada muda.
  const hub = veHub(areas, OPERACAO_DEMO);

  const { data: syncStatus } = useQuery({
    queryKey: ["header", "status-ultimo-sync-bastao"],
    enabled: rel && !!supabase,
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

  const textoSync =
    syncStatus?.ultimo_sync_bastao_fmt == null
      ? "Sem sincronização registrada"
      : syncOk
        ? `Sincronizado às ${horaSync}`
        : `Última sincronização às ${horaSync}${syncMin != null ? ` (há ${syncMin} min)` : ""}`;
  const nav = itensNavegacao({
    rel,
    isGestor,
    temOperador: operador != null,
    isAdmin,
    vePdi,
    menuOperacao: areas.menuOperacao,
    hub,
  });

  const name = operador?.nome ?? sessao?.membro?.nome ?? user?.email ?? "Operador";
  const handleSignOut = async () => {
    await signOut();
    navigate("/login", { replace: true });
  };

  return (
    <header
      className="relative flex h-14 shrink-0 items-center gap-3 border-b px-4 md:gap-4 md:px-6"
      style={{ background: "var(--bg-elevated)", borderColor: "var(--c-border)" }}
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
        {hub ? (
          <Link
            to={ROTA_INICIO}
            aria-label="Início do Cockpit"
            title="Início (g i)"
            className="flex items-center gap-2.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)] focus-visible:ring-offset-2"
          >
            <img src={logoSal} alt="" className="h-6 w-auto" />
            <span className="hidden text-[13px] font-semibold text-ink-mute xl:inline">
              Cockpit
            </span>
          </Link>
        ) : (
          <>
            <img src={logoSal} alt="Sal Express" className="h-6 w-auto" />
            <span className="hidden text-[13px] font-semibold text-ink-mute xl:inline">
              Cockpit
            </span>
          </>
        )}
        {hub && <SeletorArea veRelacionamento={rel || OPERACAO_DEMO} veOperacao={areas.podeAbrirOperacao} />}
      </div>

      {/* nav (desktop): trabalho à vista, gestão no menu, overflow automático */}
      <NavegacaoHeader nav={nav} contagens={counts} />
      <div className="flex-1 md:hidden" />

      {/* direita: SYNC · modo visualização · VENDO · avatar */}
      <div className="flex shrink-0 items-center gap-1.5">
        {rel && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={textoSync}
                className="hidden h-8 w-8 cursor-default place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)] lg:grid"
              >
                <span
                  className={`inline-block h-2 w-2 rounded-full ${syncOk ? "animate-pulse-dot motion-reduce:animate-none" : ""}`}
                  style={{ background: syncOk ? "var(--positive)" : "var(--warning)" }}
                  aria-hidden
                />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-[12px]">{textoSync}</TooltipContent>
          </Tooltip>
        )}

        {operador?.pode_executar === false && (
          <span
            className="hidden rounded-full border px-2.5 py-0.5 text-[12px] font-medium md:inline"
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
            <DropdownMenuLabel className="font-normal">
              <span className="block text-[13px] font-semibold text-[var(--c-ink)]">{name}</span>
              <span className="block truncate text-[12px] text-muted-foreground">{user?.email ?? "Sem sessão"}</span>
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

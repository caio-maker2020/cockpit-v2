import { useQuery } from "@tanstack/react-query";
import { NavLink } from "react-router-dom";
import {
  Inbox as InboxIcon,
  ScrollText,
  Settings,
  Users,
  RotateCcw,
  BarChart3,
  PackageX,
  ShieldCheck,
  Sparkle,
  AlertTriangle,
  type LucideIcon,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/lib/supabase";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { useFiltroOperadorStore } from "@/stores/useFiltroOperadorStore";
import { initials } from "@/lib/format";
import { cn } from "@/lib/utils";

type NavItem = {
  to: string;
  label: string;
  icon: LucideIcon;
  withCount?: boolean;
  withConflitosCount?: boolean;
  withPrecisaAcao?: boolean;
};

const navOperacao: NavItem[] = [
  { to: "/inbox", label: "Inbox", icon: InboxIcon, withCount: true },
  { to: "/conflitos", label: "Conflitos", icon: AlertTriangle, withConflitosCount: true },
  { to: "/extravios", label: "Extravios", icon: PackageX },
  { to: "/cancelamentos-reentrega", label: "Reentregas", icon: RotateCcw, withPrecisaAcao: true },
];

const navGestao: NavItem[] = [
  { to: "/indicadores", label: "Indicadores", icon: BarChart3 },
  { to: "/auditoria", label: "Auditoria", icon: ScrollText },
  { to: "/cadastros", label: "Cadastros", icon: Users },
  { to: "/configuracoes", label: "Configurações", icon: Settings },
];

export function AppSidebar({
  className,
  onNavigate,
}: {
  /** Sobrepõe classes do <aside> (ex.: esconder no mobile, ou preencher o drawer). */
  className?: string;
  /** Chamado ao clicar num link — o drawer mobile usa pra se fechar. */
  onNavigate?: () => void;
} = {}) {
  const { operador, user } = useAuth();
  const isAdmin = user?.email?.toLowerCase() === "caio@salexpress.com.br";
  const filtroOperadorId = useFiltroOperadorStore((s) => s.operadorId);
  const opIdParaContar = filtroOperadorId ?? operador?.id ?? null;

  const { data: actionCount } = useQuery({
    queryKey: ["sidebar", "action-count", opIdParaContar ?? "none"],
    enabled: !!supabase && !!opIdParaContar,
    queryFn: async () => {
      const { count } = await supabase!
        .from("cards")
        .select("id", { count: "exact", head: true })
        .in("state", ["AGUARDANDO_VALIDACAO_HUMANA", "BLOQUEADO_POR_ERRO", "ESCALADO_HUMANO"])
        .eq("assigned_operator_id", opIdParaContar!);
      return count ?? 0;
    },
  });

  const { data: precisaAcaoCount } = useQuery({
    queryKey: ["cancelamentos-reentrega-count"],
    enabled: !!supabase,
    refetchInterval: 60_000,
    staleTime: 30_000,
    queryFn: async () => {
      const { count } = await supabase!
        .from("v_cancelamentos_reentrega")
        .select("id", { count: "exact", head: true })
        .eq("status", "precisa_acao");
      return count ?? 0;
    },
  });

  // MESMA fonte/queryKey que a lista da aba Conflitos (v_cards_requer_atencao).
  const { data: conflitosList } = useQuery({
    queryKey: ["conflitos"],
    enabled: !!supabase,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase!
        .from("v_cards_requer_atencao")
        .select("*")
        .order("detectada_em", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
  const conflitosCount = conflitosList?.length ?? 0;

  useRealtimeInvalidate("cards", ["sidebar", "action-count"]);
  useRealtimeInvalidate("cards", ["conflitos"]);

  const countFor = (item: NavItem): number | null => {
    if (item.withCount) return actionCount ?? 0;
    if (item.withConflitosCount) return conflitosCount;
    if (item.withPrecisaAcao) return precisaAcaoCount ?? 0;
    return null;
  };

  const renderItem = (item: NavItem) => {
    const count = countFor(item);
    const Icon = item.icon;
    const urgent = !!item.withConflitosCount || !!item.withPrecisaAcao;
    return (
      <NavLink
        key={item.to}
        to={item.to}
        end={item.to === "/inbox"}
        onClick={onNavigate}
        className={({ isActive }) =>
          cn(
            "group relative flex items-center gap-2.5 rounded-md py-2 pl-3 pr-2 text-[13px] transition-colors",
            isActive
              ? "bg-surface font-semibold text-ink shadow-hairline"
              : "font-medium text-ink-soft hover:bg-black/[0.04] hover:text-ink",
          )
        }
      >
        {({ isActive }) => (
          <>
            {isActive && (
              <span
                aria-hidden
                className="absolute -left-2.5 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r bg-sal"
              />
            )}
            <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={isActive ? 2.25 : 1.75} />
            <span className="flex-1 truncate">{item.label}</span>
            {count != null && count > 0 && (
              <span
                className={cn(
                  "tabular inline-flex min-w-[20px] items-center justify-center rounded-full px-1.5 py-0.5 font-mono text-[10px] font-semibold",
                  urgent ? "bg-sal text-paper" : "bg-surface-alt text-ink-soft",
                )}
              >
                {count}
              </span>
            )}
          </>
        )}
      </NavLink>
    );
  };

  const nome = operador?.nome ?? user?.email ?? "Operador";
  const papelLabel = isAdmin ? "Admin · Sal Express" : operador?.papel === "gestor" ? "Gestor" : "Operador";

  return (
    <aside
      className={cn("flex h-full w-60 shrink-0 flex-col border-r", className)}
      style={{ background: "hsl(var(--sidebar-background))", borderColor: "var(--c-border)" }}
    >
      {/* Marca */}
      <div className="flex items-center gap-2.5 px-4 pb-3 pt-4">
        <span className="grid h-7 w-7 place-items-center rounded-[6px] bg-sal text-[15px] font-bold leading-none text-paper shadow-[inset_0_-1px_0_rgba(0,0,0,0.18)]">
          S
        </span>
        <div className="leading-tight">
          <div className="text-[15px] font-bold tracking-tight text-ink">Cockpit</div>
          <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-ink-mute">SAL · Logistics OS</div>
        </div>
      </div>

      {/* Status do sistema */}
      <div className="mx-3 mb-2 flex items-center gap-2 rounded-md border border-rule bg-surface px-3 py-2">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-60 animate-pulse-soft" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
        </span>
        <span className="text-[12px] font-semibold text-ink">Sistema ativo</span>
      </div>

      {/* Navegação */}
      <nav className="flex-1 overflow-y-auto px-3 py-1">
        <div className="mb-1 mt-2 px-3 font-mono text-[10px] uppercase tracking-[0.13em] text-ink-mute">Operação</div>
        <div className="space-y-0.5">{navOperacao.map(renderItem)}</div>

        <div className="mb-1 mt-4 px-3 font-mono text-[10px] uppercase tracking-[0.13em] text-ink-mute">Gestão</div>
        <div className="space-y-0.5">
          {navGestao.map(renderItem)}
          {(isAdmin ||
            user?.email?.toLowerCase() === "isadora.baldoni@salexpress.com.br") &&
            renderItem({ to: "/aprendizado", label: "Aprendizado", icon: Sparkle })}
          {isAdmin && renderItem({ to: "/administracao", label: "Administração", icon: ShieldCheck })}
        </div>
      </nav>

      {/* Usuário */}
      <div className="flex items-center gap-2.5 border-t px-4 py-3" style={{ borderColor: "var(--c-border)" }}>
        <span className="grid h-8 w-8 place-items-center rounded-full bg-ink font-mono text-[11px] font-bold text-paper">
          {initials(nome)}
        </span>
        <div className="min-w-0 leading-tight">
          <div className="truncate text-[12.5px] font-semibold text-ink">{nome.split(" ")[0]}</div>
          <div className="truncate text-[10.5px] text-ink-mute">{papelLabel}</div>
        </div>
      </div>
    </aside>
  );
}

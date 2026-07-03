import { useQuery } from "@tanstack/react-query";
import { NavLink } from "react-router-dom";
import { Inbox as InboxIcon, ScrollText, Settings, Users, RotateCcw, BarChart3, PackageX, ShieldCheck, AlertTriangle } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/lib/supabase";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { useFiltroOperadorStore } from "@/stores/useFiltroOperadorStore";
import { cn } from "@/lib/utils";

const navItems = [
  { to: "/inbox", label: "Tratativas de Relacionamento", icon: InboxIcon, withCount: true },
  { to: "/conflitos", label: "⚠️ Conflitos", icon: AlertTriangle, withConflitosCount: true },
  { to: "/extravios", label: "Extravios", icon: PackageX },
  { to: "/auditoria", label: "Auditoria", icon: ScrollText },
  { to: "/cancelamentos-reentrega", label: "Canc. Reentrega", icon: RotateCcw, withPrecisaAcao: true },
  { to: "/indicadores", label: "Indicadores", icon: BarChart3 },
  { to: "/cadastros", label: "Cadastros", icon: Users },
  { to: "/configuracoes", label: "Configurações", icon: Settings },
];

export function AppSidebar() {
  const { operador, user } = useAuth();
  const isAdmin = user?.email?.toLowerCase() === "caio@salexpress.com.br";
  const items = isAdmin
    ? [...navItems, { to: "/administracao", label: "Administração", icon: ShieldCheck }]
    : navItems;
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
    // Polling baixo (1min) — sem realtime nessa view; staleTime evita refetch redundante.
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
  // Sem head:true — usamos length do array, igual à lista, pra nunca driftar.
  // Invalidações disparadas por ModalForcarAtualizacao em ["conflitos"] decrementam aqui na hora.
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


  return (
    <aside
      className="flex h-full w-56 shrink-0 flex-col"
      style={{
        background: "var(--bg)",
        borderRight: "1px solid var(--c-border)",
      }}
    >
      <nav className="flex-1 overflow-y-auto p-3">
        <div
          className="mb-3 px-3 font-body text-label uppercase"
          style={{ color: "var(--c-ink-mute)" }}
        >
          Navegação
        </div>
        <ul className="space-y-0.5">
          {items.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                end={item.to === "/inbox"}
                className={({ isActive }) =>
                  cn(
                    "group relative flex items-center gap-2.5 rounded-md px-3 py-2 font-body text-body transition-colors",
                    isActive
                      ? "font-medium"
                      : "hover:bg-bg-subtle",
                  )
                }
                style={({ isActive }) =>
                  isActive
                    ? { background: "var(--bg-subtle)", color: "var(--c-ink)" }
                    : { color: "var(--c-ink-soft)" }
                }
              >
                {({ isActive }) => (
                  <>
                    {/* Active dot marker */}
                    <span
                      className="inline-block h-1.5 w-1.5 rounded-full transition-opacity"
                      style={{
                        background: "var(--signal)",
                        opacity: isActive ? 1 : 0,
                      }}
                      aria-hidden
                    />
                    <item.icon className="h-3.5 w-3.5" strokeWidth={isActive ? 2.25 : 1.75} />
                    <span className="flex-1">{item.label}</span>
                    {item.withCount && actionCount && actionCount > 0 ? (
                      <span
                        className="tabular inline-flex min-w-[20px] items-center justify-center rounded-full px-1.5 py-0.5 font-mono text-[10px] font-medium"
                        style={{
                          background: "var(--signal)",
                          color: "var(--bg)",
                        }}
                      >
                        {actionCount}
                      </span>
                    ) : null}
                    {item.withPrecisaAcao && precisaAcaoCount && precisaAcaoCount > 0 ? (
                      <span
                        className="tabular inline-flex min-w-[20px] items-center justify-center rounded-full px-1.5 py-0.5 font-mono text-[10px] font-medium animate-pulse-soft"
                        style={{
                          background: "var(--warning)",
                          color: "var(--bg)",
                        }}
                        title={`${precisaAcaoCount} cancelamento(s) precisam ação`}
                      >
                        {precisaAcaoCount}
                      </span>
                    ) : null}
                    {item.withConflitosCount && conflitosCount && conflitosCount > 0 ? (
                      <span
                        className="tabular inline-flex min-w-[20px] items-center justify-center rounded-full px-1.5 py-0.5 font-mono text-[10px] font-medium animate-pulse-soft"
                        style={{
                          background: "var(--danger, #dc2626)",
                          color: "#fff",
                        }}
                        title={`${conflitosCount} conflito(s) aguardando decisão`}
                      >
                        {conflitosCount}
                      </span>
                    ) : null}
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <div
        className="p-4"
        style={{ borderTop: "1px solid var(--c-border)" }}
      >
        <div
          className="font-body text-label uppercase"
          style={{ color: "var(--c-ink-mute)", letterSpacing: "0.08em" }}
        >
          v2026.05 · OS
        </div>
        <div
          className="mt-0.5 font-mono"
          style={{ fontSize: "10px", color: "var(--c-ink-mute)", letterSpacing: "0.2em" }}
        >
          SAL·EXPRESS · LOGISTICS OS
        </div>
      </div>
    </aside>
  );
}

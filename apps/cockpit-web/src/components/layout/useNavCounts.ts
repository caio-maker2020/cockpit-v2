// Contagens da navegação (pílulas do header + drawer mobile) — extraídas do
// AppSidebar no redesign hifi (handoff 2a) pra serem fonte única dos dois.
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { useFiltroOperadorStore } from "@/stores/useFiltroOperadorStore";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";

/**
 * `ativo=false` (pessoa que não vê o Relacionamento — membro só da Operação,
 * ADR 0041 D2) não dispara nenhuma leitura nem canal de tabela do Relacionamento.
 */
export function useNavCounts(ativo = true) {
  const { operador } = useAuth();
  const filtroOperadorId = useFiltroOperadorStore((s) => s.operadorId);
  const opIdParaContar = filtroOperadorId ?? operador?.id ?? null;

  const { data: actionCount } = useQuery({
    queryKey: ["sidebar", "action-count", opIdParaContar ?? "none"],
    enabled: ativo && !!supabase && !!opIdParaContar,
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
    enabled: ativo && !!supabase,
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

  // MESMA fonte/queryKey que a lista da aba Conflitos.
  const { data: conflitosList } = useQuery({
    queryKey: ["conflitos"],
    enabled: ativo && !!supabase,
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

  useRealtimeInvalidate("cards", ["sidebar", "action-count"], undefined, ativo);
  useRealtimeInvalidate("cards", ["conflitos"], undefined, ativo);

  return {
    inbox: actionCount ?? 0,
    conflitos: conflitosList?.length ?? 0,
    reentregas: precisaAcaoCount ?? 0,
  };
}

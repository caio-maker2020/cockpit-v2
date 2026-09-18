import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { CardRow } from "@/lib/types";
import {
  cnpjPagadorDoCard,
  montarUrlNumerosCliente,
  termoBuscaCliente,
} from "@/lib/dashboard-clientes";
import { avisarDashboardAberto } from "@/lib/abrir-dashboard-clientes";

/**
 * "Ver números do cliente" no header do card: abre o dashboard externo já
 * apontando pro cliente deste card (q = nome, cnpj = pagador).
 *
 * Nome completo vem de `clientes` pelo CNPJ pagador (mesmo cadastro que o
 * dashboard usa). RLS por carteira pode esconder o cliente do operador —
 * aí cai pro nome do card sem a abreviação SSW. Nunca bloqueia o clique.
 */
export function BotaoVerNumerosCliente({ card }: { card: CardRow }) {
  const cnpj = cnpjPagadorDoCard(card.agent_state);
  const nomeCard = card.empresa_cliente || card.pagador || card.nome_cliente;

  const { data: nomeCompleto } = useQuery({
    queryKey: ["cliente-nome-por-cnpj", cnpj],
    enabled: !!supabase && !!cnpj,
    staleTime: 60 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase!
        .from("clientes")
        .select("nome")
        .eq("cnpj_cpf", cnpj!)
        .maybeSingle();
      if (error) return null;
      return (data as { nome?: string | null } | null)?.nome ?? null;
    },
  });

  const entrada = { nomeCompleto, nomeCard, cnpj };
  const url = montarUrlNumerosCliente(entrada);
  const termo = termoBuscaCliente(entrada);

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={() => avisarDashboardAberto(termo || undefined)}
      data-testid="botao-ver-numeros-cliente"
      title={
        termo
          ? `Abre o dashboard de performance já no cliente "${termo}" (nova aba)`
          : "Abre o dashboard de performance por cliente (nova aba)"
      }
      className="inline-flex items-center gap-1 border border-rule-strong bg-sal px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-widest text-paper hover:bg-sal-deep"
    >
      Ver números do cliente
      <ExternalLink className="h-3 w-3" />
    </a>
  );
}

import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, Loader2, Search, X } from "lucide-react";

import { supabase } from "@/lib/supabase";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { useFiltroOperadorStore } from "@/stores/useFiltroOperadorStore";
import { Input } from "@/components/ui/input";
import { KanbanCard } from "@/components/cards/KanbanCard";
import type { CardWithRelations } from "@/lib/types";

const SELECT_WITH_RELATIONS = `
  id,nf,ctrc,canal_origem,empresa_cliente,nome_cliente,pagador,base_destino,
  responsavel_relacionamento,remetente_inicial,state,agent_state,tipo,risco,
  assigned_agent,assigned_operator_id,last_event_at,created_at,updated_at,
  cod_ultima_ocorrencia,aprovacao_modo,lock_aguardando_validacao,
  operador:operadores!cards_assigned_operator_id_fkey(nome,papel),
  ocorrencia:ocorrencias_dicionario!cards_cod_ultima_ocorrencia_fkey(descricao,responsabilidade)
`;

export default function Resolvidos() {
  const [search, setSearch] = useState("");
  const filtroOperadorId = useFiltroOperadorStore((s) => s.operadorId);

  const { data, isLoading, isFetching, isError, error, refetch } = useQuery({
    queryKey: ["resolvidos", search, filtroOperadorId],
    enabled: !!supabase,
    queryFn: async () => {
      let q = supabase!
        .from("cards")
        .select(SELECT_WITH_RELATIONS)
        .eq("state", "RESOLVIDO");

      if (filtroOperadorId) {
        q = q.eq("assigned_operator_id", filtroOperadorId);
      }
      if (search.trim()) {
        const term = search.trim().replace(/%/g, "");
        q = q.or(
          `nf.ilike.%${term}%,ctrc.ilike.%${term}%,empresa_cliente.ilike.%${term}%,nome_cliente.ilike.%${term}%`,
        );
      }
      q = q.order("last_event_at", { ascending: false, nullsFirst: false }).limit(200);

      const { data: rows, error } = await q;
      if (error) throw error;
      return (rows ?? []) as unknown as CardWithRelations[];
    },
  });

  useRealtimeInvalidate("cards", ["resolvidos"]);

  const total = data?.length ?? 0;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border bg-surface px-5 py-3">
        <div>
          <Link
            to="/inbox"
            className="mb-1 inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            Voltar para Inbox
          </Link>
          <h1 className="text-[16px] font-semibold tracking-tight">Resolvidos</h1>
          <p className="text-[12px] text-muted-foreground">
            Cards encerrados — fora do quadro operacional.
          </p>
        </div>
        <div className="text-[12px] text-muted-foreground">
          {isLoading ? "Carregando…" : `${total} ${total === 1 ? "card" : "cards"}`}
          {isFetching && <Loader2 className="ml-2 inline h-3 w-3 animate-spin" />}
        </div>
      </header>

      <div className="border-b border-border bg-surface-alt px-5 py-2">
        <div className="relative w-72">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar NF, CTRC, cliente…"
            className="h-8 pl-7 text-[12px]"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-background p-4">
        {isLoading ? (
          <div className="text-[13px] text-muted-foreground">Carregando…</div>
        ) : isError ? (
          // Erro NÃO pode parecer "nenhum card". Estado explícito + retry.
          <div className="flex flex-col items-start gap-2 rounded-md border border-danger/40 bg-danger/5 p-4 text-[13px]">
            <span className="font-semibold text-danger">Erro ao carregar os resolvidos.</span>
            <span className="text-muted-foreground">
              {(error as Error)?.message ?? "Falha na consulta."} Isto é um erro de carga, não quer dizer que não há cards.
            </span>
            <button
              onClick={() => refetch()}
              className="mt-1 rounded border border-danger/40 px-2 py-1 font-mono text-[11px] uppercase tracking-wider text-danger hover:bg-danger/10"
            >
              Tentar novamente
            </button>
          </div>
        ) : total === 0 ? (
          <div className="text-[13px] text-muted-foreground">Nenhum card resolvido.</div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {data!.map((c) => (
              <KanbanCard key={c.id} card={c} pendentes={0} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

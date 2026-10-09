import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { TelaRelacionamento } from "@/components/relacionamento/TelaRelacionamento";
import { CHAVE_ORDEM_CARDS, agruparInbox } from "@/lib/relacionamento/torre";
import { relogioDe } from "@/lib/esperaNaFila";
import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/lib/supabase";
import { sanitizeSearch } from "@/lib/search";
import { useAuth } from "@/contexts/AuthContext";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { usePersistentState } from "@/hooks/usePersistentState";
import { useFiltroOperadorStore } from "@/stores/useFiltroOperadorStore";
import { ALL_TIPOS, type CardRisco, type CardRow, type CardTipo, type CardWithRelations } from "@/lib/types";
import { primeiroNome, saudacao } from "@/lib/format";
import { BotaoVisaoGeralClientes } from "@/components/cockpit/BotaoVisaoGeralClientes";
import { indexarFilaAgora, type LinhaFilaParaCard } from "@/lib/esperaNaFila";
import { KanbanCard } from "@/components/cards/KanbanCard";

type AssignFilter = "meus" | "todos" | "sem_dono";

interface EnrichedCard extends CardWithRelations {
  pendentes_count: number;
  possivel_resposta_outra_thread?: boolean;
}

const SELECT_WITH_RELATIONS = `
  id,nf,ctrc,tipo_cte,canal_origem,empresa_cliente,nome_cliente,pagador,base_destino,
  responsavel_relacionamento,remetente_inicial,state,agent_state,tipo,risco,
  assigned_agent,assigned_operator_id,last_event_at,created_at,updated_at,
  cod_ultima_ocorrencia,aprovacao_modo,lock_aguardando_validacao,
  aviso_alteracao_oc,acao_falhou_motivo,sem_chave_cte,acao_executada_em,
  ia_sugestao_oc_resposta,cliente_respondeu_em,bastao_data_ultima_ocorrencia,
  operador:operadores!cards_assigned_operator_id_fkey(nome,papel),
  ocorrencia:ocorrencias_dicionario!cards_cod_ultima_ocorrencia_fkey(descricao,responsabilidade)
`;

/**
 * Espelho do trilho autônomo (cards.acao_autonoma, mig 353) buscado em query
 * SEPARADA e resiliente: antes da mig aplicada (preview) a coluna não existe —
 * o erro é engolido e o Inbox segue EXATAMENTE como hoje (risco 1 do plano).
 *
 * BUG 26/08 (Caio: "contagem só aparece abrindo o card"): a versão anterior
 * mandava `.in()` com até 1000 uuids do board — URL ~39KB estourava o limite
 * do request e falhava CALADA → mapa vazio → sem chip e sem trilho no board
 * (o banner do detalhe busca individual, por isso funcionava). Raiz: inverter
 * a query — só os cards COM espelho vivo existem em dúzias; busca-se por
 * `acao_autonoma is not null` (RLS filtra a visibilidade) e cruza com os ids
 * do board no cliente. URL constante, imune ao tamanho do Inbox.
 */
async function buscarEspelhosAcaoAutonoma(
  ids: string[],
): Promise<Map<string, NonNullable<CardRow["acao_autonoma"]>>> {
  const m = new Map<string, NonNullable<CardRow["acao_autonoma"]>>();
  if (!supabase || ids.length === 0) return m;
  try {
    const { data, error } = await supabase
      .from("cards")
      .select("id, acao_autonoma")
      .not("acao_autonoma", "is", null)
      .in("acao_autonoma->>status", ["pendente", "executando", "processado"])
      .limit(500);
    if (error) return m;
    const doBoard = new Set(ids);
    for (const r of (data ?? []) as Array<{ id: string; acao_autonoma: NonNullable<CardRow["acao_autonoma"]> }>) {
      if (r.acao_autonoma && doBoard.has(r.id)) m.set(r.id, r.acao_autonoma);
    }
  } catch {
    /* coluna ainda não existe — trilho autônomo invisível, nada quebra */
  }
  return m;
}


// Teto de cards ativos buscados de uma vez. 1000 = max_rows do PostgREST
// (supabase/config.toml). Antes era 500, que cortava em silêncio: a ordenação
// põe os de atividade mais antiga (os esquecidos) por último, então eram
// justamente eles que sumiam. O teto continua existindo, mas agora, quando é
// atingido, a tela AVISA (ver bannerTruncado abaixo). Nunca esconder card sem dizer.
const INBOX_LIMIT = 1000;
type FiltroTratativa = "todas" | "notificacao" | "desenvolver";
type FiltroTipoCte = "todos" | "NORMAL" | "DEVOLUCAO" | "REVERSA";

export default function Inbox() {
  const { operador } = useAuth();

  // Relógio do trilho autônomo (26/08): re-render a cada 30s pros chips de
  // countdown andarem na tela sem depender de refetch/realtime.
  const [, setTickRelogio] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTickRelogio((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const isGestor = operador?.papel === "gestor";
  const filtroOperadorId = useFiltroOperadorStore((s) => s.operadorId);

  const [tipoFilter, setTipoFilter] = usePersistentState<CardTipo[]>(
    "inbox.filter.tipos",
    ALL_TIPOS,
  );
  const [riscoFilter, setRiscoFilter] = usePersistentState<CardRisco | "todos">(
    "inbox.filter.risco",
    "todos",
  );
  const [assign, setAssign] = usePersistentState<AssignFilter>(
    "inbox.filter.assign",
    "meus",
  );
  const [search, setSearch] = useState("");
  // Handoff 2a: filtro de CLIENTE é obrigatório na barra da fila.
  const [clienteFilter, setClienteFilter] = useState<string>("");
  // EXCLUÍDO (Caio 21/08): "Só sua ação" saiu da UI — valor fixo neutro
  // (persistente antigo no localStorage NÃO pode reativar sozinho).
  const onlyAction = false;
  // EXCLUÍDO (Caio 21/08): filtro de tratativa saiu da UI — sempre "todas".
  const filtroTratativa: FiltroTratativa = "todas";
  const [filtroTipoCte, setFiltroTipoCte] = usePersistentState<FiltroTipoCte>(
    "inbox.filter.tipoCte",
    "todos",
  );
  const [filtroOcs, setFiltroOcs] = usePersistentState<number[]>(
    "inbox.filter.ocs",
    [],
  );

  

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: [
      "inbox",
      "cards",
      { tipoFilter, riscoFilter, assign, search, filtroTipoCte, filtroOcs, op: operador?.id ?? null, filtroOperadorId },
    ],
    enabled: !!supabase && (assign !== "meus" || !!operador),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      if (!supabase) return [] as EnrichedCard[];

      let q = supabase.from("cards").select(SELECT_WITH_RELATIONS);
      q = q.not("state", "in", "(CANCELADO,RESOLVIDO,TRANSFERIDO,EXTRAVIO_MONITORADO)");

      if (tipoFilter.length > 0 && tipoFilter.length < ALL_TIPOS.length) {
        q = q.in("tipo", tipoFilter);
      }
      if (riscoFilter !== "todos") {
        q = q.eq("risco", riscoFilter);
      }
      if (filtroOperadorId) {
        // Filtro global de gestor sobrescreve o seletor "Meus/Sem dono/Todos"
        q = q.eq("assigned_operator_id", filtroOperadorId);
      } else if (assign === "meus") {
        if (!operador) return [];
        q = q.eq("assigned_operator_id", operador.id);
      } else if (assign === "sem_dono") {
        q = q.is("assigned_operator_id", null);
      }

      if (search.trim()) {
        const term = sanitizeSearch(search);
        q = q.or(
          `nf.ilike.%${term}%,ctrc.ilike.%${term}%,empresa_cliente.ilike.%${term}%,nome_cliente.ilike.%${term}%`,
        );
      }
      if (filtroTipoCte !== "todos") {
        q = q.eq("tipo_cte", filtroTipoCte);
      }
      if (filtroOcs.length > 0) {
        q = q.in("cod_ultima_ocorrencia", filtroOcs);
      }
      q = q
        .order("cliente_respondeu_em", { ascending: false, nullsFirst: false })
        .order("last_event_at", { ascending: false, nullsFirst: false })
        .limit(INBOX_LIMIT);

      const { data: rows, error } = await q;
      if (error) throw error;
      const cards = (rows ?? []) as unknown as CardWithRelations[];

      const ids = cards.map((c) => c.id);
      const pendingMap = new Map<string, number>();
      if (ids.length) {
        const { data: todos } = await supabase
          .from("todos")
          .select("card_id,status")
          .in("card_id", ids)
          .eq("status", "pendente");
        (todos ?? []).forEach((t: any) => {
          pendingMap.set(t.card_id, (pendingMap.get(t.card_id) ?? 0) + 1);
        });
      }

      // Trilho autônomo (plano 25/08): espelho buscado à parte, resiliente.
      const espelhos = await buscarEspelhosAcaoAutonoma(ids);

      return cards.map<EnrichedCard>((c) => ({
        ...c,
        pendentes_count: pendingMap.get(c.id) ?? 0,
        acao_autonoma: espelhos.get(c.id) ?? null,
      }));
    },
  });

  useRealtimeInvalidate("cards", ["inbox", "cards"]);
  useRealtimeInvalidate("todos", ["inbox", "cards"]);

  // Cards com sugestão de "resposta em outra thread" (contexto=card_em_espera).
  // Esses são puxados pra coluna CLIENTE RESPONDEU com badge "📨 possível resposta".
  const { data: cardsRespostaOutraThread } = useQuery({
    queryKey: ["inbox", "email-preexistente-card-em-espera"],
    enabled: !!supabase,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase!
        .from("v_email_preexistente")
        .select("card_id")
        .eq("contexto", "card_em_espera");
      if (error) throw error;
      return new Set<string>((data ?? []).map((r: any) => r.card_id as string));
    },
  });

  // Espera REAL do operador por card (v_operador_fila_agora, mig 344) — a mesma
  // fonte que a tela de Gestão usa em "Parados há mais de 1 dia útil".
  //
  // Carlos 10/09: o rodapé do card mostrava `last_event_at`, que o trigger
  // `project_card_event` reescreve a CADA card_event — inclusive o
  // `HistoricoSswPuxado` (13,5% dos eventos em 30d, refresh interno de cache).
  // A NF 350796 estava parada desde 26/08 (109 h úteis, o pior caso do sistema)
  // e o card anunciava "há 17h". Query própria e resiliente: `select("*")` como
  // em GestaoOperadores; erro/vazio → mapa vazio → rodapé idêntico ao de antes.
  const { data: filaAgora } = useQuery({
    queryKey: ["inbox", "espera-na-fila"],
    enabled: !!supabase,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase!.from("v_operador_fila_agora").select("*").limit(2000);
      if (error) throw error;
      return (data ?? []) as LinhaFilaParaCard[];
    },
  });
  const filaIndex = useMemo(() => indexarFilaAgora(filaAgora), [filaAgora]);

  // Dicionário oc → descrição
  const { data: ocLabels } = useQuery({
    queryKey: ["oc-labels"],
    enabled: !!supabase,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data } = await supabase!
        .from("ocorrencias_dicionario")
        .select("codigo,descricao");
      const map: Record<number, string> = {};
      (data ?? []).forEach((r: any) => {
        if (r?.codigo != null) map[r.codigo as number] = r.descricao ?? "";
      });
      return map;
    },
  });

  // Ocorrências disponíveis (aplica os outros filtros, mas NÃO filtroOcs)
  const { data: ocsDisponiveis } = useQuery({
    queryKey: [
      "inbox-ocs-disponiveis",
      { tipoFilter, riscoFilter, assign, search, filtroTipoCte, op: operador?.id ?? null, filtroOperadorId },
    ],
    enabled: !!supabase && (assign !== "meus" || !!operador),
    staleTime: 30_000,
    queryFn: async () => {
      if (!supabase) return [] as number[];
      let q: any = supabase
        .from("cards")
        .select("cod_ultima_ocorrencia")
        .not("state", "in", "(CANCELADO,RESOLVIDO,TRANSFERIDO,EXTRAVIO_MONITORADO)")
        .not("cod_ultima_ocorrencia", "is", null);
      if (tipoFilter.length > 0 && tipoFilter.length < ALL_TIPOS.length) q = q.in("tipo", tipoFilter);
      if (riscoFilter !== "todos") q = q.eq("risco", riscoFilter);
      if (filtroOperadorId) {
        q = q.eq("assigned_operator_id", filtroOperadorId);
      } else if (assign === "meus") {
        if (!operador) return [];
        q = q.eq("assigned_operator_id", operador.id);
      } else if (assign === "sem_dono") {
        q = q.is("assigned_operator_id", null);
      }
      if (search.trim()) {
        const term = sanitizeSearch(search);
        q = q.or(`nf.ilike.%${term}%,ctrc.ilike.%${term}%,empresa_cliente.ilike.%${term}%,nome_cliente.ilike.%${term}%`);
      }
      if (filtroTipoCte !== "todos") q = q.eq("tipo_cte", filtroTipoCte);
      q = q.limit(2000);
      const { data: rows } = await q;
      const set = new Set<number>();
      (rows ?? []).forEach((r: any) => {
        if (r?.cod_ultima_ocorrencia != null) set.add(r.cod_ultima_ocorrencia as number);
      });
      return Array.from(set).sort((a, b) => a - b);
    },
  });

  const labelOc = (codigo: number) => ocLabels?.[codigo] ?? "";

  // Handoff 2a: filtro de cliente aplicado sobre a lista já buscada.
  const dataFiltrada = useMemo(
    () => (clienteFilter ? (data ?? []).filter((c) => c.empresa_cliente === clienteFilter) : data ?? []),
    [data, clienteFilter],
  );
  const clientesDisponiveis = useMemo(() => {
    const set = new Set<string>();
    for (const c of data ?? []) if (c.empresa_cliente) set.add(c.empresa_cliente);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [data]);

  // Agrupamento: MESMA regra e ordenação de antes, agora em lib/relacionamento/torre.ts (testado).
  const grouped = useMemo(() => agruparInbox(dataFiltrada ?? [], cardsRespostaOutraThread), [dataFiltrada, cardsRespostaOutraThread]);

  // KPIs read-only (não altera comportamento/queries do board).
  const { data: resolvidosHoje } = useQuery({
    queryKey: ["inbox", "resolvidos-hoje"],
    enabled: !!supabase,
    staleTime: 60_000,
    queryFn: async () => {
      const agora = new Date();
      const inicioDia = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate()).toISOString();
      const { count } = await supabase!
        .from("cards")
        .select("id", { count: "exact", head: true })
        .in("state", ["RESOLVIDO", "CANCELADO", "TRANSFERIDO"])
        .gte("updated_at", inicioDia);
      return count ?? 0;
    },
  });
  const statAtivos = dataFiltrada?.length ?? 0;
  const statAguardandoSsw = grouped.get("acao_executada")?.length ?? 0;
  const statSlaRisco = (dataFiltrada ?? []).filter((c) => c.risco === "alto").length;

  const totalParaFazer =
    (grouped.get("validacao")?.length ?? 0) + (grouped.get("cliente_respondeu")?.length ?? 0);
  const vetoCardsTotal = (grouped.get("veto_janela")?.length ?? 0) + (grouped.get("veto_executada")?.length ?? 0);

  // PILOTO (Caio 26/08): o bloco do trilho só aparece pra quem está no piloto
  // (FELIPE/ISABELY/LARISSA) ou gestor — os demais veem o cockpit de hoje,
  // sem bloco vazio. Busca resiliente (tabela pode não existir pré-mig 357).
  const { data: estaNoPiloto } = useQuery({
    queryKey: ["veto-piloto-operador", operador?.id ?? null],
    enabled: !!supabase && !!operador,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      try {
        const { data, error } = await supabase!
          .from("acoes_autonomas_veto_operadores")
          .select("ativo")
          .eq("operador_id", operador!.id)
          .maybeSingle();
        if (error) return false;
        return (data as { ativo?: boolean } | null)?.ativo === true;
      } catch {
        return false;
      }
    },
  });
  // fallback de segurança: se por qualquer motivo um card do trilho existir
  // na visão atual, o bloco aparece — card com contagem NUNCA fica invisível.
  const mostrarTrilho = isGestor || estaNoPiloto === true || vetoCardsTotal > 0;

  const navigate = useNavigate();
  const abrirCard = (id: string, ordem: string[]) => {
    // A ordem do fluxo vai junto: no card aberto, j/k e "próximo card" seguem a mesma fila.
    try {
      window.sessionStorage.setItem(CHAVE_ORDEM_CARDS, JSON.stringify(ordem));
    } catch {
      /* sem sessionStorage: o card abre do mesmo jeito, só sem "próximo" */
    }
    navigate(`/cards/${id}`);
  };
  const ordemAtual = useRef<string[]>([]);

  return (
    <TelaRelacionamento
      dados={{
        cards: dataFiltrada,
        grupos: grouped,
        mostrarTrilho,
        isLoading,
        isError,
        isFetching,
        refetch: () => void refetch(),
        truncado: (data?.length ?? 0) >= INBOX_LIMIT,
        limite: INBOX_LIMIT,
        stats: { ativos: statAtivos, resolvidosHoje: resolvidosHoje ?? 0, aguardandoSsw: statAguardandoSsw, slaRisco: statSlaRisco },
        saudacao: `${saudacao()}, ${primeiroNome(operador?.nome)}. ${
          totalParaFazer === 0 ? "Tudo em dia." : `${totalParaFazer} ${totalParaFazer === 1 ? "card aguarda" : "cards aguardam"} sua ação.`
        }`,
        paradoMais1dUtil: (c) => relogioDe(c, filaIndex.get(c.id) ?? null).paradoMais1dUtil,
      }}
      filtros={{ busca: search, cliente: clienteFilter, ocs: filtroOcs, risco: riscoFilter, tipos: tipoFilter, tipoCte: filtroTipoCte, dono: assign }}
      setters={{
        setBusca: setSearch,
        setCliente: setClienteFilter,
        setOcs: setFiltroOcs,
        setRisco: setRiscoFilter,
        setTipos: setTipoFilter,
        setTipoCte: setFiltroTipoCte,
        setDono: setAssign,
      }}
      clientes={clientesDisponiveis}
      ocsDisponiveis={ocsDisponiveis ?? []}
      labelOc={labelOc}
      isGestor={isGestor}
      extrasMenu={
        <div className="px-1 py-1">
          {/* Link externo: análise detalhada de performance por cliente (Caio 18/09) — nada saiu do produto. */}
          <BotaoVisaoGeralClientes />
        </div>
      }
      // Conselheiro no cartão = os sinais que o card já mostra (teto de 2, des-poluição do Caio 26/08).
      renderCard={(c) => (
        <KanbanCard
          card={c}
          pendentes={c.pendentes_count}
          espera={filaIndex.get(c.id) ?? null}
          onAbrir={(id) => abrirCard(id, ordemAtual.current.length ? ordemAtual.current : [id])}
        />
      )}
      onAbrirCard={abrirCard}
      onOrdem={(o) => (ordemAtual.current = o)}
    />
  );
}

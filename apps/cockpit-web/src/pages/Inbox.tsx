import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, Loader2, AlertCircle, X, ChevronDown, Plus } from "lucide-react";

import { supabase } from "@/lib/supabase";
import { sanitizeSearch } from "@/lib/search";
import { useAuth } from "@/contexts/AuthContext";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { usePersistentState } from "@/hooks/usePersistentState";
import { useFiltroOperadorStore } from "@/stores/useFiltroOperadorStore";
import {
  ALL_TIPOS,
  KANBAN_COLUMNS,
  type CardRisco,
  type CardRow,
  type CardTipo,
  type CardWithRelations,
  type KanbanColumnId,
  type KanbanVariant,
} from "@/lib/types";
import { primeiroNome, saudacao } from "@/lib/format";

import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { KanbanCard } from "@/components/cards/KanbanCard";
import {
  CockpitBoard,
  CockpitColumn,
  CockpitEmptyState,
  CockpitStatTile,
  CockpitSummaryBar,
  type Tone,
} from "@/components/cockpit";

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
      .in("id", ids)
      .not("acao_autonoma", "is", null);
    if (error) return m;
    for (const r of (data ?? []) as Array<{ id: string; acao_autonoma: NonNullable<CardRow["acao_autonoma"]> }>) {
      if (r.acao_autonoma) m.set(r.id, r.acao_autonoma);
    }
  } catch {
    /* coluna ainda não existe — trilho autônomo invisível, nada quebra */
  }
  return m;
}

const OCS_NOTIFICACAO_TRATATIVA = [10, 11, 19, 35];

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

  const grouped = useMemo(() => {
    const map = new Map<KanbanColumnId, EnrichedCard[]>();
    KANBAN_COLUMNS.forEach((c) => map.set(c.id, []));
    const respostaOutraSet = cardsRespostaOutraThread ?? new Set<string>();
    (dataFiltrada ?? []).forEach((card) => {
      const enriched: EnrichedCard = respostaOutraSet.has(card.id)
        ? { ...card, possivel_resposta_outra_thread: true }
        : card;
      // Cards com sugestão "card_em_espera" são puxados pra CLIENTE RESPONDEU
      // (mesmo ainda em AGUARDANDO_CLIENTE) — operador valida e adota a thread.
      const colId: KanbanColumnId | undefined = enriched.possivel_resposta_outra_thread
        ? "cliente_respondeu"
        : KANBAN_COLUMNS.find((c) => c.match(enriched))?.id;
      if (colId) map.get(colId)!.push(enriched);
    });
    const OLDEST_FIRST: KanbanColumnId[] = ["validacao", "cliente_respondeu"];
    map.forEach((arr, colId) => {
      // Trilho autônomo (25/08): quem vence PRIMEIRO fica no topo — a fila é
      // a urgência do veto ("do mais velho pro mais novo", ordem do Caio).
      if (colId === "veto_janela") {
        arr.sort((a, b) => {
          const at = a.acao_autonoma?.executar_em ? new Date(a.acao_autonoma.executar_em).getTime() : Infinity;
          const bt = b.acao_autonoma?.executar_em ? new Date(b.acao_autonoma.executar_em).getTime() : Infinity;
          return at - bt;
        });
        return;
      }
      if (OLDEST_FIRST.includes(colId)) {
        arr.sort((a, b) => {
          const ad = a.bastao_data_ultima_ocorrencia ?? null;
          const bd = b.bastao_data_ultima_ocorrencia ?? null;
          if (ad !== bd) {
            if (ad == null) return 1;
            if (bd == null) return -1;
            return ad < bd ? -1 : 1;
          }
          const at = a.created_at ? new Date(a.created_at).getTime() : 0;
          const bt = b.created_at ? new Date(b.created_at).getTime() : 0;
          return at - bt;
        });
        return;
      }
      arr.sort((a, b) => {
        const ap = a.pendentes_count > 0 ? 1 : 0;
        const bp = b.pendentes_count > 0 ? 1 : 0;
        if (ap !== bp) return bp - ap;
        const at = a.last_event_at ? new Date(a.last_event_at).getTime() : 0;
        const bt = b.last_event_at ? new Date(b.last_event_at).getTime() : 0;
        return bt - at;
      });
    });
    return map;
  }, [dataFiltrada, cardsRespostaOutraThread]);

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
  // TRILHO AUTÔNOMO (Caio 25/08): as 2 abas do veto são uma VISÃO própria
  // dentro do kanban — renderizam PRIMEIRO, num bloco visualmente separado.
  const vetoColumns = KANBAN_COLUMNS.filter(
    (c) => c.id === "veto_janela" || c.id === "veto_executada",
  );
  const visibleColumns = KANBAN_COLUMNS.filter(
    (c) => c.id !== "veto_janela" && c.id !== "veto_executada",
  );

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
  const vetoCardsTotal = vetoColumns.reduce(
    (n, c) => n + (grouped.get(c.id)?.length ?? 0),
    0,
  );
  // fallback de segurança: se por qualquer motivo um card do trilho existir
  // na visão atual, o bloco aparece — card com contagem NUNCA fica invisível.
  const mostrarTrilho = isGestor || estaNoPiloto === true || vetoCardsTotal > 0;

  return (
    <div className="flex h-full flex-col">
      {/* ===== 1·Resumo + 2·Números (handoff 2a) ===== */}
      <div className="grid gap-6 border-b border-rule px-7 pb-4 pt-5 lg:grid-cols-[1fr,minmax(430px,540px)]">
        <div className="min-w-0">
          <div className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.14em] text-ink-mute">
            1 · Resumo do dia
          </div>
          <h1 className="mt-1 text-[30px] font-semibold leading-[1.15] text-ink-2" style={{ letterSpacing: "-0.01em" }}>
            {saudacao()}, {primeiroNome(operador?.nome)}.{" "}
            {totalParaFazer === 0 ? (
              <>Tudo em dia. Hora de respirar.</>
            ) : (
              <>
                <span style={{ color: "var(--signal)" }}>
                  {totalParaFazer} {totalParaFazer === 1 ? "card" : "cards"}
                </span>{" "}
                aguardando sua ação.
              </>
            )}
          </h1>
          <p className="mt-1 text-[13.5px] text-ink-soft-2">
            "Aguardando você" e "Cliente respondeu" são as filas que dependem de você agora.
          </p>
        </div>
        <div className="min-w-0">
          <div className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.14em] text-ink-mute">
            2 · Números
          </div>
          <div className="mt-1.5 grid grid-cols-2 gap-[14px] xl:grid-cols-4">
            <CockpitStatTile label="Cards ativos" value={statAtivos} accent="ink" />
            <CockpitStatTile label="Resolvidos hoje" value={resolvidosHoje ?? 0} accent="green" />
            <CockpitStatTile label="Aguardando SSW" value={statAguardandoSsw} accent="amber" />
            <CockpitStatTile label="SLA em risco" value={statSlaRisco} accent="sal" hint={statSlaRisco > 0 ? "crítico" : undefined} />
          </div>
        </div>
      </div>

      {/* ===== 3·Fila — barra de filtros (handoff) ===== */}
      <div className="border-b border-rule px-7 py-3">
        <div className="mb-2 font-mono text-[9.5px] font-semibold uppercase tracking-[0.14em] text-ink-mute">
          3 · Fila
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-mute" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar NF, CTRC, cliente…"
              className="h-9 rounded-[12px] border border-rule bg-surface pl-8 font-mono text-[11.5px] focus-visible:ring-0 focus-visible:border-sal"
            />
            {search && (
              <button type="button" onClick={() => setSearch("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-mute hover:text-ink-2">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <select
            value={clienteFilter}
            onChange={(e) => setClienteFilter(e.target.value)}
            className="h-9 max-w-[220px] rounded-[12px] border border-rule bg-surface px-3 font-mono text-[11px] uppercase tracking-wide text-ink-2"
          >
            <option value="">Cliente: todos</option>
            {clientesDisponiveis.map((c) => (
              <option key={c} value={c}>{c.slice(0, 28)}</option>
            ))}
          </select>

          <FiltroOcorrenciasDropdown
            ocsDisponiveis={ocsDisponiveis ?? []}
            selecionadas={filtroOcs}
            onChange={setFiltroOcs}
            labelOc={labelOc}
          />

          <div className="inline-flex h-9 items-center overflow-hidden rounded-[12px] border border-rule bg-surface">
            {(["todos", "alto", "baixo"] as const).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRiscoFilter(r)}
                className={cn(
                  "h-full px-3 font-mono text-[10px] uppercase tracking-widest transition-colors",
                  riscoFilter === r ? "bg-ink text-white" : "text-ink-soft-2 hover:text-ink-2",
                )}
              >
                {r === "todos" ? "Risco" : r === "alto" ? "Alto" : "Baixo"}
              </button>
            ))}
          </div>

          <Select value={assign} onValueChange={(v) => setAssign(v as AssignFilter)}>
            <SelectTrigger className="h-9 w-[140px] rounded-[12px] border border-rule bg-surface font-mono text-[11px] uppercase tracking-widest">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="meus">Meus cards</SelectItem>
              <SelectItem value="sem_dono">Sem dono</SelectItem>
              {isGestor && <SelectItem value="todos">Todos</SelectItem>}
            </SelectContent>
          </Select>

          {isFetching && <Loader2 className="h-3.5 w-3.5 animate-spin text-ink-mute" />}
        </div>

        {filtroOcs.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1">
            {filtroOcs.map((codigo) => (
              <span key={codigo} title={labelOc(codigo)}
                className="inline-flex items-center gap-1 rounded-[6px] bg-muted-2 px-2 py-0.5 font-mono text-[10.5px] text-ink-2">
                oc {codigo}
                <button type="button" onClick={() => setFiltroOcs(filtroOcs.filter((c) => c !== codigo))}
                  className="text-ink-mute hover:text-sal" aria-label={`Remover oc=${codigo}`}>
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            <button type="button" onClick={() => setFiltroOcs([])}
              className="font-mono text-[10px] uppercase tracking-widest text-ink-mute underline-offset-4 hover:text-sal hover:underline">
              limpar
            </button>
          </div>
        )}

        {/* Filtros avançados + ações — nada saiu do produto (decisão Caio:
            "nada pode sumir"; o handoff só tira do trilho principal) */}
        <details className="group mt-2">
          <summary className="cursor-pointer list-none font-mono text-[10px] uppercase tracking-widest text-ink-mute hover:text-ink-2">
            Filtros avançados & ações ▾
          </summary>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
            <MultiFilter
              label="Tipo"
              options={ALL_TIPOS.map((t) => ({ value: t, label: t }))}
              selected={tipoFilter}
              onChange={(v) => setTipoFilter(v as CardTipo[])}
              allLabel="Todos os tipos"
            />
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-mute">CT-e:</span>
              <Select value={filtroTipoCte} onValueChange={(v) => setFiltroTipoCte(v as FiltroTipoCte)}>
                <SelectTrigger className="h-8 w-[130px] rounded-[12px] border border-rule bg-surface font-mono text-[11px] uppercase tracking-widest">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="todos">Todos</SelectItem>
                  <SelectItem value="NORMAL">Normal</SelectItem>
                  <SelectItem value="DEVOLUCAO">Devolução</SelectItem>
                  <SelectItem value="REVERSA">Reversa</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </details>
      </div>

      {/* Kanban */}
      <div className="min-h-0 flex-1 overflow-hidden bg-paper">
        {isError ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 font-display text-[14px] italic text-ink-soft">
            <AlertCircle className="h-5 w-5 text-sal" />
            <span>Erro ao carregar cards.</span>
            <button
              onClick={() => refetch()}
              className="btn-flat bg-paper text-ink"
            >
              Tentar novamente
            </button>
          </div>
        ) : isLoading ? (
          <div className="flex h-full gap-3 overflow-x-auto p-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-full w-[300px] shrink-0 rounded-[14px] border border-rule" />
            ))}
          </div>
        ) : (
          <div className="flex h-full flex-col">
            {(data?.length ?? 0) >= INBOX_LIMIT && (
              // Teto atingido: pode haver cards além destes. NUNCA truncar em
              // silêncio — os cortados são os de atividade mais antiga (ordenação),
              // ou seja, os mais esquecidos. Avisar e dizer como alcançá-los.
              <div className="flex shrink-0 items-center gap-2 border-b-2 border-sal bg-sal/10 px-3 py-2 font-mono text-[11px] text-ink">
                <AlertCircle className="h-4 w-4 shrink-0 text-sal" />
                <span>
                  Mostrando os {INBOX_LIMIT} cards de atividade mais recente. Pode haver mais além
                  destes (os mais antigos). Use os filtros (tipo, ocorrência, dono) para alcançá-los.
                </span>
              </div>
            )}
            <CockpitBoard>
            {/* ── TRILHO AUTÔNOMO — visão própria, ANTES de tudo (Caio 25/08).
                Moldura + fundo próprios: aqui o robô age se ninguém vetar;
                do divisor pra frente é o kanban de sempre (trabalho humano).
                PILOTO (26/08): só aparece pra FELIPE/ISABELY/LARISSA e gestor. */}
            {mostrarTrilho && (<>
            <div className="flex h-full shrink-0 flex-col rounded-[14px] border-2 border-violet-300 bg-violet-50/50 shadow-sm">
              <div className="flex items-center gap-2 border-b border-violet-200 px-4 py-2">
                <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-violet-900">
                  ⏱ Trilho autônomo
                </span>
                <span className="text-[10.5px] text-violet-900/70">
                  card com contagem = o robô vai agir · olhe, edite ou cancele
                </span>
              </div>
              <div className="flex min-h-0 flex-1 gap-4 p-3">
                {vetoColumns.map((col) => {
                  const cards = grouped.get(col.id) ?? [];
                  return (
                    <KanbanColumn
                      key={col.id}
                      variant={col.variant}
                      title={col.title}
                      count={cards.length}
                      cards={cards}
                    />
                  );
                })}
              </div>
            </div>

            {/* divisor entre a visão autônoma e o kanban de sempre */}
            <div className="w-[3px] shrink-0 self-stretch rounded bg-rule-strong/60" />
            </>)}

            {visibleColumns.map((col) => {
              const cards = grouped.get(col.id) ?? [];
              return (
                <KanbanColumn
                  key={col.id}
                  variant={col.variant}
                  title={col.title}
                  count={cards.length}
                  cards={cards}
                />
              );
            })}
            </CockpitBoard>
          </div>
        )}
      </div>
    </div>
  );

}

/* ---------- Kanban column (placa de estação) — consome o kit ---------- */

const TONE_BY_VARIANT: Record<KanbanVariant, Tone> = {
  todo: "slate",
  critical: "sal",
  waiting: "amber",
  executed: "emerald",
  pending_bastao: "sky",
  auto: "violet",
  responded: "indigo",
  alert: "sal-deep",
  veto_janela: "violet",
  veto_executada: "emerald",
};

const EMPTY_BY_VARIANT: Record<KanbanVariant, { glyph: string; text: string }> = {
  todo: { glyph: "✦", text: "Tudo em dia. Hora de respirar." },
  critical: { glyph: "○", text: "Sem decisões pendentes agora." },
  waiting: { glyph: "⊙", text: "Sem aguardar resposta de cliente." },
  executed: { glyph: "◇", text: "Nenhuma ação confirmada hoje ainda." },
  pending_bastao: { glyph: "✓", text: "Sem ações aguardando Bastão." },
  auto: { glyph: "◆", text: "Agente sem ações autônomas no momento." },
  responded: {
    glyph: "◇",
    text: "Nenhum cliente respondeu ainda. Quando algum cliente responder por email, o card aparece aqui.",
  },
  alert: { glyph: "✦", text: "Sem tratativas pendentes." },
  veto_janela: {
    glyph: "⏱",
    text: "Nenhuma ação autônoma programada. Quando o robô programar uma ação, ela aparece aqui com a contagem regressiva.",
  },
  veto_executada: {
    glyph: "◆",
    text: "Nenhuma ação autônoma executada na última hora.",
  },
};

function KanbanColumn({
  variant,
  title,
  count,
  cards,
}: {
  variant: KanbanVariant;
  title: string;
  count: number;
  cards: EnrichedCard[];
}) {
  const emphasize =
    (variant === "critical" || variant === "responded" || variant === "alert") && count > 0;

  return (
    <CockpitColumn tone={TONE_BY_VARIANT[variant]} title={title} count={count} emphasize={emphasize}>
      {cards.length === 0 ? (
        <CockpitEmptyState {...EMPTY_BY_VARIANT[variant]} />
      ) : (
        cards.map((c) => <KanbanCard key={c.id} card={c} pendentes={c.pendentes_count} />)
      )}
    </CockpitColumn>
  );
}

/* ---------- Multi filter ---------- */

function MultiFilter({
  label,
  options,
  selected,
  onChange,
  allLabel,
  disabled,
}: {
  label: string;
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (v: string[]) => void;
  allLabel: string;
  disabled?: boolean;
}) {
  const allSelected = selected.length === options.length;
  const buttonText = allSelected
    ? allLabel
    : selected.length === 0
      ? `${label}: nenhum`
      : `${label}: ${selected.length}`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          className={cn(
            "inline-flex h-9 items-center gap-1.5 rounded-[12px] border border-rule bg-surface px-3 font-mono text-[10px] uppercase tracking-widest text-ink hover:bg-subtle",
            disabled && "opacity-50",
          )}
        >
          {buttonText}
          <ChevronDown className="h-3 w-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[320px] overflow-y-auto">
        <DropdownMenuLabel className="font-mono text-[10px] uppercase tracking-widest">
          {label}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <button
          type="button"
          className="w-full px-2 py-1.5 text-left font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:bg-muted"
          onClick={() => onChange(allSelected ? [] : options.map((o) => o.value))}
        >
          {allSelected ? "Limpar tudo" : "Selecionar tudo"}
        </button>
        <DropdownMenuSeparator />
        {options.map((opt) => (
          <DropdownMenuCheckboxItem
            key={opt.value}
            checked={selected.includes(opt.value)}
            onCheckedChange={(v) => {
              if (v) onChange([...selected, opt.value]);
              else onChange(selected.filter((s) => s !== opt.value));
            }}
            className="text-[12px] capitalize"
          >
            {opt.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ---------- Filtro Ocorrências (multi-select) ---------- */

function FiltroOcorrenciasDropdown({
  ocsDisponiveis,
  selecionadas,
  onChange,
  labelOc,
}: {
  ocsDisponiveis: number[];
  selecionadas: number[];
  onChange: (next: number[]) => void;
  labelOc: (codigo: number) => string;
}) {
  const [aberto, setAberto] = useState(false);
  const [busca, setBusca] = useState("");
  const [pendentes, setPendentes] = useState<number[]>(selecionadas);

  useEffect(() => {
    if (aberto) {
      setPendentes(selecionadas);
      setBusca("");
    }
  }, [aberto, selecionadas]);

  const filtradas = ocsDisponiveis.filter((c) => {
    if (!busca) return true;
    const desc = labelOc(c).toLowerCase();
    return String(c).includes(busca) || desc.includes(busca.toLowerCase());
  });

  const toggle = (codigo: number) => {
    setPendentes((p) =>
      p.includes(codigo) ? p.filter((c) => c !== codigo) : [...p, codigo].sort((a, b) => a - b),
    );
  };

  const buttonText =
    selecionadas.length === 0
      ? "Todas"
      : `${selecionadas.length} selecionada${selecionadas.length > 1 ? "s" : ""}`;

  return (
    <DropdownMenu open={aberto} onOpenChange={setAberto}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex h-9 items-center gap-1.5 rounded-[12px] border border-rule bg-surface px-3 font-mono text-[10px] uppercase tracking-widest text-ink hover:bg-subtle"
        >
          {buttonText}
          <ChevronDown className="h-3 w-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80 p-2">
        <Input
          autoFocus
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          placeholder="Buscar por código ou descrição…"
          className="mb-2 h-8 rounded-[10px] border border-rule bg-surface font-mono text-[11px] focus-visible:ring-0 focus-visible:border-sal"
        />
        <div className="max-h-64 overflow-y-auto">
          {filtradas.length === 0 ? (
            <p className="px-2 py-3 text-center font-display text-[12px] italic text-ink-soft">
              Sem ocorrências disponíveis
            </p>
          ) : (
            filtradas.map((codigo) => (
              <label
                key={codigo}
                className="flex cursor-pointer items-center gap-2 px-2 py-1 font-mono text-[11px] hover:bg-paper-deep"
              >
                <input
                  type="checkbox"
                  checked={pendentes.includes(codigo)}
                  onChange={() => toggle(codigo)}
                  className="h-3.5 w-3.5"
                />
                <span className="font-semibold text-ink tabular-nums">{codigo}</span>
                <span className="truncate text-ink-soft">— {labelOc(codigo) || "—"}</span>
              </label>
            ))
          )}
        </div>
        <div className="mt-2 flex items-center justify-between border-t-2 border-ink pt-2">
          <button
            type="button"
            onClick={() => setPendentes([])}
            className="font-mono text-[10px] uppercase tracking-widest text-ink-soft hover:text-ink"
          >
            Limpar
          </button>
          <button
            type="button"
            onClick={() => {
              onChange(pendentes);
              setAberto(false);
            }}
            className="rounded-[8px] bg-ink px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-white hover:bg-sal"
          >
            Aplicar ({pendentes.length})
          </button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

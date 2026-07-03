import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, Loader2, AlertCircle, X, ChevronDown, Plus } from "lucide-react";
import { ModalCriarCard } from "@/components/cards/ModalCriarCard";

import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { usePersistentState } from "@/hooks/usePersistentState";
import { useFiltroOperadorStore } from "@/stores/useFiltroOperadorStore";
import {
  ALL_TIPOS,
  KANBAN_COLUMNS,
  type CardRisco,
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

const OCS_NOTIFICACAO_TRATATIVA = [10, 11, 19, 35];
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
  const [onlyAction, setOnlyAction] = usePersistentState(
    "inbox.filter.onlyAction",
    false,
  );
  const [filtroTratativa, setFiltroTratativa] = usePersistentState<FiltroTratativa>(
    "inbox.filter.tratativa",
    "todas",
  );
  const [filtroTipoCte, setFiltroTipoCte] = usePersistentState<FiltroTipoCte>(
    "inbox.filter.tipoCte",
    "todos",
  );
  const [filtroOcs, setFiltroOcs] = usePersistentState<number[]>(
    "inbox.filter.ocs",
    [],
  );

  const [openCriarCard, setOpenCriarCard] = useState(false);

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: [
      "inbox",
      "cards",
      { tipoFilter, riscoFilter, assign, search, onlyAction, filtroTratativa, filtroTipoCte, filtroOcs, op: operador?.id ?? null, filtroOperadorId },
    ],
    enabled: !!supabase && (assign !== "meus" || !!operador),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      if (!supabase) return [] as EnrichedCard[];

      let q = supabase.from("cards").select(SELECT_WITH_RELATIONS);
      q = q.not("state", "in", "(CANCELADO,RESOLVIDO,TRANSFERIDO,EXTRAVIO_MONITORADO)");

      if (onlyAction) {
        q = q.eq("state", "AGUARDANDO_VALIDACAO_HUMANA");
      }
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
        const term = search.trim().replace(/%/g, "");
        q = q.or(
          `nf.ilike.%${term}%,ctrc.ilike.%${term}%,empresa_cliente.ilike.%${term}%,nome_cliente.ilike.%${term}%`,
        );
      }
      if (filtroTratativa === "notificacao") {
        q = q.in("cod_ultima_ocorrencia", OCS_NOTIFICACAO_TRATATIVA);
      } else if (filtroTratativa === "desenvolver") {
        q = q.not(
          "cod_ultima_ocorrencia",
          "in",
          `(${OCS_NOTIFICACAO_TRATATIVA.join(",")})`,
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
        .limit(500);

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

      return cards.map<EnrichedCard>((c) => ({
        ...c,
        pendentes_count: pendingMap.get(c.id) ?? 0,
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
      { tipoFilter, riscoFilter, assign, search, onlyAction, filtroTratativa, filtroTipoCte, op: operador?.id ?? null, filtroOperadorId },
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
      if (onlyAction) q = q.eq("state", "AGUARDANDO_VALIDACAO_HUMANA");
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
        const term = search.trim().replace(/%/g, "");
        q = q.or(`nf.ilike.%${term}%,ctrc.ilike.%${term}%,empresa_cliente.ilike.%${term}%,nome_cliente.ilike.%${term}%`);
      }
      if (filtroTratativa === "notificacao") {
        q = q.in("cod_ultima_ocorrencia", OCS_NOTIFICACAO_TRATATIVA);
      } else if (filtroTratativa === "desenvolver") {
        q = q.not("cod_ultima_ocorrencia", "in", `(${OCS_NOTIFICACAO_TRATATIVA.join(",")})`);
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

  const grouped = useMemo(() => {
    const map = new Map<KanbanColumnId, EnrichedCard[]>();
    KANBAN_COLUMNS.forEach((c) => map.set(c.id, []));
    const respostaOutraSet = cardsRespostaOutraThread ?? new Set<string>();
    (data ?? []).forEach((card) => {
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
  }, [data, cardsRespostaOutraThread]);

  const totalParaFazer =
    (grouped.get("validacao")?.length ?? 0) + (grouped.get("cliente_respondeu")?.length ?? 0);
  const visibleColumns = onlyAction
    ? KANBAN_COLUMNS.filter((c) => c.id === "validacao" || c.id === "cliente_respondeu")
    : KANBAN_COLUMNS;

  return (
    <div className="flex h-full flex-col">
      {/* Saudação editorial */}
      <div className="border-b-2 border-ink bg-paper px-6 py-4">
        <p className="font-display text-[20px] leading-tight text-ink">
          {saudacao()}, <span className="font-semibold">{primeiroNome(operador?.nome)}.</span>
          <span className="font-display italic text-ink-soft">
            {" "}
            {totalParaFazer === 0
              ? "Tudo em dia, momento de café."
              : `${totalParaFazer} ${totalParaFazer === 1 ? "card aguardando" : "cards aguardando"} sua ação.`}
          </span>
          {totalParaFazer === 0 && (
            <span className="ml-2 inline-flex items-center bg-good px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-widest text-paper">
              ✦ Tudo em dia
            </span>
          )}
        </p>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b-2 border-ink bg-paper-deep px-6 py-2">
        <MultiFilter
          label="Tipo"
          options={ALL_TIPOS.map((t) => ({ value: t, label: t }))}
          selected={tipoFilter}
          onChange={(v) => setTipoFilter(v as CardTipo[])}
          allLabel="Todos os tipos"
        />

        <div className="inline-flex items-center border-2 border-ink bg-paper">
          {(["todos", "alto", "baixo"] as const).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRiscoFilter(r)}
              className={cn(
                "px-2 py-1 font-mono text-[10px] uppercase tracking-widest transition-colors",
                riscoFilter === r
                  ? "bg-ink text-paper"
                  : "text-ink-soft hover:text-ink",
              )}
            >
              {r === "todos" ? "Risco" : r === "alto" ? "Alto" : "Baixo"}
            </button>
          ))}
        </div>

        <Select value={assign} onValueChange={(v) => setAssign(v as AssignFilter)}>
          <SelectTrigger className="h-8 w-[140px] border-2 border-ink bg-paper font-mono text-[11px] uppercase tracking-widest rounded-none">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="meus">Meus cards</SelectItem>
            <SelectItem value="sem_dono">Sem dono</SelectItem>
            {isGestor && <SelectItem value="todos">Todos</SelectItem>}
          </SelectContent>
        </Select>

        <div className="relative ml-auto w-64">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-soft" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar NF, CTRC, cliente…"
            className="h-8 rounded-none border-2 border-ink bg-paper pl-7 font-mono text-[11px] focus-visible:ring-0 focus-visible:border-sal"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-soft hover:text-ink"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 border-2 border-ink bg-paper px-2 py-1">
          <Switch id="only-action" checked={onlyAction} onCheckedChange={setOnlyAction} />
          <Label htmlFor="only-action" className="cursor-pointer font-mono text-[10px] uppercase tracking-widest">
            Só sua ação
          </Label>
        </div>

        <button
          type="button"
          onClick={() => setOpenCriarCard(true)}
          className="inline-flex items-center gap-1 border-2 border-ink bg-ink px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-paper hover:bg-sal"
        >
          <Plus className="h-3 w-3" />
          Criar card
        </button>

        <a
          href="/resolvidos"
          className="ml-2 font-mono text-[10px] uppercase tracking-widest text-ink-soft underline-offset-4 hover:text-sal hover:underline"
        >
          Ver resolvidos →
        </a>


        {isFetching && <Loader2 className="ml-1 h-3 w-3 animate-spin text-ink-soft" />}
      </div>

      {/* Toolbar 2 — Filtros de tratativa + tipo CT-e */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b-2 border-ink bg-paper px-6 py-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">
            Tipo de tratativa:
          </span>
          <div className="inline-flex items-center border-2 border-ink bg-paper">
            {([
              { id: "todas", label: "Todas" },
              { id: "notificacao", label: "Notificação" },
              { id: "desenvolver", label: "Desenvolver" },
            ] as { id: FiltroTratativa; label: string }[]).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setFiltroTratativa(opt.id)}
                className={cn(
                  "px-2 py-1 font-mono text-[10px] uppercase tracking-widest transition-colors",
                  filtroTratativa === opt.id
                    ? "bg-ink text-paper"
                    : "text-ink-soft hover:text-ink",
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">
            Tipo de CT-e:
          </span>
          <Select
            value={filtroTipoCte}
            onValueChange={(v) => setFiltroTipoCte(v as FiltroTipoCte)}
          >
            <SelectTrigger className="h-8 w-[140px] rounded-none border-2 border-ink bg-paper font-mono text-[11px] uppercase tracking-widest">
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

        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">
            Ocorrência:
          </span>
          <FiltroOcorrenciasDropdown
            ocsDisponiveis={ocsDisponiveis ?? []}
            selecionadas={filtroOcs}
            onChange={setFiltroOcs}
            labelOc={labelOc}
          />
          {filtroOcs.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              {filtroOcs.map((codigo) => (
                <span
                  key={codigo}
                  title={labelOc(codigo)}
                  className="inline-flex items-center gap-1 border-2 border-ink bg-paper px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest text-ink"
                >
                  {codigo}
                  <button
                    type="button"
                    onClick={() => setFiltroOcs(filtroOcs.filter((c) => c !== codigo))}
                    className="text-ink-soft hover:text-sal"
                    aria-label={`Remover oc=${codigo}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              <button
                type="button"
                onClick={() => setFiltroOcs([])}
                className="font-mono text-[10px] uppercase tracking-widest text-ink-soft underline-offset-4 hover:text-sal hover:underline"
              >
                limpar
              </button>
            </div>
          )}
        </div>
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
              <Skeleton key={i} className="h-full w-[300px] shrink-0 rounded-none border-2 border-rule" />
            ))}
          </div>
        ) : (
          <div className="flex h-full gap-4 overflow-x-auto p-4">
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
          </div>
        )}
      </div>
      <ModalCriarCard open={openCriarCard} onOpenChange={setOpenCriarCard} />
    </div>
  );

}

/* ---------- Kanban column (placa de estação) ---------- */

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
  const styles = ((): { wrap: string; head: string; pulse?: boolean } => {
    switch (variant) {
      case "todo":
        return { wrap: "border-ink", head: "bg-paper-deep text-ink border-b-2 border-ink" };
      case "critical":
        return {
          wrap: "border-sal",
          head: "bg-sal text-paper border-b-2 border-ink",
          pulse: count > 0,
        };
      case "waiting":
        return { wrap: "border-ink", head: "bg-warn text-ink border-b-2 border-ink" };
      case "executed":
        return { wrap: "border-ink", head: "bg-good text-paper border-b-2 border-ink" };
      case "pending_bastao":
        return { wrap: "border-blue-500", head: "bg-blue-500 text-paper border-b-2 border-ink" };
      case "auto":
        return { wrap: "border-ink", head: "bg-ink text-paper border-b-2 border-ink" };
      case "responded":
        return {
          wrap: "border-amber-500",
          head: "bg-amber-500 text-paper border-b-2 border-ink",
          pulse: count > 0,
        };
      case "alert":
        return { wrap: "border-sal-deep", head: "bg-sal-deep text-paper border-b-2 border-ink" };
    }
  })();

  return (
    <section
      className={cn(
        "flex h-full w-[310px] min-w-[290px] max-w-[340px] shrink-0 flex-col overflow-hidden border-2 bg-paper-deep/50",
        styles.wrap,
      )}
    >
      {/* Placa estação */}
      <header className={cn("relative flex items-center justify-between gap-2 px-3 py-2.5", styles.head)}>
        <h2
          className={cn(
            "font-mono text-[11px] font-bold uppercase tracking-[0.18em]",
            styles.pulse && "animate-pulse-soft",
          )}
        >
          {title}
        </h2>
        <span className="tabular font-mono text-[16px] font-bold leading-none">
          {count.toString().padStart(2, "0")}
        </span>
        {/* Faixa diagonal decorativa */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-20"
          style={{
            backgroundImage:
              "repeating-linear-gradient(45deg, transparent 0 6px, currentColor 6px 7px)",
            mixBlendMode: "multiply",
          }}
        />
      </header>

      <div className="flex-1 space-y-2 overflow-y-auto px-2 py-2">
        {cards.length === 0 ? (
          <EmptyState variant={variant} />
        ) : (
          cards.map((c) => <KanbanCard key={c.id} card={c} pendentes={c.pendentes_count} />)
        )}
      </div>
    </section>
  );
}

/* ---------- Empty state ---------- */

function EmptyState({ variant }: { variant: KanbanVariant }) {
  const messages: Record<KanbanVariant, { glyph: string; text: string }> = {
    todo: { glyph: "✦", text: "Tudo em dia. Hora de respirar." },
    critical: { glyph: "○", text: "Sem decisões pendentes agora." },
    waiting: { glyph: "⊙", text: "Sem aguardar resposta de cliente." },
    executed: { glyph: "◇", text: "Nenhuma ação confirmada hoje ainda." },
    pending_bastao: { glyph: "✓", text: "Sem ações aguardando Bastão." },
    auto: { glyph: "◆", text: "Agente sem ações autônomas no momento." },
    responded: { glyph: "📬", text: "Nenhum cliente respondeu ainda. Quando algum cliente responder por email, o card aparece aqui." },
    alert: { glyph: "✦", text: "Sem tratativas pendentes." },
  };
  const { glyph, text } = messages[variant];
  return (
    <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
      <span className="font-display text-[32px] text-rule-strong">{glyph}</span>
      <p className="mt-2 font-display text-[12px] italic leading-snug text-ink-soft">{text}</p>
    </div>
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
            "inline-flex h-8 items-center gap-1.5 border-2 border-ink bg-paper px-2 font-mono text-[10px] uppercase tracking-widest text-ink hover:bg-paper-deep",
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
          className="inline-flex h-8 items-center gap-1.5 border-2 border-ink bg-paper px-2 font-mono text-[10px] uppercase tracking-widest text-ink hover:bg-paper-deep"
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
          className="mb-2 h-8 rounded-none border-2 border-ink bg-paper font-mono text-[11px] focus-visible:ring-0 focus-visible:border-sal"
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
            className="border-2 border-ink bg-ink px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-paper hover:bg-sal"
          >
            Aplicar ({pendentes.length})
          </button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

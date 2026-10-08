// =============================================================================
// Tela da Operação (ADR 0041): a fila dela, o detalhe e o lançamento no SSW
// pelo clique humano sobre a prévia. Rota /operacao e /operacao/:itemId.
// =============================================================================
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ArrowDownUp, Columns3, List, Loader2, PowerOff } from "lucide-react";

import { CockpitEmptyState, CockpitStatTile } from "@/components/cockpit";
import { DetalheItemOperacao } from "@/components/operacao/DetalheItemOperacao";
import { FiltrosFilaOperacao } from "@/components/operacao/FiltrosFilaOperacao";
import { KanbanOperacao } from "@/components/operacao/KanbanOperacao";
import { ListaFilaOperacao } from "@/components/operacao/ListaFilaOperacao";
import { useAreas, useOpApi, useOpSessao } from "@/contexts/OperacaoContext";
import { useRealtimeTable } from "@/hooks/useRealtimeTable";
import { usePersistentState } from "@/hooks/usePersistentState";
import {
  FILTROS_PADRAO,
  filtrarFila,
  lancamentoAtivo,
  opcoesDaFila,
  ordenarPorTempoParado,
  tempoParadoMs,
  type FiltrosFila,
} from "@/lib/operacao/fila";
import { sugestaoLancavel } from "@/lib/operacao/sugestao";
import { cn } from "@/lib/utils";

const CHAVE_FILA = ["op", "fila"] as const;
const LIMITE_AVISO = 1000;

function useAgora(intervaloMs = 30_000): number {
  const [agora, setAgora] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setAgora(Date.now()), intervaloMs);
    return () => clearInterval(t);
  }, [intervaloMs]);
  return agora;
}

export default function Operacao() {
  const { itemId } = useParams<{ itemId?: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const api = useOpApi();
  const { sessao, carregada } = useOpSessao();
  const areas = useAreas();
  const agoraMs = useAgora();
  const membro = sessao?.membro ?? null;

  const [filtros, setFiltros] = usePersistentState<FiltrosFila>("operacao.filtros.v1", FILTROS_PADRAO);
  const [direcao, setDirecao] = usePersistentState<"mais_parado" | "menos_parado">("operacao.ordem.v1", "mais_parado");
  // Kanban é a visão principal (pedido do dono); a lista continua a um clique. Lembrada por navegador.
  // Três visões (pedido do dono, 07/10): por problema (principal), por andamento e lista.
  const [visao, setVisao] = usePersistentState<"problema" | "andamento" | "lista">("operacao.visao.v2", "problema");

  // A tela desligada esconde a fila do membro; o gestor continua vendo para conferir (ADR 0041 D9).
  const podeVerFila = areas.telaLigada || areas.ehGestor;

  const { data: linhas, isLoading, error, isFetching } = useQuery({
    queryKey: CHAVE_FILA,
    enabled: !!api && carregada && podeVerFila,
    // Rede de segurança do Realtime: se o canal cair calado, a fila não congela.
    refetchInterval: 60_000,
    queryFn: () => api!.fila(),
  });

  // Lista de códigos liberados: decide se a sugestão vira botão quando a regra não disse.
  const { data: codigos } = useQuery({
    queryKey: ["op", "codigos"],
    enabled: !!api && carregada && podeVerFila,
    staleTime: 60_000,
    queryFn: () => api!.codigosDisponiveis(),
  });
  const codigosLiberados = useMemo(() => (codigos ? new Set(codigos.map((c) => c.codigo)) : null), [codigos]);

  // Realtime (produção): op_itens e op_lancamentos mudam → refetch da fila e do item aberto.
  const realtimeLigado = !!api && api.modo === "supabase" && podeVerFila;
  useRealtimeTable({ table: "op_itens", queryKeys: [["op"]], enabled: realtimeLigado });
  useRealtimeTable({ table: "op_lancamentos", queryKeys: [["op"]], enabled: realtimeLigado });
  // Demo: o "worker" falso avisa por aqui.
  useEffect(() => {
    if (!api?.assinarMudancas) return;
    return api.assinarMudancas(() => qc.invalidateQueries({ queryKey: ["op"] }));
  }, [api, qc]);

  const todas = useMemo(() => linhas ?? [], [linhas]);
  const opcoes = useMemo(() => opcoesDaFila(todas), [todas]);
  const visiveis = useMemo(
    () => ordenarPorTempoParado(filtrarFila(todas, filtros, { membro, agoraMs }), agoraMs, direcao),
    [todas, filtros, membro, agoraMs, direcao],
  );

  const stats = useMemo(() => {
    let parados24 = 0;
    let comSugestao = 0;
    let emAndamento = 0;
    let comVoce = 0;
    for (const l of todas) {
      const ms = tempoParadoMs(l, agoraMs);
      if (ms != null && ms >= 24 * 3_600_000) parados24++;
      if (sugestaoLancavel(l.sugestao, codigosLiberados, l.cod_ultima_ocorrencia)) comSugestao++;
      if (lancamentoAtivo(l.lancamento_status)) emAndamento++;
      if (membro && l.assumido_por === membro.id) comVoce++;
    }
    return { parados24, comSugestao, emAndamento, comVoce };
  }, [todas, agoraMs, membro, codigosLiberados]);

  const abrir = (id: string) => navigate(`/operacao/${id}`);
  const fechar = () => navigate("/operacao");

  if (!api || !carregada) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Carregando a fila da Operação…
      </div>
    );
  }

  if (!podeVerFila) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center px-6 py-24 text-center">
        <PowerOff className="h-8 w-8 text-ink-mute" aria-hidden />
        <h1 className="mt-4 text-[20px] font-semibold text-ink-2">A tela da Operação ainda está desligada</h1>
        <p className="mt-2 text-[13.5px] text-ink-soft-2">
          Seu acesso está cadastrado. A fila aparece aqui assim que a tela for ligada.
        </p>
      </div>
    );
  }

  const papel = membro
    ? `${membro.papel_op === "supervisor_op" ? "Supervisão" : "Operador"} · ${
        membro.papel_op === "supervisor_op" ? "todas as unidades" : membro.unidades.join(", ") || "sem unidade"
      }`
    : "Gestor · vendo como conferência";

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Resumo */}
      <div className="grid gap-6 border-b border-rule px-5 pb-4 pt-5 md:px-7 lg:grid-cols-[1fr,minmax(430px,560px)]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3 font-mono text-[9.5px] font-semibold uppercase tracking-[0.14em] text-ink-mute">
            <span>Operação · {papel}</span>
            {(areas.ehGestor || membro?.papel_op === "supervisor_op") && (
              <Link
                to="/operacao/espelho"
                className="rounded-full border px-2.5 py-0.5 normal-case tracking-normal"
                style={{ borderColor: "#6D28D9", color: "#6D28D9" }}
              >
                Espelho do Relacionamento →
              </Link>
            )}
          </div>
          <h1 className="mt-1 text-[26px] font-semibold leading-[1.15] text-ink-2 md:text-[30px]" style={{ letterSpacing: "-0.01em" }}>
            {todas.length === 0 ? (
              <>Fila vazia. Nada parado com a Operação.</>
            ) : (
              <>
                <span style={{ color: "var(--signal)" }}>
                  {todas.length} {todas.length === 1 ? "nota" : "notas"}
                </span>{" "}
                paradas com a Operação.
              </>
            )}
          </h1>
          <p className="mt-1 text-[13.5px] text-ink-soft-2">
            Mais paradas primeiro. Nada vai ao SSW sem você confirmar a prévia.
          </p>
          {api.modo === "demo" && (
            <p className="mt-2 text-[12px] font-semibold" style={{ color: "#6D28D9" }} data-testid="origem-demo">
              {api.origemDados === "v3"
                ? "Fila REAL da Operação, lida agora do SSW (só leitura). Assumir, lançar e encaminhar ficam só neste navegador: nada é lançado no SSW nem enviado ao Relacionamento."
                : api.origemDados === "fixture"
                  ? "Demonstração com a fila REAL do arquivo local (demo/fila-real.json). Nada vai ao banco nem ao SSW."
                  : `Demonstração com dados fictícios${api.avisoOrigem ? ` (${api.avisoOrigem})` : ""}. Nada vai ao banco nem ao SSW.`}
            </p>
          )}
          {!areas.telaLigada && areas.ehGestor && (
            <p className="mt-2 text-[12px] font-semibold" style={{ color: "var(--warning)" }}>
              A tela está desligada para os membros. Você vê como gestor.
            </p>
          )}
          {sessao?.flags && !sessao.flags.operacao_lancar_ssw && (
            <p className="mt-2 text-[12px] font-semibold" style={{ color: "var(--warning)" }}>
              O lançamento no SSW está desligado: dá para ver e assumir, mas não lançar.
            </p>
          )}
          {membro && !membro.pode_lancar && (
            <p className="mt-2 text-[12px] font-semibold" style={{ color: "var(--warning)" }}>
              Seu acesso é só de leitura.
            </p>
          )}
        </div>
        <div className="grid min-w-0 grid-cols-2 gap-[14px] xl:grid-cols-4">
          <CockpitStatTile label="Parados 1d+" value={stats.parados24} accent="sal" />
          <CockpitStatTile label="Com sugestão" value={stats.comSugestao} accent="violet" />
          <CockpitStatTile label="Indo ao SSW" value={stats.emAndamento} accent="amber" />
          <CockpitStatTile label="Com você" value={stats.comVoce} accent="ink" />
        </div>
      </div>

      {/* Filtros */}
      <div className="border-b border-rule px-5 py-3 md:px-7">
        <FiltrosFilaOperacao
          filtros={filtros}
          onChange={setFiltros}
          ocs={opcoes.ocs}
          cidades={opcoes.cidades}
          temUnidades={(membro?.unidades.length ?? 0) > 0}
        />
        <div className="mt-2 flex items-center gap-3 font-mono text-[10.5px] uppercase tracking-widest text-ink-mute">
          <span data-testid="contagem-fila">
            {visiveis.length} de {todas.length}
          </span>
          <button
            type="button"
            onClick={() => setDirecao(direcao === "mais_parado" ? "menos_parado" : "mais_parado")}
            className="inline-flex items-center gap-1 hover:text-ink-2"
          >
            <ArrowDownUp className="h-3 w-3" />
            {direcao === "mais_parado" ? "Mais parado primeiro" : "Menos parado primeiro"}
          </button>
          {isFetching && <Loader2 className="h-3 w-3 animate-spin" />}
          <div className="ml-auto inline-flex overflow-hidden rounded-[10px] border border-rule" role="group" aria-label="Visão">
            {(["problema", "andamento", "lista"] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={visao === v}
                onClick={() => setVisao(v)}
                className={cn(
                  "inline-flex h-7 items-center gap-1 px-2.5 transition-colors",
                  visao === v ? "bg-ink text-white" : "bg-surface text-ink-soft-2 hover:text-ink-2",
                )}
              >
                {v === "lista" ? <List className="h-3 w-3" /> : <Columns3 className="h-3 w-3" />}
                {v === "problema" ? "Por problema" : v === "andamento" ? "Por andamento" : "Lista"}
              </button>
            ))}
          </div>
        </div>
      </div>

      {todas.length >= LIMITE_AVISO && (
        <div className="flex items-center gap-2 border-b px-7 py-2 text-[12px]" style={{ background: "var(--warning-soft)", color: "var(--c-ink)" }}>
          <AlertCircle className="h-3.5 w-3.5" style={{ color: "var(--warning)" }} />
          A fila passou de {LIMITE_AVISO} itens e a lista mostra só os {LIMITE_AVISO} mais parados. Use os filtros.
        </div>
      )}

      {/* Lista + detalhe */}
      <div className={cn("grid min-h-0 flex-1", itemId && "lg:grid-cols-[minmax(0,1fr),minmax(400px,480px)]")}>
        <div className={cn("min-h-0", visao !== "lista" ? "overflow-hidden" : "overflow-y-auto", itemId && "hidden lg:block")}>
          {isLoading ? (
            <div className="flex items-center gap-2 px-7 py-8 text-[13px] text-ink-mute">
              <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
            </div>
          ) : error ? (
            <div className="px-7 py-8 text-[13px]" role="alert" style={{ color: "var(--signal-strong)" }}>
              Não deu para carregar a fila. Ela tenta de novo sozinha a cada minuto.
            </div>
          ) : visiveis.length === 0 && visao === "lista" ? (
            <CockpitEmptyState
              glyph="/00"
              text={todas.length === 0 ? "Nenhuma nota parada com a Operação." : "Nenhum item com esses filtros."}
            />
          ) : visao !== "lista" ? (
            <KanbanOperacao
              agrupamento={visao}
              linhas={visiveis}
              agoraMs={agoraMs}
              sessao={sessao}
              codigosLiberados={codigosLiberados}
              selecionadoId={itemId ?? null}
              onAbrir={abrir}
            />
          ) : (
            <ListaFilaOperacao
              linhas={visiveis}
              agoraMs={agoraMs}
              selecionadoId={itemId ?? null}
              meuMembroId={membro?.id ?? null}
              codigosLiberados={codigosLiberados}
              onSelecionar={abrir}
            />
          )}
        </div>
        {itemId && (
          <aside className="min-h-0 overflow-y-auto border-l border-rule bg-surface" aria-label="Detalhe do item">
            <DetalheItemOperacao key={itemId} itemId={itemId} sessao={sessao} agoraMs={agoraMs} onFechar={fechar} />
          </aside>
        )}
      </div>
    </div>
  );
}

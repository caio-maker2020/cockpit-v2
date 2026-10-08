// =============================================================================
// Tela da Operação (ADR 0041): a fila dela, o detalhe e o lançamento no SSW
// pelo clique humano sobre a prévia. Rota /operacao e /operacao/:itemId.
// =============================================================================
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ArrowDownUp, Columns3, List, Loader2, PowerOff } from "lucide-react";

import { CockpitEmptyState } from "@/components/cockpit";
import { AgentePrincipal, Conselheiro, Especialistas, FaixaFoco, RegistroDoTurno, RegrasDaSal } from "@/components/operacao/TorreOperacao";
import { DetalheItemOperacao } from "@/components/operacao/DetalheItemOperacao";
import { FiltrosFilaOperacao } from "@/components/operacao/FiltrosFilaOperacao";
import { KanbanFluxo } from "@/components/operacao/KanbanFluxo";
import { KanbanOperacao } from "@/components/operacao/KanbanOperacao";
import { ListaFilaOperacao } from "@/components/operacao/ListaFilaOperacao";
import { useAreas, useOpApi, useOpSessao } from "@/contexts/OperacaoContext";
import { useRealtimeTable } from "@/hooks/useRealtimeTable";
import { usePersistentState } from "@/hooks/usePersistentState";
import {
  FILTROS_PADRAO,
  filtrarFila,
  opcoesDaFila,
  ordenarPorTempoParado,
  type FiltrosFila,
} from "@/lib/operacao/fila";
import { avisosDoConselheiro, casaFoco, notasAlertadas, registroDoTurno, resumirTorre, type FocoTorre } from "@/lib/operacao/torre";
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
  // 08/10: a visão principal segue o MESMO fluxo da torre (dúvida → firme → segue → conselheiro → enviadas).
  const [visao, setVisao] = usePersistentState<"fluxo" | "problema" | "andamento" | "lista">("operacao.visao.v3", "fluxo");

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
  // Foco vindo da torre (especialista, regra, aviso do conselheiro): só recorta a fila, não grava nada.
  const [foco, setFoco] = useState<FocoTorre>(null);
  const trabalhoRef = useRef<HTMLElement>(null);
  const focar = (f: FocoTorre) => {
    setFoco(f);
    if (f) requestAnimationFrame(() => trabalhoRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  const visiveis = useMemo(
    () => ordenarPorTempoParado(filtrarFila(todas, filtros, { membro, agoraMs }).filter((l) => casaFoco(l, foco)), agoraMs, direcao),
    [todas, filtros, membro, agoraMs, direcao, foco],
  );
  const resumo = useMemo(() => resumirTorre(todas, agoraMs, codigosLiberados), [todas, agoraMs, codigosLiberados]);
  const avisos = useMemo(() => avisosDoConselheiro(todas, agoraMs), [todas, agoraMs]);
  const alertadas = useMemo(() => notasAlertadas(avisos), [avisos]);
  const eventos = useMemo(() => registroDoTurno(todas, resumo), [todas, resumo]);
  // Celular: abrir uma nota leva a tela até o painel dela.
  useEffect(() => {
    if (itemId && window.matchMedia?.("(max-width: 1023px)").matches) trabalhoRef.current?.scrollIntoView({ block: "start" });
  }, [itemId]);

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
    <div className="h-full overflow-y-auto" data-testid="torre-operacao">
      <AgentePrincipal resumo={resumo} papel={papel} avisos={avisos.length}>
        {(areas.ehGestor || membro?.papel_op === "supervisor_op") && (
          <Link
            to="/operacao/espelho"
            className="ml-auto rounded-full border px-2.5 py-0.5 text-[11.5px] font-semibold"
            style={{ borderColor: "#6D28D9", color: "#6D28D9" }}
          >
            Espelho do Relacionamento →
          </Link>
        )}
      </AgentePrincipal>

      {(api.modo === "demo" || (!areas.telaLigada && areas.ehGestor) || (sessao?.flags && !sessao.flags.operacao_lancar_ssw) || (membro && !membro.pode_lancar)) && (
        <div className="space-y-1 border-b border-rule px-5 py-2.5 md:px-7">
          {api.modo === "demo" && (
            <p className="text-[12px] font-semibold" style={{ color: "#6D28D9" }} data-testid="origem-demo">
              {api.origemDados === "v3"
                ? "Fila real da Operação, lida agora do SSW (só leitura). Assumir, confirmar e encaminhar ficam só neste navegador: nada é lançado no SSW nem enviado ao Relacionamento."
                : api.origemDados === "fixture"
                  ? "Demonstração com a fila real do arquivo local. Nada vai ao banco nem ao SSW."
                  : `Demonstração com dados fictícios${api.avisoOrigem ? ` (${api.avisoOrigem})` : ""}. Nada vai ao banco nem ao SSW.`}
            </p>
          )}
          {!areas.telaLigada && areas.ehGestor && (
            <p className="text-[12px] font-semibold" style={{ color: "var(--warning)" }}>
              A tela está desligada para os membros. Você vê como gestor.
            </p>
          )}
          {sessao?.flags && !sessao.flags.operacao_lancar_ssw && (
            <p className="text-[12px] font-semibold" style={{ color: "var(--warning)" }}>
              O lançamento no SSW está desligado: dá para ver e assumir, mas não lançar.
            </p>
          )}
          {membro && !membro.pode_lancar && (
            <p className="text-[12px] font-semibold" style={{ color: "var(--warning)" }}>
              Seu acesso é só de leitura.
            </p>
          )}
        </div>
      )}

      {todas.length > 0 && (
        <div className="grid items-start gap-5 px-5 py-5 md:px-7 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(300px,360px)_minmax(0,1fr)]">
            <RegrasDaSal resumo={resumo} foco={foco} onFoco={focar} />
            <Especialistas resumo={resumo} foco={foco} onFoco={focar} />
          </div>
          <Conselheiro avisos={avisos} foco={foco} onFoco={focar} demo={api.modo === "demo"} />
        </div>
      )}

      <section ref={trabalhoRef} aria-labelledby="trabalho-titulo" className="scroll-mt-2 border-t border-rule">
      <div className="px-5 pt-4 md:px-7">
        <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-mute">Trabalho do dia</div>
        <h2 id="trabalho-titulo" className="mt-1 text-[17px] font-semibold text-ink-2">
          As notas, no mesmo fluxo da torre
        </h2>
        <FaixaFoco foco={foco} onLimpar={() => setFoco(null)} visiveis={visiveis.length} />
      </div>
      {/* Filtros */}
      <div className="border-b border-rule px-5 pb-3 pt-3 md:px-7">
        <FiltrosFilaOperacao
          filtros={filtros}
          onChange={setFiltros}
          ocs={opcoes.ocs}
          cidades={opcoes.cidades}
          temUnidades={(membro?.unidades.length ?? 0) > 0}
        />
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12.5px] text-ink-mute">
          <span data-testid="contagem-fila" className="tabular">
            {visiveis.length} de {todas.length}
          </span>
          <button
            type="button"
            onClick={() => setDirecao(direcao === "mais_parado" ? "menos_parado" : "mais_parado")}
            className="inline-flex items-center gap-1 hover:text-ink-2"
          >
            <ArrowDownUp className="h-3.5 w-3.5" />
            {direcao === "mais_parado" ? "Mais parado primeiro" : "Menos parado primeiro"}
          </button>
          {isFetching && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          <div className="ml-auto inline-flex rounded-[10px] bg-[var(--bg-muted)] p-0.5" role="group" aria-label="Visão">
            {(["fluxo", "problema", "andamento", "lista"] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={visao === v}
                onClick={() => setVisao(v)}
                className={cn(
                  "inline-flex h-7 items-center gap-1 rounded-[8px] px-2.5 text-[12.5px] font-medium transition-colors",
                  visao === v ? "bg-surface text-ink-2 shadow-[0_1px_2px_rgba(27,36,48,0.12)]" : "text-ink-soft-2 hover:text-ink-2",
                )}
              >
                {v === "lista" ? <List className="h-3.5 w-3.5" /> : <Columns3 className="h-3.5 w-3.5" />}
                {v === "fluxo" ? "Fluxo da torre" : v === "problema" ? "Por família" : v === "andamento" ? "Por andamento" : "Lista"}
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
      <div className={cn("grid h-[78vh] min-h-[560px]", itemId && "lg:grid-cols-[minmax(0,1fr),minmax(400px,480px)]")}>
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
          ) : visao === "fluxo" ? (
            <KanbanFluxo
              linhas={visiveis}
              agoraMs={agoraMs}
              sessao={sessao}
              codigosLiberados={codigosLiberados}
              alertadas={alertadas}
              selecionadoId={itemId ?? null}
              onAbrir={abrir}
            />
          ) : visao !== "lista" ? (
            <KanbanOperacao
              agrupamento={visao as "problema" | "andamento"}
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
      </section>

      <RegistroDoTurno eventos={eventos} />
    </div>
  );
}

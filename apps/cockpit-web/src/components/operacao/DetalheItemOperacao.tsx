// =============================================================================
// Detalhe de um item da fila da Operação: fatos, assumir, sugestão, lançar
// ocorrência (SEMPRE pela prévia → confirmação), cancelar e histórico.
// =============================================================================
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { AlertTriangle, ArrowLeft, ChevronDown, ChevronLeft, ChevronRight, Clock, Eye, Forward, Hand, Loader2, Lock, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useOpApi } from "@/contexts/OperacaoContext";
import { ehFalhaOp } from "@/lib/operacao/api";
import { mensagemErroOp } from "@/lib/operacao/erros";
import {
  formatarDuracao,
  lancamentoAtivo,
  rotuloCidade,
  situacaoPrazo,
  tempoParadoMs,
} from "@/lib/operacao/fila";
import type { OpCodigo, OpEvento, OpFalha, OpLancamento, OpSessao } from "@/lib/operacao/tipos";
import {
  acaoDaSugestao,
  fonteDaSugestao,
  frase,
  motivoSugestaoSoRegistro,
  nivelCerteza,
  porQueSugestao,
  ROTULO_CERTEZA,
  sugereAguardar,
  sugereEncaminhar,
  sugestaoFirme,
  sugestaoLancavel,
  textoAguardar,
} from "@/lib/operacao/sugestao";
import { familiaDaOc, familiaPorId } from "@/lib/operacao/familias";
import type { AvisoConselheiro } from "@/lib/operacao/torre";
import { dotClass } from "@/components/cockpit/tones";
import { cn } from "@/lib/utils";
import { ChipStatusLancamento, TempoParado } from "./ChipsOperacao";
import { useFluxoLancamento } from "./useFluxoLancamento";

const TEXTO_MIN = 10;
const TEXTO_MAX = 400;

const ROTULO_EVENTO: Record<string, string> = {
  ItemMaterializado: "Entrou na fila (Bastão)",
  ItemAtualizado: "Atualizado pelo Bastão",
  ItemEncerrado: "Saiu da fila",
  ItemAssumido: "Assumido",
  SugestaoGerada: "Sugestão gerada",
  LancamentoSolicitado: "Lançamento pedido",
  SugestaoAceita: "Sugestão aceita",
  LancamentoCancelado: "Pedido cancelado",
  LancamentoLancadoNoSsw: "Lançado no SSW",
  LancamentoRecusado: "SSW recusou",
  LancamentoErro: "Erro no lançamento",
  LancamentoExpirado: "Expirou na fila",
  LancamentoConfirmado: "Lançamento confirmado",
  LancamentoNaoConfirmado: "Lançamento não confirmado",
  LoopMaterializacaoBloqueado: "Reentrada bloqueada (anti-loop)",
  EncaminhamentoAgendado: "Encaminhamento agendado (automático)",
  EncaminhadoAoRelacionamento: "Encaminhada ao Relacionamento",
  EncaminhadoAoEspelho: "Encaminhada ao espelho do Relacionamento",
  EncaminhamentoDesfeito: "Encaminhamento desfeito",
  EncaminhamentoCancelado: "Encaminhamento cancelado",
};

const quando = (iso: string | null | undefined) => (iso ? format(new Date(iso), "dd/MM HH:mm") : "—");

function Fato({ rotulo, children }: { rotulo: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11.5px] text-ink-mute">{rotulo}</div>
      <div className="mt-0.5 break-words text-[13.5px] text-ink-2">{children}</div>
    </div>
  );
}

function Secao({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-rule px-5 py-4 md:px-6">
      <h3 className="mb-3 text-[14px] font-semibold text-ink-2">{titulo}</h3>
      {children}
    </section>
  );
}

/** Seção que abre e fecha (o que não é o caminho principal da nota). */
function Recolhivel({ titulo, aberta = false, children, testid }: { titulo: string; aberta?: boolean; children: React.ReactNode; testid?: string }) {
  return (
    <details open={aberta} className="group border-t border-rule" data-testid={testid}>
      <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-3.5 text-[14px] font-semibold text-ink-2 hover:bg-[var(--bg-subtle)] md:px-6 [&::-webkit-details-marker]:hidden">
        {titulo}
        <ChevronDown className="h-4 w-4 text-ink-mute transition-transform duration-150 group-open:rotate-180" aria-hidden />
      </summary>
      <div className="px-5 pb-4 md:px-6">{children}</div>
    </details>
  );
}

const COR_CERTEZA = { alta: "var(--positive)", media: "var(--warning)", baixa: "var(--signal)" } as const;
const SEGMENTOS = { alta: 3, media: 2, baixa: 1 } as const;

function Aviso({ tom = "neutro", children }: { tom?: "neutro" | "erro"; children: React.ReactNode }) {
  return (
    <div
      role={tom === "erro" ? "alert" : "status"}
      className="rounded-[10px] border px-3 py-2 text-[12.5px] leading-snug"
      style={
        tom === "erro"
          ? { background: "var(--signal-soft)", borderColor: "var(--signal-border)", color: "var(--signal-strong)" }
          : { background: "var(--bg-subtle)", borderColor: "var(--c-border)", color: "var(--c-ink-soft)" }
      }
    >
      {children}
    </div>
  );
}

export function DetalheItemOperacao({
  itemId,
  sessao,
  agoraMs,
  onFechar,
  aviso = null,
  posicao = null,
  onAnterior,
  onProxima,
  onConcluido,
}: {
  itemId: string;
  sessao: OpSessao | null;
  agoraMs: number;
  onFechar: () => void;
  /** O conselheiro alertou esta nota: aparece aqui, no contexto dela. */
  aviso?: AvisoConselheiro | null;
  /** "3 de 90" na ordem do fluxo (j/k). */
  posicao?: { atual: number; total: number } | null;
  onAnterior?: () => void;
  onProxima?: () => void;
  /** Depois de confirmar (lançar ou encaminhar): ir para a próxima nota sem voltar à fila. */
  onConcluido?: () => void;
}) {
  const api = useOpApi();
  const qc = useQueryClient();
  const membro = sessao?.membro ?? null;
  const ehSupervisor = membro?.papel_op === "supervisor_op";

  const { data, isLoading, error } = useQuery({
    queryKey: ["op", "item", itemId],
    enabled: !!api,
    queryFn: () => api!.itemDetalhe(itemId),
  });
  // O que a Operação pode saber do encaminhamento: o status do pedido, nunca o card (D11).
  const { data: encResp } = useQuery({
    queryKey: ["op", "item", itemId, "encaminhamentos"],
    enabled: !!api,
    queryFn: () => api!.encaminhamentosDoItem(itemId),
  });
  const [textoEnc, setTextoEnc] = useState("");
  const [erroEnc, setErroEnc] = useState<string | null>(null);

  const [codigo, setCodigo] = useState<number | null>(null);
  const [texto, setTexto] = useState("");
  const [erroForm, setErroForm] = useState<string | null>(null);
  const [erroAcao, setErroAcao] = useState<string | null>(null);
  const [podeForcar, setPodeForcar] = useState(false);
  const [ocupadoLocal, setOcupado] = useState<null | "assumir" | "cancelar">(null);
  const fluxo = useFluxoLancamento({
    onLancado: () => {
      setCodigo(null);
      setTexto("");
      onConcluido?.();
    },
    onEncaminhado: () => onConcluido?.(),
  });
  const ocupado: null | "assumir" | "cancelar" | "previa" | "enviar" =
    ocupadoLocal ?? (fluxo.carregandoPrevia ? "previa" : fluxo.ocupado ? "enviar" : null);

  const atualizar = () => qc.invalidateQueries({ queryKey: ["op"] });

  if (!api || isLoading) {
    return (
      <div className="flex items-center gap-2 p-6 text-[13px] text-ink-mute">
        <Loader2 className="h-4 w-4 animate-spin" /> Abrindo a nota…
      </div>
    );
  }
  if (error || !data || ehFalhaOp(data)) {
    const msg = error ? mensagemErroOp({ erro: "falha_de_comunicacao" }) : mensagemErroOp(data as OpFalha);
    return (
      <div className="p-6">
        <Aviso tom="erro">{msg}</Aviso>
        <Button variant="outline" className="mt-4" onClick={onFechar}>
          Voltar para a fila
        </Button>
      </div>
    );
  }

  const { item, eventos, lancamentos } = data;
  const encaminhamentosItem = encResp && !ehFalhaOp(encResp) ? encResp.encaminhamentos : [];
  const agendado = encaminhamentosItem.find((e) => e.status === "agendado");
  const enviado = encaminhamentosItem.find((e) => e.status === "enviado" || e.status === "espelhado");
  const fechado = item.status === "encerrado";
  const sugEncaminhar = sugereEncaminhar(item.sugestao);
  const sugAguardar = sugereAguardar(item.sugestao);
  const motivoSemEncaminhar: string | null = !membro
    ? "Você vê a fila como gestor. Só membros da Operação encaminham."
    : !membro.pode_lancar
      ? mensagemErroOp({ erro: "sem_permissao_de_lancar" })
      : null;
  const codigos: OpCodigo[] = data.codigos_disponiveis ?? [];
  const ativo: OpLancamento | undefined = lancamentos.find((l) => lancamentoAtivo(l.status));
  const meu = !!membro && item.assumido_por === membro.id;
  const lancarLigado = !!sessao?.flags?.operacao_lancar_ssw;
  const motivoSemLancar: string | null = !membro
    ? "Você vê a fila como gestor. Só membros da Operação lançam ocorrências."
    : !membro.pode_lancar
      ? mensagemErroOp({ erro: "sem_permissao_de_lancar" })
      : !lancarLigado
        ? mensagemErroOp({ erro: "lancamento_desligado" })
        : null;
  const codigoSel = codigos.find((c) => c.codigo === codigo) ?? null;
  const exigeTexto = !!codigoSel?.exige_texto;
  const textoLimpo = texto.trim();
  const prazo = situacaoPrazo(item, agoraMs);
  const familia = familiaPorId(familiaDaOc(item.cod_ultima_ocorrencia));
  const nivel = nivelCerteza(item.sugestao);
  const firme = sugestaoFirme(item.sugestao);
  const descCodigo = (c: number | null | undefined) => codigos.find((x) => x.codigo === c)?.descricao ?? null;

  async function assumir(forcar: boolean) {
    setErroAcao(null);
    setOcupado("assumir");
    try {
      const r = await api!.assumir(item.id, forcar);
      if (ehFalhaOp(r)) {
        setErroAcao(mensagemErroOp(r));
        setPodeForcar(r.erro === "assumido_por_outro" && ehSupervisor);
        if (r.erro === "item_fechado") atualizar();
        return;
      }
      setPodeForcar(false);
      toast.success(r.ja_era_seu ? "Este item já estava com você." : "Item assumido. Agora ele é seu.");
      atualizar();
    } finally {
      setOcupado(null);
    }
  }

  async function abrirPrevia(origem: "manual" | "sugestao", cod: number, txt: string) {
    setErroForm(null);
    const erro = await fluxo.abrirPrevia(item.id, origem, cod, txt);
    if (erro) setErroForm(erro);
  }

  function verPreviaManual() {
    if (codigo == null) {
      setErroForm("Escolha o código da ocorrência.");
      return;
    }
    if (exigeTexto && textoLimpo.length < TEXTO_MIN) {
      setErroForm(mensagemErroOp({ erro: "texto_obrigatorio" }));
      return;
    }
    if (textoLimpo.length > TEXTO_MAX) {
      setErroForm(mensagemErroOp({ erro: "texto_longo" }));
      return;
    }
    void abrirPrevia("manual", codigo, textoLimpo);
  }

  async function verPreviaEncaminhamento(texto: string) {
    setErroEnc(null);
    const erro = await fluxo.abrirPreviaEncaminhamento(item.id, texto);
    if (erro) setErroEnc(erro);
  }

  async function desfazer(id: string) {
    setErroAcao(null);
    const erro = await fluxo.desfazerEncaminhamento(id);
    if (erro) setErroAcao(erro);
  }

  async function cancelar(l: OpLancamento) {
    setErroAcao(null);
    setOcupado("cancelar");
    try {
      const r = await api!.cancelar(l.id);
      if (ehFalhaOp(r)) {
        setErroAcao(mensagemErroOp(r));
        atualizar();
        return;
      }
      toast.success("Pedido cancelado. Nada foi enviado ao SSW.");
      atualizar();
    } finally {
      setOcupado(null);
    }
  }

  return (
    <div className="flex min-h-0 flex-col" data-testid="detalhe-item-operacao">
      {/* Cabeçalho: onde a nota está no fluxo, e as setas para a próxima (j/k) */}
      <div className="sticky top-0 z-10 border-b border-rule bg-surface/95 px-5 pb-3 pt-4 backdrop-blur md:px-6">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onFechar}
            aria-label="Voltar para a fila"
            className="-ml-1.5 grid h-8 w-8 shrink-0 place-items-center rounded-[8px] text-ink-mute hover:bg-[var(--bg-subtle)] hover:text-ink-2 lg:hidden"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <span className="inline-flex min-w-0 items-center gap-1.5 text-[12px] font-medium text-ink-soft-2">
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotClass[familia.tom])} aria-hidden />
            <span className="truncate">{familia.titulo}</span>
          </span>
          <div className="ml-auto flex items-center gap-0.5">
            {posicao && (
              <span className="tabular mr-1 text-[12px] text-ink-mute" data-testid="posicao-nota">
                {posicao.atual} de {posicao.total}
              </span>
            )}
            <button
              type="button"
              onClick={onAnterior}
              disabled={!onAnterior}
              aria-label="Nota anterior (k)"
              className="grid h-8 w-8 place-items-center rounded-[8px] text-ink-soft-2 hover:bg-[var(--bg-subtle)] disabled:opacity-30"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onProxima}
              disabled={!onProxima}
              aria-label="Próxima nota (j)"
              className="grid h-8 w-8 place-items-center rounded-[8px] text-ink-soft-2 hover:bg-[var(--bg-subtle)] disabled:opacity-30"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onFechar}
              aria-label="Fechar detalhe"
              className="hidden h-8 w-8 place-items-center rounded-[8px] text-ink-mute hover:bg-[var(--bg-subtle)] hover:text-ink-2 lg:grid"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <h2 className="mt-1 text-[22px] font-semibold leading-tight text-ink-2" style={{ letterSpacing: "-0.01em" }}>
          {item.nf ? `NF ${item.nf}` : `CTRC ${item.ctrc}`}
        </h2>
        <div className="text-[12.5px] text-ink-soft-2">
          {item.nf ? `CTRC ${item.ctrc} · ` : ""}base {item.unidade ?? "sem filial"}
        </div>
      </div>

      {aviso && !fechado && (
        <div className="px-5 pt-4 md:px-6" data-testid="aviso-conselheiro-detalhe">
          <div
            className="flex items-start gap-2 rounded-[12px] border px-3 py-2.5"
            style={
              aviso.tom === "critico"
                ? { background: "var(--signal-softer)", borderColor: "var(--signal-border)" }
                : { background: "var(--warning-soft)", borderColor: "var(--warning-border)" }
            }
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" style={{ color: aviso.tom === "critico" ? "var(--signal-strong)" : "var(--warning)" }} aria-hidden />
            <div className="min-w-0 text-[12.5px] leading-snug">
              <div className="font-semibold text-ink-2">Conselheiro: {aviso.titulo.charAt(0).toLowerCase() + aviso.titulo.slice(1)}</div>
              <p className="mt-0.5 text-ink-soft-2">{aviso.detalhe}</p>
            </div>
          </div>
        </div>
      )}

      {/* Encaminhada: saiu da fila; aqui fica só como evento (D11) */}
      {fechado && (
        <div className="px-5 pb-4 md:px-6" data-testid="item-encerrado">
          <Aviso>
            {item.motivo_encerramento === "encaminhado_relacionamento"
              ? `Encaminhada ao Relacionamento${enviado?.enviado_em ? ` às ${quando(enviado.enviado_em)}` : ""}. Saiu da fila da Operação.`
              : item.motivo_encerramento === "encaminhado_espelho"
                ? `Encaminhada ao espelho do Relacionamento${enviado?.enviado_em ? ` às ${quando(enviado.enviado_em)}` : ""}. Não chegou ao Cockpit real; saiu da fila da Operação.`
                : "Este item saiu da fila da Operação."}
            {enviado?.pedido_status ? ` Pedido: ${enviado.pedido_status}.` : ""}
          </Aviso>
        </div>
      )}

      {/* Encaminhamento automático agendado: dá para desfazer até a hora */}
      {agendado && !fechado && (
        <div className="px-5 pb-4 md:px-6" data-testid="encaminhamento-agendado-detalhe">
          <div className="rounded-[12px] border px-3 py-3 text-[13px]" style={{ borderColor: "var(--encaminhar-border)", background: "var(--encaminhar-soft)" }}>
            <div className="font-semibold" style={{ color: "var(--encaminhar)" }}>
              Encaminhamento ao Relacionamento agendado para {quando(agendado.executar_apos)}
              {agendado.origem === "auto" ? " (automático)" : ""}
            </div>
            <div className="mt-1 text-ink-soft-2">“{agendado.texto}”</div>
            {membro && (
              <Button size="sm" variant="outline" className="mt-2" onClick={() => desfazer(agendado.id)}>
                Desfazer encaminhamento
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Assumir */}
      {membro && !meu && !fechado && (
        <div className="flex flex-wrap items-center gap-2 px-5 pb-4 md:px-6">
          <Button size="sm" variant="outline" onClick={() => assumir(false)} disabled={ocupado !== null}>
            {ocupado === "assumir" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Hand className="mr-2 h-4 w-4" />}
            Assumir
          </Button>
          {podeForcar && (
            <Button size="sm" variant="outline" onClick={() => assumir(true)} disabled={ocupado !== null}>
              Assumir mesmo assim (supervisão)
            </Button>
          )}
        </div>
      )}
      {erroAcao && (
        <div className="px-5 pb-4 md:px-6">
          <Aviso tom="erro">{erroAcao}</Aviso>
        </div>
      )}

      {/* Lançamento em andamento */}
      {ativo && (
        <Secao titulo="Pedido em andamento no SSW">
          <div className="flex flex-wrap items-center gap-2">
            <ChipStatusLancamento status={ativo.status} codigo={ativo.codigo_oc} />
            <span className="text-[12px] text-ink-soft-2">
              pedido por {ativo.solicitado_por_nome} às {quando(ativo.solicitado_em)}
            </span>
          </div>
          <p className="mt-2 whitespace-pre-wrap text-[12.5px] text-ink-2">{ativo.texto_ssw}</p>
          {ativo.status === "fila" && membro && (
            <Button size="sm" variant="outline" className="mt-3" onClick={() => cancelar(ativo)} disabled={ocupado !== null}>
              {ocupado === "cancelar" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Cancelar pedido
            </Button>
          )}
          {ativo.status !== "fila" && (
            <p className="mt-2 text-[11.5px] text-ink-mute">
              Já saiu da fila para o SSW. A confirmação vem pela próxima leitura da ocorrência.
            </p>
          )}
        </Secao>
      )}

      {/* Sugestão da torre: regra firme → 1 clique; dúvida → você decide */}
      {item.sugestao && acaoDaSugestao(item.sugestao) && !fechado && (
        <Secao titulo="O que a torre sugere">
          <div
            className="rounded-[14px] border p-3.5"
            style={{ borderColor: sugEncaminhar ? "var(--encaminhar-border)" : "var(--c-border)", background: firme ? "var(--bg-subtle)" : undefined }}
            data-testid="sugestao-detalhe"
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] font-medium">
              <span className="text-ink-soft-2">
                {fonteDaSugestao(item.sugestao) === "agente_ia" ? "Analisada pelo agente" : "Regra da Sal"} · {firme ? "firme" : "dúvida"}
              </span>
              {nivel && (
                <span className="inline-flex items-center gap-1.5" style={{ color: COR_CERTEZA[nivel] }}>
                  <span className="inline-flex gap-0.5" aria-hidden>
                    {[1, 2, 3].map((i) => (
                      <span key={i} className="h-1.5 w-3 rounded-full" style={{ background: i <= SEGMENTOS[nivel] ? COR_CERTEZA[nivel] : "var(--bg-muted)" }} />
                    ))}
                  </span>
                  {ROTULO_CERTEZA[nivel]}
                </span>
              )}
            </div>
            <div className="mt-2 flex items-start gap-2">
              {sugAguardar ? (
                <Clock className="mt-0.5 h-4 w-4 shrink-0 text-ink-mute" aria-hidden />
              ) : sugEncaminhar ? (
                <Forward className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--encaminhar)" }} aria-hidden />
              ) : (
                <Eye className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--signal)" }} aria-hidden />
              )}
              <div className="min-w-0 text-[13.5px] text-ink-2">
                <div className="font-semibold leading-snug">
                  {sugAguardar
                    ? textoAguardar(item.sugestao)
                    : sugEncaminhar
                      ? "Encaminhar ao Relacionamento"
                      : `Lançar a ocorrência ${item.sugestao.codigo}${descCodigo(item.sugestao.codigo) ? ` · ${descCodigo(item.sugestao.codigo)}` : ""}`}
                </div>
                <div className="mt-0.5 text-[12px] text-ink-soft-2">
                  {sugAguardar
                    ? "Nada a fazer agora: a nota segue sozinha."
                    : sugEncaminhar
                      ? "A nota sai da Operação e vira card no Relacionamento."
                      : "Vai para o SSW só depois da prévia e da sua confirmação."}
                </div>
                {item.sugestao.texto && !sugAguardar && !sugEncaminhar && (
                  <div className="mt-1.5 rounded-[8px] bg-surface px-2.5 py-1.5 text-[12.5px] text-ink-2">“{frase(item.sugestao.texto)}”</div>
                )}
                {porQueSugestao(item.sugestao) && <div className="mt-1.5 text-[12px] text-ink-mute">Por quê: {porQueSugestao(item.sugestao)}</div>}
              </div>
            </div>
            {sugAguardar ? null : sugEncaminhar ? (
              <Button
                className="mt-3 w-full text-white hover:opacity-90 sm:w-auto"
                style={{ background: "var(--encaminhar-botao)" }}
                disabled={ocupado !== null || !!motivoSemEncaminhar || !!ativo || !!agendado}
                onClick={() => verPreviaEncaminhamento("")}
              >
                {ocupado === "previa" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Forward className="mr-2 h-4 w-4" />}
                Encaminhar ao Relacionamento
              </Button>
            ) : sugestaoLancavel(item.sugestao, new Set(codigos.map((c) => c.codigo)), item.cod_ultima_ocorrencia) ? (
              <Button
                className="mt-3 w-full bg-sal text-white hover:bg-sal/90 sm:w-auto"
                disabled={ocupado !== null || !!motivoSemLancar || !!ativo}
                onClick={() => abrirPrevia("sugestao", item.sugestao!.codigo as number, item.sugestao!.texto ?? "")}
              >
                {ocupado === "previa" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Eye className="mr-2 h-4 w-4" />}
                Aceitar sugestão
              </Button>
            ) : (
              <p className="mt-2 text-[12px] text-ink-mute">
                {motivoSugestaoSoRegistro(item.sugestao, new Set(codigos.map((c) => c.codigo)), item.cod_ultima_ocorrencia)}
              </p>
            )}
            {(motivoSemLancar || motivoSemEncaminhar) && !sugAguardar && (
              <p className="mt-2 text-[12px] text-ink-mute">{sugEncaminhar ? motivoSemEncaminhar : motivoSemLancar}</p>
            )}
          </div>
        </Secao>
      )}

      {/* Fatos da nota (depois da decisão: o que importa primeiro é o que fazer) */}
      <Secao titulo="A nota">
      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        <div className="col-span-2">
          <Fato rotulo="Última ocorrência">
            {data.descricao_oc ? frase(data.descricao_oc) : "Sem descrição"}
            <span className="text-ink-mute"> ({item.cod_ultima_ocorrencia ?? "sem código"})</span>
          </Fato>
        </div>
        <Fato rotulo="Parada há">
          <span className="flex flex-wrap items-center gap-2">
            <TempoParado ms={tempoParadoMs(item, agoraMs)} compacto />
            <span className="text-[11.5px] text-ink-mute">desde {quando(item.data_ultima_ocorrencia)}</span>
          </span>
        </Fato>
        <Fato rotulo="Prazo">
          <span style={{ color: prazo.atrasado ? "var(--signal-strong)" : undefined }}>{prazo.texto}</span>
        </Fato>
        {item.instrucao_ultima_ocorrencia && (
          <div className="col-span-2">
            <Fato rotulo="Instrução da última ocorrência">{item.instrucao_ultima_ocorrencia}</Fato>
          </div>
        )}
        <Fato rotulo="Destinatário">{item.destinatario ?? "—"}</Fato>
        <Fato rotulo="Cidade">{rotuloCidade(item) ?? "—"}</Fato>
        <Fato rotulo="Pagador">{item.pagador ?? "—"}</Fato>
        <Fato rotulo="Volumes">{item.qtd_volumes ?? "—"}</Fato>
        <Fato rotulo="Com quem">
          {item.assumido_por_nome ? (meu ? "Com você" : item.assumido_por_nome) : "Ninguém assumiu"}
        </Fato>
      </div>
      </Secao>

      {/* Lançar ocorrência */}
      {!fechado && (
      <Recolhivel
        titulo={item.sugestao && acaoDaSugestao(item.sugestao) ? "Lançar outra ocorrência" : "Lançar ocorrência no SSW"}
        aberta={!firme}
        testid="lancar-manual"
      >
        {codigos.length === 0 ? (
          <div className="rounded-lg border border-dashed border-rule px-4 py-5 text-center" data-testid="sem-codigos">
            <Lock className="mx-auto h-5 w-5 text-ink-mute" aria-hidden />
            <p className="mt-2 text-[13px] font-semibold text-ink-2">A Operação ainda não liberou códigos para lançamento</p>
            <p className="mt-1 text-[12px] text-ink-mute">Quando um código for liberado, ele aparece aqui para você escolher.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {motivoSemLancar && <Aviso>{motivoSemLancar}</Aviso>}
            {ativo && !motivoSemLancar && <Aviso>{mensagemErroOp({ erro: "lancamento_em_andamento" })}</Aviso>}
            <div>
              <label htmlFor={`codigo-${item.id}`} className="mb-1 block text-[12px] font-semibold text-ink-2">
                Código
              </label>
              <select
                id={`codigo-${item.id}`}
                value={codigo ?? ""}
                onChange={(e) => {
                  setCodigo(e.target.value === "" ? null : Number(e.target.value));
                  setErroForm(null);
                }}
                disabled={!!motivoSemLancar || !!ativo}
                className="h-10 w-full rounded-[10px] border border-rule bg-surface px-3 text-[13px] text-ink-2 disabled:opacity-50"
              >
                <option value="">Escolha o código…</option>
                {codigos.map((c) => (
                  <option key={c.codigo} value={c.codigo} disabled={c.codigo === item.cod_ultima_ocorrencia}>
                    {c.descricao} ({c.codigo})
                    {c.exige_texto ? " (exige texto)" : ""}
                    {c.codigo === item.cod_ultima_ocorrencia ? " (já é a atual)" : ""}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={`texto-${item.id}`} className="mb-1 block text-[12px] font-semibold text-ink-2">
                Texto {exigeTexto ? <span style={{ color: "var(--signal-strong)" }}>(obrigatório, mín. {TEXTO_MIN})</span> : <span className="font-normal text-ink-mute">(opcional)</span>}
              </label>
              <Textarea
                id={`texto-${item.id}`}
                value={texto}
                onChange={(e) => {
                  setTexto(e.target.value);
                  setErroForm(null);
                }}
                disabled={!!motivoSemLancar || !!ativo}
                rows={3}
                maxLength={TEXTO_MAX + 50}
                placeholder="O que aconteceu, com as suas palavras. Vai na Instrução do SSW."
                className="text-[13px]"
              />
              <div className="mt-1 flex justify-between text-[11px] text-ink-mute">
                <span>O SSW recebe o seu texto + “(Operação {item.unidade ?? ""} por {membro?.nome ?? "você"})”.</span>
                <span className="tabular" style={{ color: textoLimpo.length > TEXTO_MAX ? "var(--signal-strong)" : undefined }}>
                  {textoLimpo.length}/{TEXTO_MAX}
                </span>
              </div>
            </div>
            {erroForm && <Aviso tom="erro">{erroForm}</Aviso>}
            <Button
              onClick={verPreviaManual}
              disabled={ocupado !== null || !!motivoSemLancar || !!ativo}
              className="w-full sm:w-auto"
            >
              {ocupado === "previa" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Eye className="mr-2 h-4 w-4" />}
              Ver prévia do lançamento
            </Button>
          </div>
        )}
      </Recolhivel>
      )}

      {/* Encaminhar ao Relacionamento (manual) */}
      {!fechado && (
        <Recolhivel titulo="Encaminhar ao Relacionamento" aberta={!item.sugestao}>
          <div className="space-y-2">
            <p className="text-[12px] text-ink-soft-2">
              Quando o próximo passo é do Relacionamento (cliente a contatar, autorização, devolução). A nota sai da
              fila da Operação. A prévia mostra o destino antes de você confirmar.
            </p>
            {motivoSemEncaminhar && <Aviso>{motivoSemEncaminhar}</Aviso>}
            <label htmlFor={`texto-enc-${item.id}`} className="block text-[12px] font-semibold text-ink-2">
              Motivo do encaminhamento
            </label>
            <Textarea
              id={`texto-enc-${item.id}`}
              value={textoEnc}
              onChange={(e) => {
                setTextoEnc(e.target.value);
                setErroEnc(null);
              }}
              disabled={!!motivoSemEncaminhar || !!agendado}
              rows={2}
              maxLength={450}
              placeholder={sugEncaminhar ? "Vazio = o texto da sugestão" : "Por que o Relacionamento precisa assumir"}
              className="text-[13px]"
            />
            {erroEnc && <Aviso tom="erro">{erroEnc}</Aviso>}
            <Button
              variant="outline"
              onClick={() => verPreviaEncaminhamento(textoEnc.trim())}
              disabled={ocupado !== null || !!motivoSemEncaminhar || !!agendado}
            >
              <Forward className="mr-2 h-4 w-4" />
              Ver prévia do encaminhamento
            </Button>
          </div>
        </Recolhivel>
      )}

      {/* Histórico */}
      <Recolhivel titulo={`Histórico (${eventos.length} ${eventos.length === 1 ? "evento" : "eventos"})`}>
        {encaminhamentosItem.length > 0 && (
          <div className="mb-4">
            <div className="mb-2 text-[12px] font-semibold text-ink-2">Encaminhamentos</div>
            <ul className="space-y-2">
              {encaminhamentosItem.map((e) => (
                <li key={e.id} className="rounded-md border border-rule px-3 py-2 text-[12px]">
                  <div className="font-semibold text-ink-2">
                    {e.status === "agendado" ? "Agendado" : e.status === "enviado" ? "Enviado" : e.status === "espelhado" ? "No espelho" : e.status === "desfeito" ? "Desfeito" : "Cancelado"}
                    {" · "}
                    {e.origem === "auto" ? "automático" : e.solicitado_por_nome} · {quando(e.created_at)}
                  </div>
                  <p className="mt-1 text-ink-2">{e.texto}</p>
                  {e.motivo_fim && <p className="mt-1 text-ink-mute">{e.motivo_fim}</p>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {lancamentos.length > 0 && (
          <div className="mb-4">
            <div className="mb-2 text-[12px] font-semibold text-ink-2">Lançamentos</div>
            <ul className="space-y-2">
              {lancamentos.map((l) => (
                <li key={l.id} className="rounded-md border border-rule px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <ChipStatusLancamento status={l.status} codigo={l.codigo_oc} mostrarSemLancamento />
                    {l.status === "cancelado" && <span className="text-[11px] text-ink-mute">cancelado</span>}
                    <span className="text-[11.5px] text-ink-mute">
                      {l.solicitado_por_nome} · {quando(l.solicitado_em)}
                      {l.origem === "sugestao" ? " · pela sugestão" : ""}
                    </span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-[12px] text-ink-2">{l.texto_ssw}</p>
                  {l.detalhe && <p className="mt-1 text-[11.5px] text-ink-soft-2">{l.detalhe}</p>}
                </li>
              ))}
            </ul>
          </div>
        )}
        <ol className="relative space-y-3 border-l border-rule pl-4">
          {eventos.map((e: OpEvento) => (
            <li key={e.id} className="relative">
              <span aria-hidden className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-[var(--c-ink-mute)]" />
              <div className="text-[12.5px] text-ink-2">
                <span className="font-semibold">{ROTULO_EVENTO[e.tipo] ?? e.tipo}</span>
                {typeof e.payload?.codigo_oc === "number" ? ` · ocorrência ${e.payload.codigo_oc}` : ""}
              </div>
              <div className="text-[11px] text-ink-mute">
                {quando(e.created_at)} · {e.ator_tipo === "system" ? "sistema" : e.ator_nome ?? "membro"}
              </div>
            </li>
          ))}
          {eventos.length === 0 && <li className="text-[12px] text-ink-mute">Sem eventos.</li>}
        </ol>
        <p className="mt-3 text-[11px] text-ink-mute">Na fila desde {quando(item.created_at)} · há {formatarDuracao(Math.max(0, agoraMs - Date.parse(item.created_at)))}</p>
      </Recolhivel>

      {fluxo.dialogo}
    </div>
  );
}

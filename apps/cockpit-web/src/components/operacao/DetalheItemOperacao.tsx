// =============================================================================
// Detalhe de um item da fila da Operação: fatos, assumir, sugestão, lançar
// ocorrência (SEMPRE pela prévia → confirmação), cancelar e histórico.
// =============================================================================
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { ArrowLeft, Eye, Hand, Lightbulb, Loader2, Lock, X } from "lucide-react";
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
import type { OpCodigo, OpEvento, OpFalha, OpLancamento, OpPrevia, OpSessao } from "@/lib/operacao/tipos";
import { ChipStatusLancamento, TempoParado } from "./ChipsOperacao";
import { DialogoPreviaLancamento } from "./DialogoPreviaLancamento";

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
};

const quando = (iso: string | null | undefined) => (iso ? format(new Date(iso), "dd/MM HH:mm") : "—");

function Fato({ rotulo, children }: { rotulo: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.13em] text-ink-mute">{rotulo}</div>
      <div className="mt-0.5 break-words text-[13px] text-ink-2">{children}</div>
    </div>
  );
}

function Secao({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-rule px-5 py-4 md:px-6">
      <h3 className="mb-3 font-mono text-[9.5px] font-semibold uppercase tracking-[0.14em] text-ink-mute">{titulo}</h3>
      {children}
    </section>
  );
}

function Aviso({ tom = "neutro", children }: { tom?: "neutro" | "erro"; children: React.ReactNode }) {
  return (
    <div
      role={tom === "erro" ? "alert" : "status"}
      className="rounded-md border px-3 py-2 text-[12.5px]"
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

interface PreviaAberta {
  origem: "manual" | "sugestao";
  codigo: number;
  texto: string;
  previa: OpPrevia;
  confirmacao: string;
  aviso: string | null;
  erro: string | null;
}

export function DetalheItemOperacao({
  itemId,
  sessao,
  agoraMs,
  onFechar,
}: {
  itemId: string;
  sessao: OpSessao | null;
  agoraMs: number;
  onFechar: () => void;
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

  const [codigo, setCodigo] = useState<number | null>(null);
  const [texto, setTexto] = useState("");
  const [erroForm, setErroForm] = useState<string | null>(null);
  const [erroAcao, setErroAcao] = useState<string | null>(null);
  const [podeForcar, setPodeForcar] = useState(false);
  const [ocupado, setOcupado] = useState<null | "assumir" | "previa" | "cancelar" | "enviar">(null);
  const [previaAberta, setPreviaAberta] = useState<PreviaAberta | null>(null);
  // Trava de clique: duplo clique no "Confirmar" não manda dois pedidos (o banco também barra).
  const emVoo = useRef(false);

  const atualizar = () => qc.invalidateQueries({ queryKey: ["op"] });

  if (!api || isLoading) {
    return (
      <div className="flex items-center gap-2 p-6 text-[13px] text-ink-mute">
        <Loader2 className="h-4 w-4 animate-spin" /> Carregando item…
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
    setOcupado("previa");
    try {
      const r = await api!.previa(item.id, cod, txt);
      if (ehFalhaOp(r)) {
        setErroForm(mensagemErroOp(r));
        if (r.erro === "item_fechado" || r.erro === "lancamento_em_andamento") atualizar();
        return;
      }
      setPreviaAberta({ origem, codigo: cod, texto: txt, previa: r.previa, confirmacao: r.confirmacao, aviso: null, erro: null });
    } finally {
      setOcupado(null);
    }
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

  async function confirmar() {
    if (!previaAberta || emVoo.current) return;
    emVoo.current = true;
    setOcupado("enviar");
    try {
      const p = previaAberta;
      const r =
        p.origem === "sugestao"
          ? await api!.aceitarSugestao(item.id, p.confirmacao)
          : await api!.solicitar(item.id, p.codigo, p.texto, p.confirmacao);
      if (ehFalhaOp(r)) {
        if (r.erro === "previa_desatualizada" && r.previa && r.confirmacao) {
          // Mostra o NOVO conteúdo e exige um novo clique sobre ele.
          setPreviaAberta({ ...p, previa: r.previa, confirmacao: r.confirmacao, aviso: mensagemErroOp(r), erro: null });
        } else {
          setPreviaAberta({ ...p, aviso: null, erro: mensagemErroOp(r) });
        }
        atualizar();
        return;
      }
      setPreviaAberta(null);
      setCodigo(null);
      setTexto("");
      toast.success(`Pedido da oc ${r.previa.codigo_oc} na fila de lançamento. O status aparece aqui.`);
      atualizar();
    } finally {
      emVoo.current = false;
      setOcupado(null);
    }
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
      {/* Cabeçalho */}
      <div className="flex items-start gap-3 px-5 pb-4 pt-5 md:px-6">
        <button
          type="button"
          onClick={onFechar}
          aria-label="Voltar para a fila"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-ink-mute hover:bg-subtle hover:text-ink lg:hidden"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.14em] text-ink-mute">
            Item da fila · {item.unidade ?? "sem unidade"}
          </div>
          <h2 className="mt-1 font-mono text-[20px] font-semibold leading-tight text-ink-2">NF {item.nf ?? "—"}</h2>
          <div className="font-mono text-[12.5px] text-ink-soft-2">CTRC {item.ctrc}</div>
        </div>
        <button
          type="button"
          onClick={onFechar}
          aria-label="Fechar detalhe"
          className="hidden h-8 w-8 shrink-0 place-items-center rounded-md text-ink-mute hover:bg-subtle hover:text-ink lg:grid"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Fatos */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 px-5 pb-4 md:px-6">
        <Fato rotulo="Ocorrência atual">
          <span className="font-mono font-semibold">oc {item.cod_ultima_ocorrencia ?? "—"}</span>
          {data.descricao_oc ? ` · ${data.descricao_oc}` : ""}
        </Fato>
        <Fato rotulo="Parado há">
          <span className="flex items-center gap-2">
            <TempoParado ms={tempoParadoMs(item, agoraMs)} compacto />
            <span className="text-[11.5px] text-ink-mute">desde {quando(item.data_ultima_ocorrencia)}</span>
          </span>
        </Fato>
        {item.instrucao_ultima_ocorrencia && (
          <div className="col-span-2">
            <Fato rotulo="Instrução da última oc">{item.instrucao_ultima_ocorrencia}</Fato>
          </div>
        )}
        <Fato rotulo="Destinatário">{item.destinatario ?? "—"}</Fato>
        <Fato rotulo="Cidade">{rotuloCidade(item) ?? "—"}</Fato>
        <Fato rotulo="Pagador">{item.pagador ?? "—"}</Fato>
        <Fato rotulo="Prazo">
          <span style={{ color: prazo.atrasado ? "var(--signal-strong)" : undefined }}>{prazo.texto}</span>
        </Fato>
        <Fato rotulo="Volumes">{item.qtd_volumes ?? "—"}</Fato>
        <Fato rotulo="Com quem">
          {item.assumido_por_nome ? (meu ? "Com você" : item.assumido_por_nome) : "Ninguém assumiu"}
        </Fato>
      </div>

      {/* Assumir */}
      {membro && !meu && (
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
        <Secao titulo="Lançamento em andamento">
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

      {/* Sugestão */}
      {item.sugestao && (
        <Secao titulo="Sugestão">
          <div className="rounded-lg border px-3 py-3" style={{ borderColor: "rgba(112,72,232,0.35)" }}>
            <div className="flex items-start gap-2">
              <Lightbulb className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "#7048E8" }} aria-hidden />
              <div className="min-w-0 text-[13px] text-ink-2">
                <div>
                  <span className="font-mono font-semibold">oc {item.sugestao.codigo}</span>
                  {codigos.find((c) => c.codigo === item.sugestao!.codigo)?.descricao
                    ? ` · ${codigos.find((c) => c.codigo === item.sugestao!.codigo)!.descricao}`
                    : ""}
                </div>
                <div className="mt-1 text-ink-soft-2">“{item.sugestao.texto}”</div>
                <div className="mt-1 text-[11.5px] text-ink-mute">Por quê: {item.sugestao.motivo}</div>
              </div>
            </div>
            {item.sugestao.lancavel ? (
              <Button
                size="sm"
                className="mt-3 bg-sal text-white hover:bg-sal/90"
                disabled={ocupado !== null || !!motivoSemLancar || !!ativo}
                onClick={() => abrirPrevia("sugestao", item.sugestao!.codigo, item.sugestao!.texto ?? "")}
              >
                {ocupado === "previa" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Eye className="mr-2 h-4 w-4" />}
                Aceitar sugestão
              </Button>
            ) : (
              <p className="mt-2 text-[11.5px] text-ink-mute">
                Só registro: o código sugerido ainda não foi liberado para a Operação lançar.
              </p>
            )}
          </div>
        </Secao>
      )}

      {/* Lançar ocorrência */}
      <Secao titulo="Lançar ocorrência no SSW">
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
                    oc {c.codigo} · {c.descricao}
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
      </Secao>

      {/* Histórico */}
      <Secao titulo="Histórico">
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
                {typeof e.payload?.codigo_oc === "number" ? ` · oc ${e.payload.codigo_oc}` : ""}
              </div>
              <div className="text-[11px] text-ink-mute">
                {quando(e.created_at)} · {e.ator_tipo === "system" ? "sistema" : e.ator_nome ?? "membro"}
              </div>
            </li>
          ))}
          {eventos.length === 0 && <li className="text-[12px] text-ink-mute">Sem eventos.</li>}
        </ol>
        <p className="mt-3 text-[11px] text-ink-mute">Na fila desde {quando(item.created_at)} · há {formatarDuracao(Math.max(0, agoraMs - Date.parse(item.created_at)))}</p>
      </Secao>

      <DialogoPreviaLancamento
        aberto={!!previaAberta}
        previa={previaAberta?.previa ?? null}
        origem={previaAberta?.origem ?? "manual"}
        aviso={previaAberta?.aviso ?? null}
        erro={previaAberta?.erro ?? null}
        enviando={ocupado === "enviar"}
        onConfirmar={confirmar}
        onFechar={() => setPreviaAberta(null)}
      />
    </div>
  );
}

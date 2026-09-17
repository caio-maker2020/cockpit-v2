// =============================================================================
// ModalConfirmarDossie33 — INV-155. O pop-up da oc 33.
//
// REGRA (Carlos 2026-09-16): "qdo ela tentar lancar neste caso deve abrir um
// popup questionando que a descricao de itens nao foi identificada e
// questionando se o cliente informou via anexo / ELA MARCA SIM -> libera lancar
// a 33 confirmando que o dossie esta completo / se ela marcar NAO, nao libera".
//
// POR QUE ELA DIGITA (opcao "a" dele): um SIM sozinho produz exatamente a oc 33
// que o Ressarcimento devolveu 20 dias depois cobrando "DESCRICAO E VALOR"
// (NF 660746). O que ela escreve e o que o setor vai ler.
//
// A PREVIA DOS 70 CARACTERES nao e enfeite: o campo f6 do portal SSW (tela 101)
// tem maxlength=70 e e a coluna "Instrucao/Complemento" que o setor le. Tudo que
// passa disso vai pro backup de 500 e ninguem ve. Sem a previa ela escreveria um
// texto caprichado e o Ressarcimento receberia meio item.
//
// O SIM NAO VOLTA ATRAS: mergeEvidencia e monotonico. Por isso o aviso na tela e
// o registro de autoria (operador_id + visto_em) no dossie e no card_event.
// =============================================================================
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import {
  type AlvoConfirmacao,
  JANELA_SETOR,
  MAX_DESCRICAO,
  MAX_VALOR,
  previaDoSetor,
  ROTULO_CONFIRMACAO,
} from "@/lib/confirmacaoOc33";

interface Props {
  cardId: string;
  todoId: string;
  nf: string | null;
  alvos: AlvoConfirmacao[];
  /** Texto das evidencias que JA estao no dossie (as que nao sao alvo). */
  jaNoDossie?: { descricao?: string | null; valor?: string | null };
  onClose: () => void;
  /** Chamado so depois do SIM aceito pelo servidor — abre o modal de lancamento. */
  onConfirmado: () => void;
}

export function ModalConfirmarDossie33({
  cardId,
  todoId,
  nf,
  alvos,
  jaNoDossie,
  onClose,
  onConfirmado,
}: Props) {
  const [resposta, setResposta] = useState<"sim" | "nao" | null>(null);
  const [descricao, setDescricao] = useState("");
  const [valor, setValor] = useState("");
  const [enviando, setEnviando] = useState(false);

  const previa = useMemo(
    () => previaDoSetor({ alvos, descricao, valor, jaNoDossie }),
    [alvos, descricao, valor, jaNoDossie],
  );

  const pedeDescricao = alvos.includes("descricao");
  const pedeValor = alvos.includes("valor");
  const rotuloFaltando = alvos.map((a) => ROTULO_CONFIRMACAO[a]).join(" e ");

  async function responderNao() {
    setEnviando(true);
    // Registra a recusa: e assim que se mede quantas vezes o anexo NAO tinha a
    // informacao. Falhar aqui nao pode travar a operadora — o efeito e so o
    // registro, e o dossie segue incompleto de qualquer forma.
    try {
      await supabase?.functions.invoke("confirmar-dossie-oc33", {
        body: { card_id: cardId, todo_id: todoId, confirmou: false },
      });
    } catch {
      /* registro best-effort */
    }
    setEnviando(false);
    toast.info("A oc 33 segue bloqueada", {
      description: `Falta ${rotuloFaltando}. A cobranca ao cliente continua.`,
    });
    onClose();
  }

  async function responderSim() {
    if (!previa.completo) return;
    setEnviando(true);
    const { data, error } = await supabase!.functions.invoke("confirmar-dossie-oc33", {
      body: {
        card_id: cardId,
        todo_id: todoId,
        confirmou: true,
        descricao: pedeDescricao ? descricao : null,
        valor: pedeValor ? valor : null,
      },
    });
    setEnviando(false);

    const r = data as { ok?: boolean; error?: string; bloqueada?: boolean } | null;
    if (error || !r?.ok) {
      toast.error("Nao foi possivel confirmar", {
        description: r?.error ?? error?.message ?? "Erro desconhecido.",
      });
      return;
    }
    if (r.bloqueada) {
      toast.warning("Confirmado, mas a oc 33 segue bloqueada", {
        description: "Ainda falta outra evidencia no dossie.",
      });
      onClose();
      return;
    }
    toast.success("Dossie confirmado", { description: "A oc 33 esta liberada." });
    onConfirmado();
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/60 p-4">
      <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto border-2 border-ink bg-paper p-5">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="font-display text-[17px] font-semibold text-ink">
            Confirmar dossie {nf ? `— NF ${nf}` : ""}
          </h2>
          <button
            onClick={onClose}
            disabled={enviando}
            className="font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:text-ink disabled:opacity-40"
          >
            ✕ fechar
          </button>
        </div>

        <div className="mb-4 border-l-4 border-rose-400 bg-rose-50 px-3 py-2 font-mono text-[11px] leading-snug text-rose-900">
          Nao identifiquei <b>{rotuloFaltando}</b> neste card.
          <br />
          O cliente informou essa informacao <b>em anexo</b>?
        </div>

        <div className="mb-4 flex gap-2">
          <button
            type="button"
            onClick={() => setResposta("sim")}
            disabled={enviando}
            className={[
              "flex-1 border-2 px-3 py-2 font-mono text-[12px] font-bold uppercase tracking-wider transition-colors disabled:opacity-40",
              resposta === "sim"
                ? "border-emerald-600 bg-emerald-600 text-white"
                : "border-ink/30 bg-paper text-ink hover:border-emerald-600",
            ].join(" ")}
          >
            Sim
          </button>
          <button
            type="button"
            onClick={() => setResposta("nao")}
            disabled={enviando}
            className={[
              "flex-1 border-2 px-3 py-2 font-mono text-[12px] font-bold uppercase tracking-wider transition-colors disabled:opacity-40",
              resposta === "nao"
                ? "border-ink bg-ink text-paper"
                : "border-ink/30 bg-paper text-ink hover:border-ink",
            ].join(" ")}
          >
            Nao
          </button>
        </div>

        {resposta === "nao" && (
          <>
            <div className="mb-4 border border-ink/20 bg-ink/[0.03] px-3 py-2 font-mono text-[11px] leading-snug text-ink/75">
              Entao o dossie segue incompleto e a oc 33 continua bloqueada. A Sal
              segue cobrando o cliente pela informacao que falta.
            </div>
            <button
              onClick={responderNao}
              disabled={enviando}
              className="w-full border-2 border-ink bg-ink px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-wider text-paper disabled:opacity-40"
            >
              {enviando ? "registrando..." : "entendi, fechar"}
            </button>
          </>
        )}

        {resposta === "sim" && (
          <>
            <div className="mb-3 font-mono text-[10px] uppercase tracking-wider text-ink-soft">
              Escreva o que o cliente informou
            </div>

            {pedeDescricao && (
              <div className="mb-3">
                <label className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-ink-soft">
                  {ROTULO_CONFIRMACAO.descricao}
                </label>
                <input
                  id="confirma33-descricao"
                  value={descricao}
                  onChange={(e) => setDescricao(e.target.value.slice(0, MAX_DESCRICAO))}
                  maxLength={MAX_DESCRICAO}
                  placeholder="Ex: DINITRATO ISOSSORBIDA 10MG - 12 UN"
                  className="w-full border border-ink/30 bg-paper px-2 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-ink"
                />
                <div className="mt-0.5 text-right font-mono text-[9px] text-ink/40">
                  {descricao.length}/{MAX_DESCRICAO}
                </div>
              </div>
            )}

            {pedeValor && (
              <div className="mb-3">
                <label className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-ink-soft">
                  {ROTULO_CONFIRMACAO.valor}
                </label>
                <input
                  id="confirma33-valor"
                  value={valor}
                  onChange={(e) => setValor(e.target.value.slice(0, MAX_VALOR))}
                  maxLength={MAX_VALOR}
                  placeholder="Ex: R$ 1.488,00"
                  className="w-full border border-ink/30 bg-paper px-2 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-ink"
                />
                <div className="mt-0.5 text-right font-mono text-[9px] text-ink/40">
                  {valor.length}/{MAX_VALOR}
                </div>
              </div>
            )}

            {/* O que o setor de Ressarcimento REALMENTE le. */}
            <div className="mb-3 border border-ink/20 bg-paper-deep/30 px-3 py-2">
              <div className="mb-1 font-mono text-[9px] uppercase tracking-wider text-ink/50">
                o Ressarcimento vai ler ({JANELA_SETOR} caracteres)
              </div>
              <div className="break-all font-mono text-[11px] leading-snug text-ink">
                {previa.janela || <span className="text-ink/30">(vazio)</span>}
                {previa.cortado && (
                  <span className="text-rose-600/50">{previa.texto.slice(JANELA_SETOR)}</span>
                )}
              </div>
              {previa.cortado && (
                <div className="mt-1 font-mono text-[9px] leading-snug text-rose-700">
                  O trecho em vermelho <b>nao chega ao setor</b>. Encurte para o
                  item e o valor caberem.
                </div>
              )}
            </div>

            <div className="mb-3 border-l-4 border-amber-500 bg-amber-50 px-3 py-2 font-mono text-[10px] leading-snug text-amber-900">
              ⚠️ Confirmando, o dossie passa a constar como <b>completo</b> e a
              Sal <b>para de cobrar</b> este cliente. Isso <b>nao volta atras</b> —
              fica registrado seu nome e a hora.
            </div>

            <button
              onClick={responderSim}
              disabled={enviando || !previa.completo}
              className="w-full border-2 border-emerald-700 bg-emerald-600 px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-wider text-white disabled:border-ink/20 disabled:bg-ink/10 disabled:text-ink/40"
            >
              {enviando
                ? "confirmando..."
                : previa.completo
                  ? "confirmar e liberar a oc 33"
                  : "escreva o que falta"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

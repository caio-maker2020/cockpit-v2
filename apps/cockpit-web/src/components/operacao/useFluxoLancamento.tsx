// =============================================================================
// O fluxo ÚNICO de lançamento da Operação: prévia → janela de confirmação →
// pedido com o token. Detalhe e kanban usam este mesmo hook, então não existe
// caminho que lance sem a pessoa ver a prévia (INV-041/053/185).
// =============================================================================
import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useOpApi } from "@/contexts/OperacaoContext";
import { ehFalhaOp } from "@/lib/operacao/api";
import { mensagemErroOp } from "@/lib/operacao/erros";
import type { OpPrevia, OpPreviaEncaminhamento } from "@/lib/operacao/tipos";
import { DialogoPreviaLancamento } from "./DialogoPreviaLancamento";
import { DialogoPreviaEncaminhamento } from "./DialogoPreviaEncaminhamento";

interface EncaminhamentoAberto {
  itemId: string;
  texto: string;
  previa: OpPreviaEncaminhamento;
  confirmacao: string;
  aviso: string | null;
  erro: string | null;
}

interface PreviaAberta {
  itemId: string;
  origem: "manual" | "sugestao";
  codigo: number;
  texto: string;
  previa: OpPrevia;
  confirmacao: string;
  aviso: string | null;
  erro: string | null;
}

/**
 * Lançar (prévia → confirmação → op_solicitar_lancamento/op_aceitar_sugestao) e
 * encaminhar ao Relacionamento (op_previa_encaminhamento → confirmação →
 * op_encaminhar_relacionamento). Ambos com o token da prévia.
 */
export function useFluxoLancamento(
  opcoes: { onLancado?: () => void; onEncaminhado?: (itemId: string) => void } = {},
) {
  const api = useOpApi();
  const qc = useQueryClient();
  const [aberta, setAberta] = useState<PreviaAberta | null>(null);
  const [enc, setEnc] = useState<EncaminhamentoAberto | null>(null);
  const [carregandoPrevia, setCarregandoPrevia] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  // Trava de clique: duplo clique no "Confirmar" não manda dois pedidos (o banco também barra).
  const emVoo = useRef(false);

  const atualizar = () => qc.invalidateQueries({ queryKey: ["op"] });

  /** Pede a prévia ao servidor. Devolve a mensagem de erro (ou null se abriu a janela). */
  async function abrirPrevia(itemId: string, origem: "manual" | "sugestao", codigo: number, texto: string): Promise<string | null> {
    if (!api) return mensagemErroOp({ erro: "falha_de_comunicacao" });
    setCarregandoPrevia(itemId);
    try {
      const r = await api.previa(itemId, codigo, texto);
      if (ehFalhaOp(r)) {
        if (r.erro === "item_fechado" || r.erro === "lancamento_em_andamento") atualizar();
        return mensagemErroOp(r);
      }
      setAberta({ itemId, origem, codigo, texto, previa: r.previa, confirmacao: r.confirmacao, aviso: null, erro: null });
      return null;
    } finally {
      setCarregandoPrevia(null);
    }
  }

  async function confirmar() {
    if (!api || !aberta || emVoo.current) return;
    emVoo.current = true;
    setEnviando(true);
    try {
      const p = aberta;
      const r =
        p.origem === "sugestao"
          ? await api.aceitarSugestao(p.itemId, p.confirmacao)
          : await api.solicitar(p.itemId, p.codigo, p.texto, p.confirmacao);
      if (ehFalhaOp(r)) {
        if (r.erro === "previa_desatualizada" && r.previa && r.confirmacao) {
          // Mostra o NOVO conteúdo e exige um novo clique sobre ele.
          setAberta({ ...p, previa: r.previa, confirmacao: r.confirmacao, aviso: mensagemErroOp(r), erro: null });
        } else {
          setAberta({ ...p, aviso: null, erro: mensagemErroOp(r) });
        }
        atualizar();
        return;
      }
      setAberta(null);
      toast.success(`Pedido da oc ${r.previa.codigo_oc} na fila de lançamento. O status aparece aqui.`);
      opcoes.onLancado?.();
      atualizar();
    } finally {
      emVoo.current = false;
      setEnviando(false);
    }
  }

  /** Prévia do encaminhamento. Texto vazio = o da sugestão de encaminhar (o servidor decide). */
  async function abrirPreviaEncaminhamento(itemId: string, texto: string): Promise<string | null> {
    if (!api) return mensagemErroOp({ erro: "falha_de_comunicacao" });
    setCarregandoPrevia(itemId);
    try {
      const r = await api.previaEncaminhamento(itemId, texto);
      if (ehFalhaOp(r)) {
        if (r.erro === "item_fechado") atualizar();
        return mensagemErroOp(r);
      }
      setEnc({ itemId, texto: r.texto, previa: r.previa, confirmacao: r.confirmacao, aviso: null, erro: null });
      return null;
    } finally {
      setCarregandoPrevia(null);
    }
  }

  async function confirmarEncaminhamento() {
    if (!api || !enc || emVoo.current) return;
    emVoo.current = true;
    setEnviando(true);
    try {
      const p = enc;
      const r = await api.encaminhar(p.itemId, p.texto, p.confirmacao);
      if (ehFalhaOp(r)) {
        if (r.erro === "previa_desatualizada" && r.previa && r.confirmacao) {
          setEnc({ ...p, previa: r.previa, texto: r.previa.texto, confirmacao: r.confirmacao, aviso: mensagemErroOp(r), erro: null });
        } else {
          setEnc({ ...p, aviso: null, erro: mensagemErroOp(r) });
        }
        atualizar();
        return;
      }
      setEnc(null);
      const hora = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
      toast.success(
        r.status === "espelhado"
          ? `NF ${r.previa.nf ?? r.previa.ctrc} encaminhada ao espelho do Relacionamento às ${hora}. Nada foi ao Relacionamento real.`
          : `NF ${r.previa.nf ?? r.previa.ctrc} encaminhada ao Relacionamento às ${hora}. Saiu da fila da Operação.`,
      );
      opcoes.onEncaminhado?.(p.itemId);
      atualizar();
    } finally {
      emVoo.current = false;
      setEnviando(false);
    }
  }

  /** Desfaz o encaminhamento AUTOMÁTICO enquanto está agendado. Devolve a mensagem de erro ou null. */
  async function desfazerEncaminhamento(encaminhamentoId: string): Promise<string | null> {
    if (!api) return mensagemErroOp({ erro: "falha_de_comunicacao" });
    const r = await api.desfazerEncaminhamento(encaminhamentoId);
    atualizar();
    if (ehFalhaOp(r)) return mensagemErroOp(r);
    toast.success("Encaminhamento desfeito. A nota continua na fila da Operação.");
    return null;
  }

  const dialogo = (
    <>
    <DialogoPreviaEncaminhamento
      aberto={!!enc}
      previa={enc?.previa ?? null}
      aviso={enc?.aviso ?? null}
      erro={enc?.erro ?? null}
      enviando={enviando}
      onConfirmar={confirmarEncaminhamento}
      onFechar={() => setEnc(null)}
    />
    <DialogoPreviaLancamento
      aberto={!!aberta}
      previa={aberta?.previa ?? null}
      origem={aberta?.origem ?? "manual"}
      aviso={aberta?.aviso ?? null}
      erro={aberta?.erro ?? null}
      enviando={enviando}
      onConfirmar={confirmar}
      onFechar={() => setAberta(null)}
    />
    </>
  );

  return { abrirPrevia, abrirPreviaEncaminhamento, desfazerEncaminhamento, dialogo, carregandoPrevia, ocupado: enviando || carregandoPrevia !== null };
}

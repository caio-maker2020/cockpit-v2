// =============================================================================
// texto-citado-email — separa o que o CLIENTE escreveu do que é apenas CITAÇÃO
// do nosso próprio e-mail colado na resposta.
//
// Por que existe (Carlos/Caio 2026-09-04, âncora NF 145307 SOLUÇÃO PET):
// o detector determinístico do romaneio (`detectarRomaneioNoHistorico`) roda o
// filtro anti-pedido (`RE_ROMANEIO_PEDIDO`) no corpo INTEIRO da mensagem. Como
// o cliente responde citando o nosso e-mail, e os templates que pedem o romaneio
// (`ENTREGUE_COM_FALTA_PEDIR_ROMANEIO`, `EXTRAVIO_PARCIAL_DEVOLVER_PEDIR_ROMANEIO`,
// `RECUSA_EXTRAVIO_DEVOLVER_OU_SEGUIR`) contêm literalmente "encaminhar o romaneio"
// e "aguardo", TODA resposta normal do fluxo se auto-vetava.
//
// Medição em produção (2026-09-04): de 424 mensagens de cliente com anexo e sinal
// positivo de envio do romaneio, 381 (89,9%) eram vetadas por texto NOSSO citado.
// O seed nunca recuperou um romaneio: 0 acertos em 1.831 rodadas que terminaram
// "faltando romaneio".
//
// Este módulo é PURO e CONSERVADOR: na dúvida ele NÃO corta (devolve o corpo
// inteiro). Cortar demais perderia texto legítimo do cliente — pior que não cortar.
// =============================================================================

/**
 * Marcadores de início de citação. Ordem não importa (pega a ocorrência mais
 * à esquerda). Todos são âncorados em início de linha para não casar no meio
 * de uma frase do cliente.
 */
const MARCADORES: RegExp[] = [
  // Outlook PT/EN: "-----Mensagem original-----" / "-----Original Message-----"
  /^[ \t]*-{2,}[ \t]*(mensagem original|original message|forwarded message|mensagem encaminhada)[ \t]*-{2,}/im,
  // Outlook web / Exchange: linha de underscores separando a citação
  /^[ \t]*_{10,}[ \t]*$/m,
  // Gmail PT: "Em qua., 3 de jul. de 2026 às 14:41, Fulano <x@y> escreveu:"
  /^[ \t]*em .{0,120}?escreveu:[ \t]*$/im,
  // Gmail EN: "On Thu, Jul 3, 2026 at 2:41 PM Fulano <x@y> wrote:"
  /^[ \t]*on .{0,120}?wrote:[ \t]*$/im,
];

/**
 * Cabeçalho de citação do Outlook SEM a linha de tracinhos (acontece quando o
 * cliente/segurança remove os separadores). Só conta como marcador quando o
 * "De:"/"From:" vier acompanhado de OUTRO campo de cabeçalho logo em seguida —
 * senão um cliente escrevendo "De: mim para você" cortaria o texto dele.
 */
const RE_DE_FROM = /^[ \t]*(de|from):[ \t]*\S/im;
const RE_CAMPO_CABECALHO = /^[ \t]*(enviada?\s+em|enviado\s+em|sent|para|to|cc|assunto|subject):[ \t]*\S/im;
/** Janela (em caracteres) após o "De:" onde procuramos o 2º campo de cabeçalho. */
const JANELA_CABECALHO = 400;

/** Linha citada por prefixo ">" (padrão RFC, usado por vários clientes). */
const RE_LINHA_CITADA = /^[ \t]*>/;

function indiceDoPrimeiroMarcador(corpo: string): number {
  let melhor = -1;
  for (const re of MARCADORES) {
    const m = re.exec(corpo);
    if (m && m.index >= 0 && (melhor === -1 || m.index < melhor)) melhor = m.index;
  }
  // "De:/From:" só vale como marcador com um 2º campo de cabeçalho na janela.
  const mDe = RE_DE_FROM.exec(corpo);
  if (mDe && mDe.index >= 0) {
    const janela = corpo.slice(mDe.index, mDe.index + JANELA_CABECALHO);
    // pula a própria linha do "De:" antes de procurar o 2º campo
    const depoisDaLinha = janela.slice(janela.indexOf("\n") + 1);
    if (janela.indexOf("\n") >= 0 && RE_CAMPO_CABECALHO.test(depoisDaLinha)) {
      if (melhor === -1 || mDe.index < melhor) melhor = mDe.index;
    }
  }
  return melhor;
}

/** Remove as linhas prefixadas com ">" (citação RFC) preservando as demais. */
function removerLinhasCitadas(texto: string): string {
  if (!texto.includes(">")) return texto;
  return texto
    .split("\n")
    .filter((l) => !RE_LINHA_CITADA.test(l))
    .join("\n");
}

export interface TextoSeparado {
  /** O que o cliente de fato escreveu nesta resposta (sem a citação). */
  textoCliente: string;
  /** O bloco citado (nosso e-mail anterior / histórico). "" quando não há. */
  textoCitado: string;
  /** true quando algum marcador de citação foi encontrado. */
  temCitacao: boolean;
}

/**
 * Separa corpo do cliente × citação. CONSERVADOR:
 *   - sem marcador → devolve tudo como texto do cliente (temCitacao=false);
 *   - se o corte deixaria menos de 3 caracteres úteis do cliente (ex.: resposta
 *     top-posting vazia, ou marcador logo na 1ª linha), devolve o corpo INTEIRO
 *     como texto do cliente — melhor não cortar do que cegar o detector.
 * Puro: não muta a entrada.
 */
export function separarTextoDoCliente(corpo: string | null | undefined): TextoSeparado {
  const texto = corpo ?? "";
  if (texto.trim().length === 0) return { textoCliente: "", textoCitado: "", temCitacao: false };

  const idx = indiceDoPrimeiroMarcador(texto);
  if (idx < 0) {
    const semCitadas = removerLinhasCitadas(texto);
    const houveCitada = semCitadas !== texto;
    if (houveCitada && semCitadas.trim().length >= 3) {
      return { textoCliente: semCitadas, textoCitado: texto.slice(semCitadas.length), temCitacao: true };
    }
    return { textoCliente: texto, textoCitado: "", temCitacao: false };
  }

  const antes = removerLinhasCitadas(texto.slice(0, idx));
  if (antes.trim().length < 3) {
    // Corte deixaria o cliente "mudo" — não corta (fail-open pro comportamento antigo).
    return { textoCliente: texto, textoCitado: "", temCitacao: false };
  }
  return { textoCliente: antes, textoCitado: texto.slice(idx), temCitacao: true };
}

/**
 * Conveniência: aplica `re` apenas ao que o cliente escreveu. Usado pra que um
 * pedido NOSSO citado ("gentileza encaminhar o romaneio", "ficamos no aguardo")
 * não seja lido como pedido do cliente.
 */
export function casaNoTextoDoCliente(re: RegExp, corpo: string | null | undefined): boolean {
  return re.test(separarTextoDoCliente(corpo).textoCliente);
}

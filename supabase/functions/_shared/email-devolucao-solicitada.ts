// =============================================================================
// email-devolucao-solicitada.ts — o cliente JÁ pediu/autorizou a devolução por
// e-mail, ANTES de a gente analisar o card?
//
// Capacidade nova aprendida com a gestão (learning_log f665c8f2, Isadora):
// em card de oc 10 (recusa) o agente decide olhando só a ocorrência do SSW —
// nunca a caixa de e-mail. Quando o cliente já mandou "solicito a devolução"
// dias antes, o certo é 44 (seguir devolução), não 54/56.
//
// Base medida em produção (audits/2026-08-11_capacidades-oc19-oc10_laudo.md):
// 48 cards de oc 10 em que o agente sugeriu 54/56 e o time lançou 44; 25 tinham
// e-mail antes da decisão e 16 citavam devolução. Âncora: NF 50540 — "Solicito
// a devolução dessas NF 50661 / 50660 / ... / 50540".
//
// PRECISÃO ACIMA DE COBERTURA. O ramo oc 10 → 54 tem 805 acertos em produção;
// um detector largo destrói mais do que recupera. Por isso: análise frase a
// frase, verbo de comando OBRIGATÓRIO junto do objeto "devolução", e uma lista
// de bloqueios que mata os falsos positivos conhecidos (pergunta, negação,
// ordem dirigida a terceiro, adiamento).
// =============================================================================

export interface DeteccaoDevolucao {
  /** true só quando há pedido/autorização CLARA e presente de devolução. */
  solicitada: boolean;
  /** Frase exata que disparou (verbatim, pro operador conferir). */
  trecho: string | null;
  /** Rótulo do padrão que casou — auditoria e depuração. */
  padrao: string | null;
}

const NAO_DETECTADO: DeteccaoDevolucao = { solicitada: false, trecho: null, padrao: null };

/** Verbo de comando/solicitação em 1ª pessoa ou imperativo dirigido à Sal. */
const VERBOS_COMANDO = [
  "solicito",
  "solicitamos",
  "solicitando",
  "peco",
  "pedimos",
  "favor",
  "gentileza",
  "pode",
  "podem",
  "poderao",
  "autorizo",
  "autorizamos",
  "autorizado",
  "autorizada",
  "libero",
  "liberamos",
  "liberado",
  "liberada",
  "prossiga",
  "prossigam",
  "proceda",
  "procedam",
  "efetuar",
  "efetuem",
  "realizar",
  "realizem",
  "retornar",
  "devolver",
];

/** O objeto da frase: devolução da mercadoria. */
const OBJETOS_DEVOLUCAO = [
  "devolucao",
  "devolver",
  "devolvida",
  "devolvido",
  "nfd",
  "nota de devolucao",
  "retorno da mercadoria",
  "retorno do volume",
  "retornar a mercadoria",
  "retornar o volume",
];

/**
 * Bloqueios — se a frase tem qualquer um destes, NÃO conta, mesmo com verbo +
 * objeto. Cada entrada veio de um falso positivo real (os 4 primeiros são os
 * mesmos que o prompt do interpretador-resposta-cliente já lista).
 */
const BLOQUEIOS = [
  // ordem dirigida a TERCEIRO (cliente final), não decisão do pagador
  "orientar o cliente",
  "orientar o destinatario",
  "oriente o cliente",
  "orientem o destinatario",
  "orientar o remetente",
  // negação
  "nao autorizo",
  "nao autorizamos",
  "nao pode devolver",
  "nao podem devolver",
  "nao e para devolver",
  "sem devolucao",
  "nao houve devolucao",
  "nao sera devolvido",
  // adiamento / intenção futura
  "vamos verificar",
  "vou verificar",
  "estamos verificando",
  "aguardando",
  "aguarde",
  "aguardar",
  "assim que",
  "caso seja",
  "caso haja",
  "se for necessario",
  "possibilidade de",
  "verificar se",
  // auto-reply / redirecionamento institucional
  "este e-mail e destinado",
  "nao responda",
  "mensagem automatica",
];

function normalizar(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Quebra em frases. Considera fim de frase: . ! ? ; quebra de linha.
 * Mantém o texto original pra devolver o trecho verbatim.
 */
function frasear(texto: string): string[] {
  return texto
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
}

/**
 * O cliente pediu/autorizou a devolução nesta mensagem?
 *
 * Exige, NA MESMA FRASE: verbo de comando + objeto "devolução", sem bloqueio e
 * sem interrogação. Frase interrogativa nunca conta — "podemos devolver?" é
 * pergunta do cliente, não decisão.
 */
export function detectarDevolucaoSolicitada(texto: string | null | undefined): DeteccaoDevolucao {
  if (typeof texto !== "string" || texto.trim().length === 0) return NAO_DETECTADO;

  for (const fraseOriginal of frasear(texto)) {
    const frase = normalizar(fraseOriginal);

    // pergunta não é decisão
    if (frase.includes("?")) continue;

    if (BLOQUEIOS.some((b) => frase.includes(b))) continue;

    const objeto = OBJETOS_DEVOLUCAO.find((o) => frase.includes(o));
    if (!objeto) continue;

    const verbo = VERBOS_COMANDO.find((v) => new RegExp(`(^|[^a-z])${v}([^a-z]|$)`).test(frase));
    if (!verbo) continue;

    // "devolver"/"retornar" já são verbo E objeto — sozinhos são fracos demais
    // ("a transportadora devolveu o volume" é relato, não comando). Exige um
    // segundo sinal de comando na frase.
    if (verbo === objeto) {
      const outroVerbo = VERBOS_COMANDO.find(
        (v) => v !== verbo && new RegExp(`(^|[^a-z])${v}([^a-z]|$)`).test(frase),
      );
      if (!outroVerbo) continue;
      return {
        solicitada: true,
        trecho: fraseOriginal.slice(0, 300),
        padrao: `${outroVerbo}+${objeto}`,
      };
    }

    return { solicitada: true, trecho: fraseOriginal.slice(0, 300), padrao: `${verbo}+${objeto}` };
  }

  return NAO_DETECTADO;
}

/**
 * Varre as mensagens do card (mais recente primeiro) e devolve a primeira
 * detecção. `conteudo` null/vazio é ignorado.
 */
export function detectarDevolucaoNasMensagens(
  mensagens: ReadonlyArray<{ conteudo: string | null; recebido_em?: string | null }>,
): DeteccaoDevolucao & { recebido_em: string | null } {
  for (const m of mensagens) {
    const d = detectarDevolucaoSolicitada(m.conteudo);
    if (d.solicitada) return { ...d, recebido_em: m.recebido_em ?? null };
  }
  return { ...NAO_DETECTADO, recebido_em: null };
}

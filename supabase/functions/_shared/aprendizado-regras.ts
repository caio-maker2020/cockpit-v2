// =============================================================================
// aprendizado-regras.ts — regras PURAS do orquestrador agente-aprendizado.
//
// Spec: docs/superpowers/specs/2026-07-17-loop-aprendizado-agentes-design.md
// "As perguntas são riqueza" (Caio): o produto primário do orquestrador é a
// pergunta profunda ancorada em evidência, respondível em 1 clique, nunca
// repetida. Este módulo decide O QUE perguntar; a edge function decide quando
// e grava. Zero I/O aqui — tudo testável.
//
// Regras duras (herdadas do managed agent aposentado, spec §4.5):
//   - pergunta só com evidência mínima (>= MIN_CORRIGIDAS casos);
//   - nunca re-perguntar chave já aberta/respondida (dedup por chave_padrao);
//   - nunca inventar o porquê do operador (motivos só se registrados).
//
// Rodar testes: deno test supabase/functions/_shared/aprendizado-regras.test.ts
// =============================================================================

export interface ParFeedback {
  agent_name: string;
  veredito: string; // seguida | corrigida | abstencao | rejeitada | nao_rodou
  origem: string; // implicit | explicit | popup | outcome | audit | backfill
  oc_card: number | null;
  oc_sugerida: number | null;
  oc_executada: number | null;
  reason_text: string | null;
  operador_card: string | null;
  nf: string | null;
  decidido_em: string;
}

export interface TrocaFrequente {
  ocExecutada: number | null;
  casos: number;
  nfsExemplo: string[];
}

export interface GrupoSugestao {
  agentName: string;
  ocSugerida: number | null;
  pares: number;
  seguidas: number;
  corrigidas: number;
  abstencoes: number;
  /** corrigidas / (seguidas + corrigidas) — abstenção fora do denominador (spec §9) */
  taxaCorrecao: number;
  trocas: TrocaFrequente[];
  operadoresTop: { operador: string; casos: number }[];
  motivosRegistrados: string[];
}

export interface PerguntaMontada {
  chavePadrao: string;
  titulo: string;
  oQueAconteceu: string;
  oQueSugiro: string;
  pergunta: string;
  /** rótulos simples (compatibilidade com o front antigo) */
  opcoes: string[];
  /** opções com pergunta-seguimento estruturada (iteração 3) */
  opcoesV2: OpcaoPergunta[];
  casosAncora: string[];
  numeros: Record<string, number>;
  agenteAlvo: string;
}

/** Nomes amigáveis dos agentes pro texto do painel (linguagem simples, spec §6). */
export const AGENTE_NOME_AMIGAVEL: Record<string, string> = {
  "agente-sugere-ocs-padrao": "agente de recusas (ocorrências padrão)",
  "interpretador-resposta-cliente": "leitor de respostas do cliente",
  "agente-oc13-autonomo": "agente de limitação do cliente (oc 13)",
  "agente-extravio-d4": "agente de extravios (D+4)",
  "agente-ressarcimento-relancar-54": "agente de ressarcimento (relançar 54)",
};

const MAX_NFS_EXEMPLO = 5;
const MAX_TROCAS = 4;
const MAX_OPERADORES = 3;
const MAX_MOTIVOS = 5;

export function nomeOc(oc: number | null, nomes: Record<number, string>): string {
  if (oc === null) return "(sem código)";
  const nome = nomes[oc];
  return nome ? `${oc} — ${nome}` : `${oc}`;
}

/** Agrupa os pares por (agente × oc sugerida), com trocas, operadores e motivos. */
export function agruparPorSugestao(pares: ParFeedback[]): GrupoSugestao[] {
  const grupos = new Map<string, GrupoSugestao>();
  const trocasPorGrupo = new Map<string, Map<string, TrocaFrequente>>();
  const opsPorGrupo = new Map<string, Map<string, number>>();

  for (const p of pares) {
    const k = `${p.agent_name}|${p.oc_sugerida ?? "sem"}`;
    let g = grupos.get(k);
    if (!g) {
      g = {
        agentName: p.agent_name,
        ocSugerida: p.oc_sugerida,
        pares: 0,
        seguidas: 0,
        corrigidas: 0,
        abstencoes: 0,
        taxaCorrecao: 0,
        trocas: [],
        operadoresTop: [],
        motivosRegistrados: [],
      };
      grupos.set(k, g);
      trocasPorGrupo.set(k, new Map());
      opsPorGrupo.set(k, new Map());
    }
    g.pares += 1;
    if (p.veredito === "seguida") g.seguidas += 1;
    else if (p.veredito === "corrigida" || p.veredito === "rejeitada") {
      g.corrigidas += 1;
      const tk = String(p.oc_executada ?? "nada");
      const tmap = trocasPorGrupo.get(k)!;
      let t = tmap.get(tk);
      if (!t) {
        t = { ocExecutada: p.oc_executada, casos: 0, nfsExemplo: [] };
        tmap.set(tk, t);
      }
      t.casos += 1;
      if (p.nf && t.nfsExemplo.length < MAX_NFS_EXEMPLO) t.nfsExemplo.push(p.nf);
      if (p.operador_card) {
        const omap = opsPorGrupo.get(k)!;
        omap.set(p.operador_card, (omap.get(p.operador_card) ?? 0) + 1);
      }
      const motivo = (p.reason_text ?? "").trim();
      if (motivo && g.motivosRegistrados.length < MAX_MOTIVOS &&
        !g.motivosRegistrados.includes(motivo)) {
        g.motivosRegistrados.push(motivo);
      }
    } else {
      g.abstencoes += 1;
    }
  }

  for (const [k, g] of grupos) {
    const avaliadas = g.seguidas + g.corrigidas;
    g.taxaCorrecao = avaliadas > 0 ? g.corrigidas / avaliadas : 0;
    g.trocas = [...trocasPorGrupo.get(k)!.values()]
      .sort((a, b) => b.casos - a.casos)
      .slice(0, MAX_TROCAS);
    g.operadoresTop = [...opsPorGrupo.get(k)!.entries()]
      .map(([operador, casos]) => ({ operador, casos }))
      .sort((a, b) => b.casos - a.casos)
      .slice(0, MAX_OPERADORES);
  }

  return [...grupos.values()].sort((a, b) => b.corrigidas - a.corrigidas);
}

export function chavePergunta(g: GrupoSugestao): string {
  return `${g.agentName}:sug${g.ocSugerida ?? "sem"}`;
}

/**
 * Seleciona os grupos que merecem virar pergunta:
 *   - evidência mínima (corrigidas >= minCorrigidas) E taxa de correção
 *     relevante (>= minTaxa);
 *   - nunca uma chave já perguntada (dedup — "nunca re-perguntar");
 *   - diversidade: 1 pergunta por agente antes de repetir agente;
 *   - no máximo maxPerguntas.
 */
export function selecionarPerguntas(
  grupos: GrupoSugestao[],
  opts: {
    maxPerguntas?: number;
    minCorrigidas?: number;
    minTaxa?: number;
    chavesJaPerguntadas?: Set<string>;
  } = {},
): GrupoSugestao[] {
  const max = opts.maxPerguntas ?? 3;
  const minCorrigidas = opts.minCorrigidas ?? 5;
  const minTaxa = opts.minTaxa ?? 0.3;
  const jaPerguntadas = opts.chavesJaPerguntadas ?? new Set<string>();

  const elegiveis = grupos.filter((g) =>
    g.corrigidas >= minCorrigidas &&
    g.taxaCorrecao >= minTaxa &&
    !jaPerguntadas.has(chavePergunta(g))
  );

  const escolhidos: GrupoSugestao[] = [];
  // passada 1: diversidade por agente
  const agentesUsados = new Set<string>();
  for (const g of elegiveis) {
    if (escolhidos.length >= max) break;
    if (agentesUsados.has(g.agentName)) continue;
    escolhidos.push(g);
    agentesUsados.add(g.agentName);
  }
  // passada 2: completa com os maiores restantes
  for (const g of elegiveis) {
    if (escolhidos.length >= max) break;
    if (!escolhidos.includes(g)) escolhidos.push(g);
  }
  return escolhidos;
}

function pct(n: number): number {
  return Math.round(n * 100);
}

/**
 * Perguntas DIRECIONADAS por troca (Caio 2026-07-17): a pergunta já nasce
 * com o contexto de negócio da troca dominante — não genérica. Chave:
 * "<agente>:<sug>-><exe>" (específica) ou "<sug>-><exe>" (geral).
 * `sugNome`/`exeNome` chegam já no formato "código — nome".
 *
 * Iteração 3 (Caio 2026-07-20): cada opção carrega uma PERGUNTA-SEGUIMENTO
 * estruturada — clicou, o agente faz a pergunta matadora daquela escolha,
 * com opções marcáveis (não texto livre). Texto é opcional e dirigido.
 * `exige_imagem` bloqueia o envio sem print (casos de evidência).
 */
export interface FollowupOpcao {
  id: string;
  rotulo: string;
}

export interface Followup {
  pergunta: string;
  opcoes: FollowupOpcao[];
  /** permite marcar mais de uma opção */
  multi?: boolean;
  /** print obrigatório pra enviar (casos de evidência) */
  exige_imagem?: boolean;
  /** print sugerido, não obrigatório */
  pede_imagem?: boolean;
  /** campo de texto dirigido opcional */
  permite_texto?: boolean;
  texto_rotulo?: string;
}

export interface OpcaoPergunta {
  id: string;
  rotulo: string;
  followup?: Followup;
}

type TemplateDominio = {
  pergunta: (sugNome: string, exeNome: string) => string;
  opcoes: OpcaoPergunta[];
};

// ---------- seguimentos genéricos (reutilizados) ----------

const FU_TIME_ERROU: Followup = {
  pergunta:
    "Então a IA estava certa e o time corrigiu errado. O que fazemos com esses casos?",
  opcoes: [
    { id: "alinhamento", rotulo: "Levar pro alinhamento do time — a IA continua como está" },
    { id: "agente_alerta", rotulo: "O agente deve ALERTAR na tela quando o time contrariar a sugestão nesses casos" },
    { id: "rever_casos", rotulo: "Rever caso a caso antes de bater o martelo" },
  ],
  pede_imagem: true,
  permite_texto: true,
  texto_rotulo:
    "Tem um print de um caso em que a IA acertou e o time corrigiu? Anexa — vira exemplo de treino.",
};

const FU_DEPENDE: Followup = {
  pergunta:
    "Os casos reais estão logo acima, com o porquê da IA em cada um. Olhando eles: em quantos o TIME fez o certo?",
  opcoes: [
    { id: "todos", rotulo: "Nos 5 — a IA errou em todos" },
    { id: "maioria", rotulo: "Na maioria — a IA errou quase sempre" },
    { id: "metade", rotulo: "Em metade — está dividido" },
    { id: "poucos", rotulo: "Em poucos — a IA estava certa na maioria" },
  ],
  permite_texto: true,
  texto_rotulo: "Cita pela NF o caso que melhor mostra a regra (1 frase do porquê).",
};

const FU_REGRA_CLARA: Followup = {
  pergunta: "Me dá a regra no formato que a IA aprende:",
  opcoes: [],
  permite_texto: true,
  texto_rotulo: "Completa: “QUANDO acontecer ___, o certo é ___ (e o errado é ___)”.",
};

const FU_OUTRO: Followup = {
  pergunta: "Me ensina no formato que a IA aprende:",
  opcoes: [],
  permite_texto: true,
  texto_rotulo: "Completa: “QUANDO acontecer ___, o certo é ___ (e o errado é ___)”.",
};

const PERGUNTAS_DOMINIO: Record<string, TemplateDominio> = {
  // Agente segurou pedindo evidência/informação; time notificou o cliente.
  "56->54": {
    pergunta: (_s, e) =>
      `O agente segurou o caso pedindo informação à operação (56) porque considerou a evidência insuficiente — mas o time foi direto notificar o cliente ("${e}" + e-mail). Por que a notificação valeu mesmo sem a evidência que o agente exigia? A régua de evidência dele está agressiva demais — e qual é a evidência mínima pra cada ocorrência?`,
    opcoes: [
      {
        id: "regua_agressiva",
        rotulo: "A régua está agressiva demais — nesses casos pode notificar sem essa evidência",
        followup: {
          pergunta: "Pra eu recalibrar a régua: o que BASTA como evidência pra notificar o cliente?",
          multi: true,
          exige_imagem: true,
          opcoes: [
            { id: "canhoto_sem_ressalva", rotulo: "Foto do canhoto/comprovante, mesmo sem ressalva escrita" },
            { id: "motivo_motorista", rotulo: "Motivo escrito pelo motorista na instrução (mesmo sem foto)" },
            { id: "ressalva_parcial", rotulo: "Qualquer ressalva na foto, mesmo incompleta" },
            { id: "ocorrencia_basta", rotulo: "A própria ocorrência do SSW já basta — não precisa de evidência extra" },
          ],
          permite_texto: true,
          texto_rotulo: "Anexa o print de um caso em que notificar SEM a evidência era o certo (obrigatório) e, se quiser, explica em 1 frase.",
        },
      },
      {
        id: "regua_certa",
        rotulo: "A régua está certa — o time se precipitou ao notificar sem evidência",
        followup: FU_TIME_ERROU,
      },
      {
        id: "depende_oc",
        rotulo: "Depende da ocorrência — a régua certa muda entre 10/11/19/35",
        followup: {
          pergunta: "Em qual ocorrência a régua do agente está MAIS errada hoje?",
          multi: true,
          opcoes: [
            { id: "oc10", rotulo: "10 — recusa total da entrega" },
            { id: "oc11", rotulo: "11 — problemas com endereço" },
            { id: "oc19", rotulo: "19 — falta de volumes" },
            { id: "oc35", rotulo: "35 — recusa parcial" },
          ],
          permite_texto: true,
          texto_rotulo: "Pra(s) marcada(s): qual evidência basta? “QUANDO ___, notificar com ___”.",
        },
      },
      { id: "outro", rotulo: "Outro (explico na resposta)", followup: FU_OUTRO },
    ],
  },
  // Agente quis notificar; time devolveu pra operação pedindo informação.
  "54->56": {
    pergunta: (s, _e) =>
      `O agente quis notificar o cliente ("${s}") mas o time devolveu o caso pra operação pedindo informação (56). O que estava faltando que o agente não enxergou? Existe algum dado no card que deveria TRAVAR a notificação ao cliente?`,
    opcoes: [
      {
        id: "trava_existe",
        rotulo: "Sim — existe um dado que trava a notificação",
        followup: {
          pergunta: "Qual é a trava? O que precisa estar resolvido ANTES de notificar o cliente?",
          multi: true,
          exige_imagem: true,
          opcoes: [
            { id: "evidencia_incompleta", rotulo: "A evidência da entrega estava incompleta pra notificar" },
            { id: "confirmar_filial", rotulo: "Faltava a filial/operação confirmar o que houve" },
            { id: "motivo_generico", rotulo: "O motivo da ocorrência estava genérico demais" },
            { id: "cliente_ja_notificado", rotulo: "O cliente já tinha sido notificado — seria repetição" },
          ],
          permite_texto: true,
          texto_rotulo: "Anexa o print de um caso em que notificar teria sido errado (obrigatório).",
        },
      },
      { id: "agente_certo", rotulo: "O agente estava certo — o time pediu informação sem precisar", followup: FU_TIME_ERROU },
      { id: "depende", rotulo: "Depende do caso — olhei os exemplos acima", followup: FU_DEPENDE },
      { id: "outro", rotulo: "Outro (explico na resposta)", followup: FU_OUTRO },
    ],
  },
  // Agente quis aguardar cliente; time lançou reentrega direto.
  "54->21": {
    pergunta: (s, e) =>
      `O cliente respondeu, o agente sugeriu aguardar mais retorno ("${s}") — e o time lançou "${e}" direto. O que na resposta do cliente já autorizava a reentrega sem esperar mais? Se o cliente pede/autoriza reentrega, "aguardar" deveria ser proibido?`,
    opcoes: [
      {
        id: "regra_21_direto",
        rotulo: "Se o cliente autoriza reentrega na resposta, é 21 direto — regra clara",
        followup: {
          pergunta: "O que conta como autorização VÁLIDA pra 21 direto?",
          multi: true,
          opcoes: [
            { id: "pagador_autorizou", rotulo: "Só quando o PAGADOR autoriza (quem paga decide)" },
            { id: "destinatario_basta", rotulo: "Pedido do destinatário já basta" },
            { id: "com_agendamento", rotulo: "Precisa vir com data/agendamento combinado" },
            { id: "frete_definido", rotulo: "Precisa estar claro quem paga o frete da reentrega" },
          ],
          permite_texto: true,
          texto_rotulo: "Alguma exceção a essa regra? “QUANDO ___, NÃO lançar 21”.",
        },
      },
      {
        id: "depende_condicoes",
        rotulo: "Nem sempre — depende de pagamento/agendamento",
        followup: {
          pergunta: "O que TRAVA a 21 mesmo com o cliente pedindo reentrega?",
          multi: true,
          opcoes: [
            { id: "frete_nao_acordado", rotulo: "Frete da reentrega não acordado" },
            { id: "sem_agendamento", rotulo: "Sem data/janela de agendamento" },
            { id: "so_destinatario", rotulo: "Autorização veio do destinatário, não do pagador" },
            { id: "endereco_divergente", rotulo: "Endereço/contato divergente do cadastro" },
          ],
          permite_texto: true,
          texto_rotulo: "Outra trava que a IA deva conhecer? (1 frase)",
        },
      },
      {
        id: "time_se_antecipou",
        rotulo: "O time se antecipou — era caso de aguardar o cliente (54)",
        followup: {
          pergunta: "Então me ensina o caso: o que FALTAVA na resposta do cliente pra reentrega valer?",
          multi: true,
          pede_imagem: true,
          opcoes: [
            { id: "faltou_pagador", rotulo: "Faltou o pagador confirmar (só o destinatário falou)" },
            { id: "faltou_data", rotulo: "Faltou data/agendamento" },
            { id: "faltou_frete", rotulo: "Faltou definição do frete da reentrega" },
            { id: "leu_errado", rotulo: "A resposta nem autorizava reentrega — o time leu errado" },
          ],
          permite_texto: true,
          texto_rotulo: "Se tiver o print da resposta do cliente de um caso desses, anexa — é o melhor exemplo de treino.",
        },
      },
      { id: "outro", rotulo: "Outro (explico na resposta)", followup: FU_OUTRO },
    ],
  },
  "54->44": {
    pergunta: (s, e) =>
      `O agente sugeriu aguardar o cliente ("${s}") e o time lançou "${e}". Em que situação a resposta do cliente já define o retorno de carga sem precisar aguardar mais nada?`,
    opcoes: [
      {
        id: "regra_44_direto",
        rotulo: "Cliente pedindo devolução/retorno na resposta = 44 direto — regra clara",
        followup: {
          pergunta: "O que precisa estar na resposta pra 44 valer direto?",
          multi: true,
          opcoes: [
            { id: "pedido_explicito", rotulo: "Pedido explícito de devolução/retorno" },
            { id: "pagador_pediu", rotulo: "Tem que vir do pagador (não do destinatário)" },
            { id: "destino_definido", rotulo: "Destino do retorno definido" },
            { id: "frete_retorno", rotulo: "Frete do retorno acordado" },
          ],
          permite_texto: true,
          texto_rotulo: "Alguma exceção? “QUANDO ___, NÃO lançar 44”.",
        },
      },
      {
        id: "depende_confirmar",
        rotulo: "Depende — precisa confirmar algo antes do retorno",
        followup: {
          pergunta: "O que precisa ser confirmado antes do 44?",
          multi: true,
          opcoes: [
            { id: "conf_pagador", rotulo: "Confirmação do pagador" },
            { id: "conf_destino", rotulo: "Endereço/destino do retorno" },
            { id: "conf_frete", rotulo: "Quem paga o frete do retorno" },
            { id: "conf_estado_carga", rotulo: "Estado/integridade da carga" },
          ],
          permite_texto: true,
        },
      },
      { id: "time_se_antecipou", rotulo: "O time se antecipou — era caso de aguardar (54)", followup: FU_DEPENDE },
      { id: "outro", rotulo: "Outro (explico na resposta)", followup: FU_OUTRO },
    ],
  },
  "56->21": {
    pergunta: (_s, e) =>
      `O agente pediu informação à operação (56) e o time já lançou "${e}". O que dava pra decidir a reentrega sem a informação que o agente pediu?`,
    opcoes: [
      {
        id: "info_desnecessaria",
        rotulo: "A informação pedida era desnecessária pra decidir a reentrega",
        followup: {
          pergunta: "De onde saiu a decisão então? O que a IA deveria ter olhado?",
          multi: true,
          opcoes: [
            { id: "resposta_cliente", rotulo: "A resposta do cliente já continha a decisão" },
            { id: "historico_card", rotulo: "O histórico do card já mostrava o caminho" },
            { id: "info_nunca_chega", rotulo: "A informação pedida nunca chega mesmo — o time não espera por ela" },
            { id: "padrao_cliente", rotulo: "É o padrão daquele cliente específico" },
          ],
          permite_texto: true,
        },
      },
      { id: "time_arriscou", rotulo: "O time arriscou — o certo era esperar a informação", followup: FU_TIME_ERROU },
      { id: "depende", rotulo: "Depende do caso — olhei os exemplos acima", followup: FU_DEPENDE },
      { id: "outro", rotulo: "Outro (explico na resposta)", followup: FU_OUTRO },
    ],
  },
  // oc13: agente não decidiu (ou sugeriu notificar) e o time resolveu com reentrega.
  "agente-oc13-autonomo:sem->21": {
    pergunta: (_s, e) =>
      `Em cards de limitação do cliente (13), quando o agente não tem uma decisão fechada, o time quase sempre resolve com "${e}". Pra esses clientes, reentrega é o caminho padrão? Em que situação ela NÃO seria — e o que o agente deveria checar antes?`,
    opcoes: [
      {
        id: "reentrega_padrao",
        rotulo: "Reentrega é o padrão pra limitação do cliente — pode decidir 21 com mais coragem",
        followup: {
          pergunta: "Em que situação a 21 NÃO seria o caminho? (é o que o agente vai checar antes)",
          multi: true,
          opcoes: [
            { id: "recusa_disfarcada", rotulo: "Quando a limitação é recusa disfarçada (cliente não quer a carga)" },
            { id: "reentregas_demais", rotulo: "Quando já houve 2+ reentregas do mesmo card" },
            { id: "sem_janela", rotulo: "Quando não há janela/agendamento possível" },
            { id: "nunca", rotulo: "Nunca — pra esses clientes é sempre 21" },
          ],
          permite_texto: true,
          texto_rotulo: "Mais alguma checagem antes de lançar 21? (1 frase)",
        },
      },
      {
        id: "depende_motivo",
        rotulo: "Não é padrão — depende do motivo da limitação",
        followup: {
          pergunta: "Qual caminho pra cada motivo de limitação?",
          multi: true,
          opcoes: [
            { id: "local_fechado_21", rotulo: "Local fechado → reentrega direto (21)" },
            { id: "sem_agendamento_54", rotulo: "Sem agendamento → combinar com o cliente antes (54)" },
            { id: "restricao_56", rotulo: "Restrição de horário/veículo → operação resolve (56)" },
            { id: "outro_mapa", rotulo: "O mapa é outro (descrevo no campo)" },
          ],
          permite_texto: true,
        },
      },
      { id: "time_errou", rotulo: "O time é que está corrigindo errado — a sugestão da IA estava certa", followup: FU_TIME_ERROU },
      { id: "outro", rotulo: "Outro (explico na resposta)", followup: FU_OUTRO },
    ],
  },
  "agente-oc13-autonomo:54->21": {
    pergunta: (s, e) =>
      `Na limitação do cliente (13), o agente sugeriu notificar e aguardar ("${s}") — o time lançou "${e}" em 100% desses casos. Notificar o cliente nesses cenários serve pra alguma coisa, ou o agente deveria ir direto pra reentrega?`,
    opcoes: [
      {
        id: "direto_21",
        rotulo: "Ir direto pra reentrega — notificar só atrasa nesses casos",
        followup: {
          pergunta: "Com a foto comprovando, o agente pode então lançar a 21 SOZINHO nesses casos?",
          opcoes: [
            { id: "autonomia_sim", rotulo: "Sim — pode ganhar autonomia aqui (decisão minha, registrada)" },
            { id: "autonomia_ainda_nao", rotulo: "Ainda não — continua sugerindo, quero validar mais um tempo" },
            { id: "autonomia_parcial", rotulo: "Só pra alguns clientes (digo quais no campo)" },
          ],
          permite_texto: true,
          texto_rotulo: "Se for parcial: quais clientes?",
        },
      },
      {
        id: "notificar_vale",
        rotulo: "Notificar ainda vale em algumas situações",
        followup: {
          pergunta: "Em quais situações notificar (54) continua sendo o certo?",
          multi: true,
          opcoes: [
            { id: "pagador_diferente", rotulo: "Quando o pagador é diferente do destinatário" },
            { id: "reentrega_falhou", rotulo: "Quando já teve reentrega falha antes" },
            { id: "motivo_incerto", rotulo: "Quando o motivo da limitação é incerto" },
            { id: "cliente_pediu_aviso", rotulo: "Quando o cliente pediu pra ser avisado sempre" },
          ],
          permite_texto: true,
        },
      },
      { id: "time_errou", rotulo: "O time é que está corrigindo errado — a sugestão da IA estava certa", followup: FU_TIME_ERROU },
      { id: "outro", rotulo: "Outro (explico na resposta)", followup: FU_OUTRO },
    ],
  },
};

function templateDominio(
  agentName: string,
  ocSugerida: number | null,
  ocExecutada: number | null,
): TemplateDominio | null {
  const sugK = ocSugerida === null ? "sem" : String(ocSugerida);
  const exeK = ocExecutada === null ? "nada" : String(ocExecutada);
  return (
    PERGUNTAS_DOMINIO[`${agentName}:${sugK}->${exeK}`] ??
    PERGUNTAS_DOMINIO[`${sugK}->${exeK}`] ??
    null
  );
}

/**
 * Monta a pergunta em linguagem simples (contrato spec §6: o que aconteceu /
 * o que eu sugiro / pergunta 1-clique / detalhe técnico fica no jsonb).
 * Título DIRETO com a troca dominante e contagem (Caio 2026-07-17).
 * NUNCA inventa motivo do operador — motivos só aparecem se registrados.
 */
export function montarPergunta(
  g: GrupoSugestao,
  nomesOc: Record<number, string>,
): PerguntaMontada {
  const agente = AGENTE_NOME_AMIGAVEL[g.agentName] ?? g.agentName;
  const sug = nomeOc(g.ocSugerida, nomesOc);
  const taxa = pct(g.taxaCorrecao);
  const trocaTop = g.trocas[0];

  const titulo = trocaTop && trocaTop.ocExecutada !== null
    ? `${agente[0].toUpperCase()}${agente.slice(1)} sugeriu "${sug}" e o time lançou "${nomeOc(trocaTop.ocExecutada, nomesOc)}" — ${trocaTop.casos}x nos últimos 30 dias`
    : g.ocSugerida === null
    ? `No ${agente}, o time resolve de um jeito que a IA não previu em ${taxa}% dos casos avaliados`
    : `Quando o ${agente} sugere "${sug}", o time faz outra coisa em ${taxa}% dos casos`;

  const listaTrocas = g.trocas
    .filter((t) => t.ocExecutada !== null)
    .map((t) => `"${nomeOc(t.ocExecutada, nomesOc)}" (${t.casos}x)`)
    .join(", ");

  const oQueAconteceu = [
    `De ${g.seguidas + g.corrigidas} sugestões avaliadas, o time seguiu ${g.seguidas} e corrigiu ${g.corrigidas}.`,
    listaTrocas
      ? `No lugar da sugestão, o que o time mais lançou foi: ${listaTrocas}.`
      : `Nas correções, o time rejeitou a sugestão sem lançar outro código no lugar.`,
  ].join(" ");

  const oQueSugiro = trocaTop && trocaTop.ocExecutada !== null && trocaTop.casos / Math.max(g.corrigidas, 1) >= 0.5
    ? `Se existir uma regra clara de quando usar "${nomeOc(trocaTop.ocExecutada, nomesOc)}", eu consigo propor a mudança na sugestão e reduzir essas correções.`
    : `As correções vão pra caminhos diferentes — se vocês me explicarem o que decide entre eles, eu consigo propor uma sugestão melhor pra cada situação.`;

  const dominio = trocaTop
    ? templateDominio(g.agentName, g.ocSugerida, trocaTop.ocExecutada)
    : null;

  const pergunta = dominio && trocaTop
    ? dominio.pergunta(sug, nomeOc(trocaTop.ocExecutada, nomesOc))
    : trocaTop && trocaTop.ocExecutada !== null
    ? `O que faz o time escolher "${nomeOc(trocaTop.ocExecutada, nomesOc)}" em vez de "${sug}"? Existe uma regra que a IA deveria conhecer?`
    : `O que o time olha pra decidir o que fazer nesses casos em que corrige a IA?`;

  const opcoesV2: OpcaoPergunta[] = dominio?.opcoes ?? [
    { id: "regra_clara", rotulo: "Sim — existe uma regra clara", followup: FU_REGRA_CLARA },
    { id: "depende", rotulo: "Depende do caso — olhei os exemplos acima", followup: FU_DEPENDE },
    {
      id: "time_errou",
      rotulo: "O time é que está corrigindo errado — a sugestão da IA estava certa",
      followup: FU_TIME_ERROU,
    },
    { id: "outro", rotulo: "Outro (explico na resposta)", followup: FU_OUTRO },
  ];
  const opcoes = opcoesV2.map((o) => o.rotulo);

  const casosAncora = [
    ...new Set(g.trocas.flatMap((t) => t.nfsExemplo)),
  ].slice(0, MAX_NFS_EXEMPLO);

  return {
    chavePadrao: chavePergunta(g),
    titulo,
    oQueAconteceu,
    oQueSugiro,
    pergunta,
    opcoes,
    opcoesV2,
    casosAncora,
    numeros: {
      pares: g.pares,
      seguidas: g.seguidas,
      corrigidas: g.corrigidas,
      abstencoes: g.abstencoes,
      taxa_correcao_pct: taxa,
    },
    agenteAlvo: g.agentName,
  };
}

// ========================= impacto das respostas =========================
// Caio 2026-07-23: "quero que o agente monitore se os inputs da Isadora
// estão de fato melhorando os outros agentes". Compara a taxa de correção
// do padrão ANTES da resposta vs DEPOIS — honesto: só conclui com volume
// mínimo dos dois lados; senão é "cedo demais".

export interface ContagemJanela {
  seguidas: number;
  corrigidas: number;
}

export interface ImpactoResposta {
  status: "melhorou" | "piorou" | "estavel" | "cedo_demais";
  taxaAntesPct: number | null;
  taxaDepoisPct: number | null;
  deltaPts: number | null;
  avaliadasAntes: number;
  avaliadasDepois: number;
}

const IMPACTO_MIN_AVALIADAS = 8;
const IMPACTO_ESTAVEL_PTS = 3;

export function medirImpactoResposta(
  antes: ContagemJanela,
  depois: ContagemJanela,
): ImpactoResposta {
  const avAntes = antes.seguidas + antes.corrigidas;
  const avDepois = depois.seguidas + depois.corrigidas;
  const taxa = (c: ContagemJanela, av: number) =>
    av > 0 ? Math.round((1000 * c.corrigidas) / av) / 10 : null;
  const tAntes = taxa(antes, avAntes);
  const tDepois = taxa(depois, avDepois);

  if (avAntes < IMPACTO_MIN_AVALIADAS || avDepois < IMPACTO_MIN_AVALIADAS) {
    return {
      status: "cedo_demais",
      taxaAntesPct: tAntes,
      taxaDepoisPct: tDepois,
      deltaPts: null,
      avaliadasAntes: avAntes,
      avaliadasDepois: avDepois,
    };
  }
  // taxa de CORREÇÃO caindo = agente melhorando
  const delta = Math.round((tDepois! - tAntes!) * 10) / 10;
  const status = Math.abs(delta) <= IMPACTO_ESTAVEL_PTS
    ? "estavel"
    : delta < 0
    ? "melhorou"
    : "piorou";
  return {
    status,
    taxaAntesPct: tAntes,
    taxaDepoisPct: tDepois,
    deltaPts: delta,
    avaliadasAntes: avAntes,
    avaliadasDepois: avDepois,
  };
}

/** chave_padrao "agente:sug54" | "agente:sugsem" → filtro do padrão */
export function parseChavePadrao(
  chave: string | null | undefined,
): { agentName: string; ocSugerida: number | null } | null {
  if (!chave) return null;
  const m = /^(.+):sug(\d+|sem)$/.exec(chave);
  if (!m) return null;
  return {
    agentName: m[1],
    ocSugerida: m[2] === "sem" ? null : Number(m[2]),
  };
}

// ===================== melhorias propostas (F6) =====================
// Cada resposta da gestão vira um CANDIDATO a melhoria na fila do painel.
// O agente-chefe NÃO escreve diff nem mexe em nada: ele registra a regra
// aprendida + evidência; Isadora/Caio aprovam na fila; o agente de
// repositório (comando /f6-aplicar-melhorias) transforma aprovados em
// diff testado por replay + PR que só o Caio mergeia (spec §5/D6).

/** Onde vive o comportamento de cada agente (alvo informativo do diff). */
export const PROMPT_ALVO_POR_AGENTE: Record<string, string> = {
  "interpretador-resposta-cliente":
    "supabase/functions/interpretador-resposta-cliente/index.ts (system prompt) + _shared/regras-interpretador-resposta.ts",
  "agente-sugere-ocs-padrao":
    "supabase/functions/agente-sugere-ocs-padrao/index.ts + _shared/regras-auto-acao.ts + prompt do interpretador-evidencia-foto",
  "agente-oc13-autonomo":
    "supabase/functions/agente-oc13-autonomo/index.ts (árvore de decisão) + cliente_config_oc13",
};

export interface AjusteCandidato {
  titulo: string;
  resumo: string;
  agenteAlvo: string;
  promptAlvo: string;
}

export function montarAjusteDeResposta(i: {
  chavePadrao: string;
  opcao: string;
  respostaResumo: string;
  temImagens: boolean;
}): AjusteCandidato | null {
  const padrao = parseChavePadrao(i.chavePadrao);
  if (!padrao) return null;
  const amigavel = AGENTE_NOME_AMIGAVEL[padrao.agentName] ?? padrao.agentName;
  const opcaoLimpa = i.opcao.trim();
  if (!opcaoLimpa) return null;

  const timeErrou = /time.*corrigindo errado|IA estava certa/i.test(opcaoLimpa);
  const titulo = timeErrou
    ? `Alinhar o TIME (a IA estava certa) — ${amigavel}`
    : `Melhorar o ${amigavel} com a regra respondida`;
  const resumo = timeErrou
    ? `A gestão respondeu que o time é que corrige errado neste padrão. Ação sugerida: alinhamento com o time (e possível alerta na tela) — o agente fica como está. Resposta completa: “${i.respostaResumo}”`
    : `Regra aprendida com a gestão: “${i.respostaResumo}”${
      i.temImagens ? " (com print(s) de exemplo anexado(s))" : ""
    }. Aprovando aqui, o agente de repositório escreve a mudança, testa contra os casos históricos e abre o PR pro Caio.`;

  return {
    titulo,
    resumo,
    agenteAlvo: padrao.agentName,
    promptAlvo: PROMPT_ALVO_POR_AGENTE[padrao.agentName] ?? padrao.agentName,
  };
}

// ============================== resumo semanal ==============================

export interface MetricaAgenteSemana {
  agentName: string;
  pares: number;
  seguidas: number;
  corrigidas: number;
  abstencoes: number;
}

export interface ComparativoSemanal {
  agentName: string;
  agenteAmigavel: string;
  paresAtual: number;
  pctAcertoAtual: number | null;
  pctAcertoAnterior: number | null;
  deltaPontos: number | null;
}

export function compararSemanas(
  atual: MetricaAgenteSemana[],
  anterior: MetricaAgenteSemana[],
): ComparativoSemanal[] {
  const pctDe = (m?: MetricaAgenteSemana): number | null => {
    if (!m) return null;
    const avaliadas = m.seguidas + m.corrigidas;
    return avaliadas > 0 ? Math.round((100 * m.seguidas) / avaliadas * 10) / 10 : null;
  };
  const antMap = new Map(anterior.map((m) => [m.agentName, m]));
  return atual
    .map((m) => {
      const pctA = pctDe(m);
      const pctB = pctDe(antMap.get(m.agentName));
      return {
        agentName: m.agentName,
        agenteAmigavel: AGENTE_NOME_AMIGAVEL[m.agentName] ?? m.agentName,
        paresAtual: m.pares,
        pctAcertoAtual: pctA,
        pctAcertoAnterior: pctB,
        deltaPontos: pctA !== null && pctB !== null
          ? Math.round((pctA - pctB) * 10) / 10
          : null,
      };
    })
    .sort((a, b) => b.paresAtual - a.paresAtual);
}

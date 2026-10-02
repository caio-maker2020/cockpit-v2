// =============================================================================
// participantes-email — QUEM escreveu a resposta e PARA QUEM (Carlos 02/10,
// relato da operadora, âncora NF 1042798 PRATI).
//
// O interpretador-resposta-cliente lia só o TEXTO do e-mail: não sabia quem
// estava no Para/Cc nem quem era da Sal. Na NF 1042798 a Ana (PRATI, nome fictício)
// respondeu a todos pedindo "@Bruno [PRATI], enviar a evidência de erro
// cliente" — conversa INTERNA do cliente — e o agente leu como contestação
// dirigida à Sal: lançou a 56 sozinho pela janela de veto.
//
// Este módulo é PURO: lê os cabeçalhos já gravados em messages_inbox.raw_payload
// (from/to/cc) e monta o bloco que entra no prompt, marcando cada pessoa como
// SAL EXPRESS, MESMA EMPRESA DO REMETENTE (colega) ou OUTRA. Quem decide a quem
// o pedido é dirigido continua sendo o modelo (pela leitura do texto) — este
// bloco só entrega o fato que faltava. Trava por regex de "@colega" foi
// DESCARTADA na medição de 02/10: "Devolução autorizada. @Estoque, gentileza
// recepcionar" (Autoglass/AGV) é decisão legítima pra Sal e seria quebrada.
// =============================================================================

export interface Participante {
  nome: string | null;
  email: string;
}

export type PapelParticipante = "sal_express" | "mesma_empresa" | "outra";

/** Domínio da Sal Express (operadores, caixas de relacionamento). */
export const DOMINIO_SAL = "salexpress.com.br";

/** Provedores de e-mail pessoal: dois endereços @gmail NÃO são a mesma empresa. */
export const DOMINIOS_GENERICOS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com",
  "yahoo.com", "yahoo.com.br",
  "hotmail.com", "hotmail.com.br",
  "outlook.com", "outlook.com.br",
  "live.com", "msn.com", "icloud.com", "aol.com", "protonmail.com",
  "bol.com.br", "uol.com.br", "terra.com.br", "ig.com.br",
  "globo.com", "globomail.com", "r7.com", "zipmail.com.br",
]);

const RE_EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

/** Divide um cabeçalho de endereços respeitando aspas e <>:
 *  `"Souza, Maria" <j@x.com>, Ana <a@y.com>` → 2 participantes. */
export function parseListaEnderecos(header: string | null | undefined): Participante[] {
  // raw_payload é jsonb: forma inesperada (lista/objeto) vira "sem cabeçalho",
  // nunca derruba a leitura do e-mail (o bloco roda em TODA resposta).
  if (typeof header !== "string" || !header.trim()) return [];
  const pedacos: string[] = [];
  let atual = "";
  let emAspas = false;
  let emAngulo = false;
  for (const ch of header) {
    if (ch === '"' && !emAngulo) emAspas = !emAspas;
    else if (ch === "<" && !emAspas) emAngulo = true;
    else if (ch === ">" && !emAspas) emAngulo = false;
    if ((ch === "," || ch === ";") && !emAspas && !emAngulo) {
      pedacos.push(atual);
      atual = "";
      continue;
    }
    atual += ch;
  }
  pedacos.push(atual);

  const vistos = new Set<string>();
  const saida: Participante[] = [];
  for (const bruto of pedacos) {
    const p = bruto.trim();
    if (!p) continue;
    const angulo = p.match(/<([^<>]*)>/);
    const alvo = angulo ? angulo[1] : p;
    const m = alvo.match(RE_EMAIL);
    if (!m) continue;
    const email = m[0].toLowerCase();
    if (vistos.has(email)) continue;
    vistos.add(email);
    let nome: string | null = null;
    if (angulo) {
      const antes = p.slice(0, p.indexOf("<")).trim().replace(/^"+|"+$/g, "").trim();
      nome = antes && antes.toLowerCase() !== email ? antes : null;
    }
    saida.push({ nome, email });
  }
  return saida;
}

export function dominioDe(email: string): string {
  return (email.split("@")[1] ?? "").trim().toLowerCase();
}

function mesmoDominioOuSub(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

export function ehDaSal(email: string): boolean {
  return mesmoDominioOuSub(dominioDe(email), DOMINIO_SAL);
}

/** Papel de um participante em relação a QUEM ESCREVEU a resposta. */
export function papelDoParticipante(email: string, emailRemetente: string | null): PapelParticipante {
  if (ehDaSal(email)) return "sal_express";
  const domRem = emailRemetente ? dominioDe(emailRemetente) : "";
  if (!domRem || DOMINIOS_GENERICOS.has(domRem) || ehDaSal(emailRemetente ?? "")) return "outra";
  return mesmoDominioOuSub(dominioDe(email), domRem) ? "mesma_empresa" : "outra";
}

const ROTULO: Record<PapelParticipante, string> = {
  sal_express: "SAL EXPRESS",
  mesma_empresa: "MESMA EMPRESA DO REMETENTE",
  outra: "OUTRA EMPRESA/PESSOA",
};

/** Teto por linha: cabeçalho com 30 cópias não pode afogar o prompt. */
export const MAX_PARTICIPANTES_POR_LINHA = 10;

function formatar(p: Participante): string {
  return p.nome ? `${p.nome} <${p.email}>` : p.email;
}

function linha(rotulo: string, lista: Participante[], emailRemetente: string | null): string {
  if (lista.length === 0) return `- ${rotulo}: (ninguém)`;
  const vis = lista.slice(0, MAX_PARTICIPANTES_POR_LINHA)
    .map((p) => `${formatar(p)} [${ROTULO[papelDoParticipante(p.email, emailRemetente)]}]`);
  const resto = lista.length - vis.length;
  return `- ${rotulo}: ${vis.join("; ")}${resto > 0 ? ` (+${resto} outros)` : ""}`;
}

/**
 * Bloco do prompt. `from` = raw_payload.from (com nome); `remetente` =
 * messages_inbox.remetente (só o e-mail) — fallback quando o from falta.
 * Sem nenhum dado → bloco curto dizendo que o cabeçalho não veio (o modelo
 * decide só pelo texto, como antes).
 */
export function montarBlocoParticipantes(i: {
  from?: string | null;
  remetente?: string | null;
  to?: string | null;
  cc?: string | null;
}): string {
  const de = parseListaEnderecos(i.from)[0] ?? parseListaEnderecos(i.remetente)[0] ?? null;
  const para = parseListaEnderecos(i.to);
  const cc = parseListaEnderecos(i.cc);
  const cab =
    "QUEM ESCREVEU ESTA RESPOSTA E PARA QUEM (cabeçalho do e-mail; [MESMA EMPRESA DO REMETENTE] = colega de quem escreveu):";
  if (!de && para.length === 0 && cc.length === 0) {
    return `${cab}\n- (cabeçalho indisponível — decida só pelo texto)`;
  }
  const emailRem = de?.email ?? null;
  const linhaDe = de
    ? `- De: ${formatar(de)}${ehDaSal(de.email) ? " [SAL EXPRESS]" : ""}`
    : "- De: (desconhecido)";
  return [cab, linhaDe, linha("Para", para, emailRem), linha("Cc", cc, emailRem)].join("\n");
}

// -----------------------------------------------------------------------------
// MENÇÕES DO TEXTO NOVO — sinal DETERMINÍSTICO, independe do modelo (ensaio
// A/B de 02/10: no caso-âncora o modelo acertou numa rodada e errou na outra —
// leu "a imagem abaixo" como prova do motorista. Variação natural medida: a
// MESMA instrução discorda de si mesma em ~12% das respostas).
//
// Só serve para SEGURAR a 56 no autônomo (operadora confere); nunca troca a
// sugestão. Regex de "@colega" como DECISÃO foi descartada: "Devolução
// autorizada. @Estoque, gentileza recepcionar" é decisão legítima pra Sal.
// -----------------------------------------------------------------------------

/** Corta o histórico citado: o que vem antes de "De:", "From:", "Em ... escreveu:", "____". */
const RE_INICIO_CITACAO =
  /\r?\n_{10,}|\r?\nDe: |\r?\nFrom: |\r?\nEnviad[ao] em: |\r?\nEm [^\n]{5,160}escreveu:|\r?\nOn [^\n]{5,160}wrote:/;

export function textoNovoDaResposta(conteudo: string | null | undefined): string {
  if (!conteudo) return "";
  return conteudo.split(RE_INICIO_CITACAO)[0] ?? "";
}

/** Menções no estilo Outlook ("@Nome<mailto:email>") do texto novo. O "@" tem de
 *  abrir a palavra — "logistica@loja.example<mailto:...>" de assinatura NÃO conta. */
export function mencoesDoTextoNovo(conteudo: string | null | undefined): string[] {
  const novo = textoNovoDaResposta(conteudo);
  const re = /(^|[\s,;:(>+'"/|])@([^<\n@]{1,60})<mailto:([^<>\s]+@[^<>\s]+)>/g;
  const vistos = new Set<string>();
  for (const m of novo.matchAll(re)) {
    const email = (m[3] ?? "").toLowerCase();
    if (RE_EMAIL.test(email)) vistos.add(email);
  }
  return [...vistos];
}

/**
 * O texto novo marca com "@" SÓ quem não é da Sal, e não fala com a Sal pelo
 * nome (operadora, "Sal Express", "transportadora")? Classe NF 1042798:
 * "@Bruno [PRATI], enviar a evidência de erro cliente..." Sem menção nenhuma →
 * false (nada a dizer; comportamento de hoje).
 */
export function soMencionaQuemNaoEDaSal(i: {
  conteudo: string | null | undefined;
  operadoraNome?: string | null;
}): boolean {
  const mencoes = mencoesDoTextoNovo(i.conteudo);
  if (mencoes.length === 0) return false;
  if (mencoes.some(ehDaSal)) return false;
  const novo = textoNovoDaResposta(i.conteudo).toLowerCase();
  if (/sal\s*express|salexpress|transportadora/.test(novo)) return false;
  const primeiroNome = ((i.operadoraNome ?? "").trim().split(/\s+/)[0] ?? "").toLowerCase();
  if (primeiroNome.length >= 3 && /^\p{L}+$/u.test(primeiroNome)) {
    const reNome = new RegExp("(^|[^\\p{L}])" + primeiroNome + "([^\\p{L}]|$)", "u");
    if (reNome.test(novo)) return false;
  }
  return true;
}

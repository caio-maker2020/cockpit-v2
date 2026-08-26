// =============================================================================
// cerebro-veto — o CÉREBRO do loop de aprendizado da janela de veto
// (Caio 26/08: "pode construir"). Lógica PURA e testável; o I/O vive na edge
// cerebro-veto-dossie.
//
// Fluxo: cancelamentos + correções capturadas + edições da semana →
// classificação do "o que leu errado" numa TAXONOMIA FIXA (Haiku) → separa
// vetos SEM divergência (correção = a própria ação vetada: NÃO treinam o
// agente — viram treinamento de operador; regra nascida do 1º veto real,
// NF 120149) → agrupa por agente × ação × categoria → padrão com n≥2 ganha
// PROPOSTA de regra (Sonnet) → learning_log + conversa no chat do
// Aprendizado → replay nos gabaritos → ordem do Caio → deploy → o placar
// mede se o veto do padrão zerou.
// =============================================================================

/** Taxonomia FIXA do "o que o agente leu errado" — texto livre vira dado
 *  agregável. Mudar categoria = quebra série histórica; adicionar no fim. */
export const TAXONOMIA_VETO = {
  leu_autorizacao_inexistente:
    "O robô entendeu que o cliente autorizou/confirmou algo que ele NÃO autorizou (intenção ≠ autorização)",
  nao_viu_informacao_no_card:
    "A informação correta ESTAVA no card (e-mail, histórico, anexo) e o robô não a considerou",
  timing_prematuro:
    "A ação era certa mas cedo demais (cliente pediu prazo, aguardar algo antes)",
  acao_certa_conteudo_errado:
    "A ação/oc era certa, mas o conteúdo estava errado (texto, template, destinatário, anexo)",
  excecao_do_cliente:
    "Regra particular deste cliente que o robô não conhece (processo próprio, contato obrigatório etc.)",
  thread_ou_contato_errado:
    "E-mail ia pra conversa/pessoa errada",
  dado_desatualizado_no_card:
    "O card mostrava dado velho (oc/histórico desatualizado) e a decisão partiu dele",
  outro: "Não se encaixa em nenhuma das anteriores",
} as const;

export type CategoriaVeto = keyof typeof TAXONOMIA_VETO;

export const CATEGORIAS_VETO = Object.keys(TAXONOMIA_VETO) as CategoriaVeto[];

/** Divergência entre o veto e a correção capturada.
 *  - 'sem_divergencia': operador cancelou e depois fez A MESMA ação → o veto
 *    NÃO treina o agente (vira nota de operador). Guard do dossiê (INV-103).
 *  - 'pendente': operador ainda não agiu — o par está incompleto.
 *  - 'divergente': fez outra coisa — par de treino válido. */
export type Divergencia = "sem_divergencia" | "pendente" | "divergente";

export function divergenciaDoVeto(
  acaoKeyVetada: string,
  correcaoAcaoKey: string | null | undefined,
): Divergencia {
  if (!correcaoAcaoKey) return "pendente";
  return correcaoAcaoKey === acaoKeyVetada ? "sem_divergencia" : "divergente";
}

export interface VetoClassificado {
  cardId: string;
  nf: string | null;
  agente: string;
  acaoKey: string;
  ciclo: number | null;
  operador: string;
  categoria: CategoriaVeto;
  leuErrado: string;
  infoNoCockpit: string | null;
  excecaoCliente: boolean;
  correcaoAcaoKey: string | null;
  divergencia: Divergencia;
}

export interface PadraoVeto {
  agente: string;
  acaoKey: string;
  categoria: CategoriaVeto;
  n: number;
  nfs: string[];
  cardIds: string[];
  exemplos: string[]; // "o que leu errado" verbatim (até 3)
  correcoes: Record<string, number>; // acao_key da correção → contagem
  pendentes: number; // vetos ainda sem correção capturada
}

/**
 * PURO: agrupa os vetos DIVERGENTES (+pendentes, contados à parte) em padrões
 * por agente × ação × categoria. Vetos sem_divergencia NUNCA entram — guard
 * INV-103: o agente não aprende com veto que o próprio operador desdisse.
 */
export function agruparPadroes(vetos: readonly VetoClassificado[]): PadraoVeto[] {
  const m = new Map<string, PadraoVeto>();
  for (const v of vetos) {
    if (v.divergencia === "sem_divergencia") continue;
    const k = `${v.agente}|${v.acaoKey}|${v.categoria}`;
    let p = m.get(k);
    if (!p) {
      p = {
        agente: v.agente, acaoKey: v.acaoKey, categoria: v.categoria,
        n: 0, nfs: [], cardIds: [], exemplos: [], correcoes: {}, pendentes: 0,
      };
      m.set(k, p);
    }
    p.n++;
    if (v.nf && !p.nfs.includes(v.nf)) p.nfs.push(v.nf);
    if (!p.cardIds.includes(v.cardId)) p.cardIds.push(v.cardId);
    if (p.exemplos.length < 3) p.exemplos.push(v.leuErrado);
    if (v.divergencia === "pendente") p.pendentes++;
    else if (v.correcaoAcaoKey) {
      p.correcoes[v.correcaoAcaoKey] = (p.correcoes[v.correcaoAcaoKey] ?? 0) + 1;
    }
  }
  return [...m.values()].sort((a, b) => b.n - a.n);
}

export interface EdicaoResumo {
  acaoKey: string;
  campo: string;
  n: number;
  exemplo: { antes: string; depois: string } | null;
}

/** PURO: agrega edições por ação × campo (micro-loop de conteúdo). */
export function resumirEdicoes(
  edicoes: readonly { acaoKey: string; campo: string; antes: string | null; depois: string | null }[],
): EdicaoResumo[] {
  const m = new Map<string, EdicaoResumo>();
  for (const e of edicoes) {
    const k = `${e.acaoKey}|${e.campo}`;
    let r = m.get(k);
    if (!r) {
      r = { acaoKey: e.acaoKey, campo: e.campo, n: 0, exemplo: null };
      m.set(k, r);
    }
    r.n++;
    if (!r.exemplo && e.antes != null && e.depois != null) {
      r.exemplo = { antes: e.antes.slice(0, 160), depois: e.depois.slice(0, 160) };
    }
  }
  return [...m.values()].sort((a, b) => b.n - a.n);
}

// ── Prompts ──────────────────────────────────────────────────────────────────

/** System do classificador (Haiku — triagem, convenção nº 7). */
export const SYSTEM_CLASSIFICACAO =
  `Você classifica o motivo de um operador ter CANCELADO uma ação automática ` +
  `numa transportadora. Responda EXCLUSIVAMENTE um JSON {"categoria": "<id>"} ` +
  `com um destes ids:\n` +
  CATEGORIAS_VETO.map((c) => `- ${c}: ${TAXONOMIA_VETO[c]}`).join("\n");

export function montarPromptClassificacao(v: {
  acaoKey: string;
  leuErrado: string;
  ondeOlhou: string[];
  infoNoCockpit: string | null;
  excecaoCliente: boolean;
  excecaoQual: string | null;
}): string {
  return (
    `Ação cancelada: ${v.acaoKey}\n` +
    `O operador escreveu (o que o robô leu errado): "${v.leuErrado}"\n` +
    `Onde o operador olhou: ${v.ondeOlhou.join(", ") || "(nada marcado)"}\n` +
    `A informação existia dentro do sistema? ${v.infoNoCockpit ?? "(não respondido)"}\n` +
    `Exceção do cliente? ${v.excecaoCliente ? `sim — "${v.excecaoQual ?? ""}"` : "não"}`
  );
}

/** System do redator de proposta (Sonnet — especialista, convenção nº 7). */
export const SYSTEM_PROPOSTA =
  `Você é o engenheiro de regras dos agentes do Cockpit (transportadora Sal ` +
  `Express). Recebe um PADRÃO de cancelamentos de ação autônoma e escreve uma ` +
  `proposta OBJETIVA de correção. Formato: (1) REGRA PROPOSTA em 1-3 frases ` +
  `imperativas e testáveis; (2) ONDE (prompt do agente / cerca determinística ` +
  `/ template — escolha um e justifique em 1 frase); (3) RISCO (o que pode ` +
  `piorar se a regra for aplicada, 1 frase). Sem preâmbulo, sem despedida. ` +
  `Nunca proponha desligar a autonomia — proponha corrigir a leitura.`;

export function montarPromptProposta(p: PadraoVeto): string {
  const correcoes = Object.entries(p.correcoes)
    .map(([k, n]) => `${k} (${n}x)`)
    .join(", ") || "(nenhuma capturada ainda)";
  return (
    `Agente: ${p.agente}\nAção cancelada: ${p.acaoKey}\n` +
    `Categoria do erro: ${p.categoria} — ${TAXONOMIA_VETO[p.categoria]}\n` +
    `Ocorrências: ${p.n} (NFs: ${p.nfs.join(", ")})\n` +
    `O que os operadores escreveram:\n` +
    p.exemplos.map((e) => `- "${e}"`).join("\n") +
    `\nO que fizeram em seguida (correção capturada): ${correcoes}`
  );
}

// ── Dossiê ───────────────────────────────────────────────────────────────────

export function montarDossieMd(i: {
  periodo: string;
  totalVetos: number;
  padroes: (PadraoVeto & { proposta?: string | null })[];
  semDivergencia: { operador: string; nf: string | null; acaoKey: string }[];
  pendentes: number;
  edicoes: EdicaoResumo[];
}): string {
  const linhas: string[] = [];
  linhas.push(`# Dossiê da janela de veto — ${i.periodo}`);
  linhas.push(
    `${i.totalVetos} cancelamento(s) no período · ${i.pendentes} com correção ainda pendente.`,
  );

  linhas.push(`\n## Padrões (candidatos a regra — replay antes de aplicar)`);
  if (i.padroes.length === 0) linhas.push(`Nenhum padrão com repetição no período.`);
  for (const p of i.padroes) {
    linhas.push(`\n### ${p.agente} · ${p.acaoKey} · ${p.categoria} (${p.n}x)`);
    linhas.push(`NFs-gabarito: ${p.nfs.join(", ")}`);
    for (const e of p.exemplos) linhas.push(`> "${e}"`);
    const corr = Object.entries(p.correcoes).map(([k, n]) => `${k} (${n}x)`).join(", ");
    linhas.push(`Correção capturada: ${corr || "(pendente)"}`);
    if (p.proposta) linhas.push(`\n**Proposta:**\n${p.proposta}`);
  }

  linhas.push(`\n## Vetos SEM divergência — treinamento de OPERADOR, não do agente`);
  if (i.semDivergencia.length === 0) linhas.push(`Nenhum.`);
  for (const s of i.semDivergencia) {
    linhas.push(`- ${s.operador} vetou ${s.acaoKey} (NF ${s.nf ?? "?"}) e depois fez a MESMA ação`);
  }

  linhas.push(`\n## Edições na janela (micro-loop de conteúdo)`);
  if (i.edicoes.length === 0) linhas.push(`Nenhuma edição no período.`);
  for (const e of i.edicoes) {
    linhas.push(`- ${e.acaoKey} · ${e.campo}: ${e.n}x` +
      (e.exemplo ? ` — ex.: "${e.exemplo.antes}" → "${e.exemplo.depois}"` : ""));
  }

  linhas.push(
    `\n---\n*Nada aqui vira regra sozinho: padrão → replay nas NFs-gabarito → ordem do Caio → deploy.*`,
  );
  return linhas.join("\n");
}

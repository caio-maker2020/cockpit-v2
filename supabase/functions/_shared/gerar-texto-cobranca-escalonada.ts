// Caio 2026-05-19 (PRIORIDADES AI):
// Helper Sonnet 4.6 — gera texto de cobrança escalonada parametrizado por
// (papel × oc_origem 13/21 × histórico_cobranças_anteriores × canal).
//
// Reusado pelos endpoints sugerir-cobranca-ai (preview no modal) e
// disparar-cobranca-escalonada (quando operador envia sem editar).

import {
  createAnthropicClient,
  readAnthropicEnvFromProcess,
} from "./anthropic-client.ts";

const MODEL = "claude-sonnet-4-6";

export type Papel = "gerente_base" | "coordenador_entrega" | "gerente_relacionamento";
export type Canal = "email" | "whatsapp";

export interface GerarTextoArgs {
  papel: Papel;
  canal: Canal;
  oc_origem: 13 | 21;
  nf: string;
  ctrc: string | null;
  base: string | null;
  empresa_cliente: string | null;
  dias_uteis_parados: number;
  contato_destinatario_nome: string | null;
  contato_destinatario_cargo_humanizado: string;
  operador_nome: string;
  // Histórico das cobranças anteriores (texto + papel + canal + data) — pra
  // tom escalado
  cobrancas_anteriores: Array<{
    papel: Papel;
    canal: Canal;
    disparado_em: string; // ISO
    contato_nome: string | null;
  }>;
}

export interface GerarTextoResult {
  assunto: string;
  texto: string;
  rationale: string;
  modelo: string;
  tokens_input?: number;
  tokens_output?: number;
}

const SYSTEM_PROMPT_BASE = `Você gera mensagens de cobrança operacional pra base/gerência da Sal Express (transportadora B2B). Contexto: NF do cliente está parada há X dias sem movimentação no SSW (oc=21 reentrega solicitada ou oc=13 mudança de endereço pelo destinatário). Operador precisa cobrar quem destrava na base/gerência.

REGRAS GERAIS:
- Português PT-BR
- NUNCA invente dados — só use o que está no contexto
- Mencione NF, CTRC quando houver, dias parados, base
- Tom escalado quando há cobranças anteriores no mesmo card
- Devolva EXCLUSIVAMENTE JSON: { "assunto", "texto", "rationale" }
  (assunto pode ser null/vazio em canal=whatsapp)

###############################################
TOM POR CANAL — DIFERENÇA É CRÍTICA
###############################################

📱 **WhatsApp** — tom INFORMAL DE COLEGA DE TRABALHO
- Operador da Sal CONVERSA TODO DIA com essas pessoas (gerentes, coordenadores). Tratamento de gente que já se conhece.
- Mensagem CURTA: 150-400 chars. NÃO ultrapassar 500.
- **Saudação NEUTRA de horário** — NÃO usar "Bom dia/Boa tarde/Boa noite" porque a mensagem pode chegar em qualquer momento e ficar fora de hora. Use:
  - "Opa, beleza?" (mais comum)
  - "E aí, [nome se souber]"
  - "Oi [nome se souber], tudo bem?"
  - "[Nome se souber], tô precisando da sua ajuda aqui"
- Vai direto ao ponto: NF + cliente pagador, dias parados, o que precisa.
- **PADRÃO DE PEDIDO**: sempre incluir o objetivo concreto "a carga precisa sair pra entrega" (ou variantes naturais: "a gente precisa que essa carga saia amanhã", "precisa sair pra entrega o quanto antes", "preciso que essa saia amanhã sem falta"). Não deixar pedido vago.
- **NÃO citar CTRC no WhatsApp.** Padrão é NF + nome do cliente pagador (sem CTRC, sem chave). Email PODE citar CTRC.
- **NÃO assinar com nome do operador no final.** WhatsApp já mostra quem mandou. NADA de "— Larissa", "— Duilio", "Atte. Operador". Mensagem termina natural ("Obrigado!", "fica no aguardo", "qualquer coisa me chama") sem assinatura.
- Pode usar contrações naturais ("tá", "tô", "pra", "consegue ver", "me dá um retorno").
- Termina natural: "me retorna quando puder", "qualquer coisa me chama", "fica no aguardo", "obrigado!". NÃO usar "Atenciosamente" no WhatsApp.
- Exemplo (gerente_base, 1ª cobrança):
  > "Opa Ana, beleza? A NF 750587 da Cooperativa tá parada há 3 dias úteis aí na VGA aguardando reentrega. Preciso que essa saia pra entrega amanhã sem falta. Consegue ver com a equipe o que tá travando? Me dá um retorno por favor. Obrigado!"
- Exemplo (coordenador_entrega, escalado após gerente não responder):
  > "Bruno, beleza? Já cobrei a Ana 2x na base VGA sobre a NF 750587 (Cooperativa, 5 dias úteis parada) e ainda sem retorno. Precisa sair pra entrega o quanto antes — pode dar uma olhada pra mim? Cliente já tá cobrando aqui."
- Exemplo (gerente_relacionamento, escalada executiva):
  > "Maria, preciso da sua ajuda na NF 750587 (Cooperativa Agro) — 8 dias úteis parada em VGA, gerente e coordenador já foram cobrados sem retorno. Cliente tá no meu pé. Consegue acionar a base hoje pra essa sair amanhã?"

📧 **Email** — tom PROFISSIONAL MAS NÃO RÍGIDO
- Português PT-BR profissional, mas natural — sem floreios excessivos.
- 1500-2500 chars (estruturado: saudação curta + contexto + pedido objetivo + despedida).
- Saudação curta: "Bom dia Ana," (sem "Prezada Sra.", sem "Espero encontrá-la bem")
- Assinatura ao final com nome do operador + "Sal Express — Relacionamento"
- Despedida: "Aguardo seu retorno." / "Qualquer dúvida, estou à disposição." / "Obrigado."
- NÃO usar "Atenciosamente" como assinatura — preferir "Obrigado," ou "Abraços,"

TOM POR PAPEL (vale pra ambos canais):
- **gerente_base**: cobrança direta, foco em retorno operacional. "Consegue ver o que tá travando? Vai sair hoje?"
- **coordenador_entrega**: tom escalado — menciona que gerente foi cobrado mas sem retorno, pede intervenção da coordenação. "Já cobrei [nome do gerente] sem retorno"
- **gerente_relacionamento**: alerta executivo — menciona risco com cliente, dias parados, escalações anteriores. Pede intervenção imediata. Não dramatize — só apresente os fatos.

OUTRAS REGRAS:
- Se houver cobranças anteriores no histórico, mencione naturalmente ("já cobrei 2x", "ontem te chamei sobre essa", etc) — INFORMAL no WhatsApp, FACTUAL no email.
- NÃO invente nome do destinatário se não estiver no contexto. Se contato_destinatario_nome vier vazio, NÃO use primeiro nome (use saudação genérica "Bom dia,").
- Sempre cite a NF (e CTRC quando houver). É a referência principal.`;

function humanizarPapel(papel: Papel): string {
  switch (papel) {
    case "gerente_base": return "Gerente da Base";
    case "coordenador_entrega": return "Coordenador de Entrega";
    case "gerente_relacionamento": return "Gerente de Relacionamento";
  }
}

function descricaoOcOrigem(oc: 13 | 21): string {
  if (oc === 21) return "oc=21 (reentrega solicitada pelo cliente — aguardando saída pra entrega/oc=14)";
  return "oc=13 (cliente mudou endereço ou solicitou alteração — base parou movimentação)";
}

export async function gerarTextoCobrancaEscalonada(
  env: Record<string, string | undefined>,
  args: GerarTextoArgs,
): Promise<GerarTextoResult> {
  const anthropic = createAnthropicClient({ env: readAnthropicEnvFromProcess(env) });

  const contextoOc = descricaoOcOrigem(args.oc_origem);
  const histLinhas = args.cobrancas_anteriores.length === 0
    ? "(nenhuma cobrança anterior — esta é a 1ª)"
    : args.cobrancas_anteriores
        .map((c) => `- ${c.disparado_em}: ${humanizarPapel(c.papel)} via ${c.canal}${c.contato_nome ? ` (${c.contato_nome})` : ""}`)
        .join("\n");

  const userPrompt = [
    `Operador: ${args.operador_nome}`,
    `Canal alvo: ${args.canal.toUpperCase()}`,
    `Papel a cobrar agora: ${humanizarPapel(args.papel)}${args.contato_destinatario_nome ? ` — ${args.contato_destinatario_nome}` : ""}`,
    "",
    `NF: ${args.nf}`,
    `CTRC: ${args.ctrc ?? "?"}`,
    `Base: ${args.base ?? "?"}`,
    `Cliente: ${args.empresa_cliente ?? "?"}`,
    `Dias úteis parados: ${args.dias_uteis_parados.toFixed(1)}`,
    `Contexto da oc atual: ${contextoOc}`,
    "",
    "Cobranças anteriores nesse card:",
    histLinhas,
    "",
    `Gere o texto de cobrança pra ${humanizarPapel(args.papel)} via ${args.canal}.`,
  ].join("\n");

  const out = await anthropic.completeJson<{ assunto?: string; texto: string; rationale?: string }>({
    model: MODEL,
    system: SYSTEM_PROMPT_BASE,
    messages: [{ role: "user", content: userPrompt }],
    maxTokens: 1200,
    temperature: 0.4,
  });

  return {
    assunto: (out.assunto ?? "").slice(0, 200),
    texto: (out.texto ?? "").trim(),
    rationale: (out.rationale ?? "").slice(0, 500),
    modelo: MODEL,
  };
}

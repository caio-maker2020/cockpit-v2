// Caio 2026-05-14 (multi-operador onboarding Duilio):
// Carrega o prompt de voz ativo de um operador (tabela voz_templates).
// Substitui hardcoding "Larissa" nos prompts de redator + redator-email-saida.
//
// Comportamento:
// - operadorId != null + voz ativa encontrada → retorna {prompt, versao, fonte: 'operador'}
// - operadorId null OU sem voz ativa → retorna {prompt: genérico, versao: 0, fonte: 'generico'}
//
// O fallback genérico é neutro (sem nome próprio). Operador sem voz cadastrada
// ainda funciona — Larissa SEMPRE tem voz por causa do seed na migration 098.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

// Prompt fallback usado quando operador não tem voz cadastrada. Mantém regras
// estruturais (Output JSON + anti-invenção) mas sem voz/assinatura específica.
// Operador novo entra usando este até preencher questionário.
export const REDATOR_SYSTEM_PROMPT_GENERICO = String.raw`# Redator — Cockpit Sal Express

Você é o **redator** que escreve sugestões de resposta pra clientes da Sal
Express, transportadora B2B em MG e ES. A operadora humana vai revisar,
editar e enviar.

## Sua missão

Dado o contexto do card (mensagem do cliente, tipo, ação tomada/pendente),
gerar UM texto de resposta que a operadora possa mandar como está OU editar
rapidamente. **Não soa como robô.**

## Tom geral

- **Acolhedor**, não formal demais. Sal Express atende clientes B2B (farmácias, distribuidoras), mas o relacionamento é direto e humano.
- **Direto ao ponto**. Cliente está cobrando informação ou autorização, não quer ler 5 parágrafos.
- **Confiante**, sem se desculpar excessivamente.
- Português brasileiro coloquial profissional. Nunca "Prezado", "Acuso recebimento", "Em atenção ao seu".

## Estrutura padrão (não rígida)

1. Saudação curta personalizada usando 'nome_cliente' quando disponível, senão "Olá!"
2. Confirmação do que o cliente disse + ação tomada
3. Próximos passos OU info que a operadora precisa do cliente
4. Despedida curta — "Qualquer coisa me chama", "Fico no aguardo", "Abraço"
5. Assinatura — usa o nome do operador fornecido no contexto (variável {operador_nome}), seguido de "- Relacionamento Sal Express"

## Regras anti-erro

- **Nunca invente fatos** que não estão no contexto.
- **Nunca prometa coisa que depende de outro setor** sem hedge.
- **NF e CT-e**: se aparecer no contexto, sempre cita.
- **Tamanho**: 3-6 linhas no máximo.

## Output — JSON Schema

Devolva EXCLUSIVAMENTE este JSON. Sem markdown, sem comentário antes ou
depois.

{
  "texto": "string com o corpo do email (já com saudação, conteúdo, despedida, assinatura)",
  "assunto_sugerido": "string curta pra subject do email (max 60 chars). null se for resposta em thread existente",
  "rationale": "string 1 frase explicando por que escolheu esse tom/conteúdo (pra debug)",
  "confianca": "alta | media | baixa"
}

confianca = "baixa" quando faltar contexto importante (ex: nome do cliente,
referência da NF, ação tomada).`;

export interface VozTemplateLoaded {
  prompt: string;
  versao: number;
  fonte: "operador" | "generico";
}

export async function loadVozTemplate(
  supabase: SupabaseClient,
  operadorId: string | null | undefined,
): Promise<VozTemplateLoaded> {
  if (!operadorId) {
    return { prompt: REDATOR_SYSTEM_PROMPT_GENERICO, versao: 0, fonte: "generico" };
  }
  const { data } = await supabase
    .from("voz_templates")
    .select("prompt_system, versao")
    .eq("operador_id", operadorId)
    .eq("ativo", true)
    .maybeSingle();
  if (data?.prompt_system) {
    return {
      prompt: data.prompt_system as string,
      versao: (data.versao as number) ?? 0,
      fonte: "operador",
    };
  }
  return { prompt: REDATOR_SYSTEM_PROMPT_GENERICO, versao: 0, fonte: "generico" };
}

// =============================================================================
// analisar-indicador-erros-lancamento — agente IA Sonnet 4.6 que interpreta
// os dados do indicador "Erros de Lançamento da Base" e produz:
//   - Resumo executivo
//   - Métricas-chave com delta vs período anterior
//   - O que melhorou / piorou
//   - Sugestões de melhoria (treinamento, processo)
//   - Sugestões de automação (preventivo no SSW, alertas)
//   - Cobranças recomendadas com textos prontos pra envio (email)
//
// Cache via tabela analises_ia_indicadores (TTL 24h por filtro). flag
// forcar_refresh=true ignora cache. Próximos indicadores reusam mesma infra
// trocando indicador_tipo + dados de input.
//
// Caio 2026-05-18.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  createAnthropicClient,
  readAnthropicEnvFromProcess,
} from "../_shared/anthropic-client.ts";

const MODEL = "claude-sonnet-4-6";
const INDICADOR_TIPO = "erros_lancamento_base";
const CACHE_TTL_HORAS = 24;

const SYSTEM_PROMPT = `Você é um agente de análise de indicadores operacionais de uma transportadora (Sal Express). Seu papel é interpretar dados de erros de lançamento de ocorrências feitos pelas bases SSW, identificar padrões e gerar análise estruturada.

Existem 2 CATEGORIAS de erro reportadas pelos operadores:

- **OC_DIFERENTE**: base lançou uma ocorrência X mas deveria ter lançado Y (códigos diferentes). Ex: lançou oc=35 (recusa parcial) quando era oc=49 (tratativa).
- **EVIDENCIA_INCOMPLETA**: base lançou a OC CORRETA mas a evidência (foto, observação, anexo) está incorreta/incompleta/indevida. Ex: foto desfocada, sem assinatura, NF errada visível, foto não mostra a recusa, foto de outro pedido. Nesses casos, o operador descreve no campo "motivo" o que exatamente estava errado.

Sua tarefa:

1. **Resumo executivo** — 2-3 frases sobre saúde geral do indicador no período (mencione AMBAS categorias se ambas têm dados).
2. **Métricas-chave** com delta vs período anterior (tendência: melhorando/piorando/estável). Inclua pelo menos 1 métrica POR CATEGORIA quando houver dados das duas.
3. **Destaques de melhoria** — bases/usuários que reduziram erros (em qualquer categoria).
4. **Destaques de piora** — bases/usuários com aumento, novas categorias de erro emergentes. Para EVIDENCIA_INCOMPLETA, agrupe os textos livres em sub-padrões (ex: "Varginha: 4 reports de foto desfocada", "BHZ: 2 reports de assinatura ilegível").
5. **Sugestões de melhoria** — ações concretas (treinamento focado em foto/evidência, revisão de processo de assinatura) com base/usuário-alvo + prioridade. Para EVIDENCIA_INCOMPLETA, sugira treinamentos práticos específicos por sub-padrão detectado.
6. **Sugestões de automação** — workflows automatizados que evitariam o erro (alertas, validações, regras preventivas). Para EVIDENCIA_INCOMPLETA, sugira IA de validação de foto no lançamento (ex: "validar borrão antes do lançamento via Vision").
7. **Cobranças recomendadas** — emails prontos pra enviar pra responsáveis (gerentes de base, gestores). Inclua \`destinatario_sugerido\`, \`assunto_sugerido\` e \`corpo_sugerido\` (HTML simples, parágrafos curtos, tom direto e profissional). Use \`urgencia\` ∈ {baixa, média, alta} baseado em volume/tendência. O corpo deve ser pronto pra envio sem edição (mas o operador pode editar antes). Quando o problema for EVIDENCIA_INCOMPLETA, mencione os exemplos específicos textuais reportados pelos operadores no email (sem inventar — só usar o que tem em motivo).
8. **Classificação de evidência incompleta** — categorize os textos livres (motivo) em sub-tipos. Use o conjunto fixo de sub-tipos abaixo. Sempre extraia os sub-tipos APENAS dos textos REAIS reportados (nunca invente):
   - FOTO_DESFOCADA_OU_ILEGIVEL
   - FOTO_NAO_MOSTRA_OCORRENCIA (ex: foto não mostra a recusa, foto não comprova entrega)
   - FOTO_DE_OUTRA_NF_OU_PEDIDO
   - SEM_ASSINATURA_OU_ASSINATURA_ILEGIVEL
   - ENDERECO_INCORRETO_VISIVEL
   - INFORMACAO_INCOMPLETA_NA_OBSERVACAO
   - OUTRO (quando não cai nas categorias acima — explicite no campo)

Tom: profissional, direto, sem rodeios. Português brasileiro. Foco em ação.

Retorne EXCLUSIVAMENTE JSON válido neste schema (não adicione markdown ou texto fora do JSON):

{
  "resumo_geral": "string",
  "metricas_chave": [
    { "label": "string", "valor": "string", "delta_pct": number|null, "tendencia": "melhorando"|"piorando"|"estavel" }
  ],
  "melhoria_destaques": [
    { "base": "string", "descricao": "string", "evidencia": "string" }
  ],
  "piora_destaques": [
    { "base": "string", "descricao": "string", "evidencia": "string", "severidade": "alta"|"media"|"baixa" }
  ],
  "sugestoes_melhoria": [
    { "titulo": "string", "descricao": "string", "base_alvo": "string", "prioridade": "alta"|"media"|"baixa" }
  ],
  "sugestoes_automacao": [
    { "titulo": "string", "descricao": "string", "escopo": "preventivo"|"reativo"|"comunicacao", "dificuldade": "baixa"|"media"|"alta" }
  ],
  "cobrancas_recomendadas": [
    {
      "destinatario_sugerido": "string (email ou nome+contexto)",
      "assunto_sugerido": "string ≤80 chars",
      "corpo_sugerido": "string HTML com parágrafos curtos",
      "urgencia": "alta"|"media"|"baixa",
      "canal": "email"
    }
  ],
  "evidencia_incompleta_sub_tipos": [
    {
      "sub_tipo": "FOTO_DESFOCADA_OU_ILEGIVEL"|"FOTO_NAO_MOSTRA_OCORRENCIA"|"FOTO_DE_OUTRA_NF_OU_PEDIDO"|"SEM_ASSINATURA_OU_ASSINATURA_ILEGIVEL"|"ENDERECO_INCORRETO_VISIVEL"|"INFORMACAO_INCOMPLETA_NA_OBSERVACAO"|"OUTRO",
      "total": number,
      "exemplos_textuais": ["string (texto literal do operador, ≤120 chars)"]
    }
  ]
}

Se não houver dados suficientes pra alguma seção, retorne array vazio []. Sempre retorne TODAS as chaves do schema, incluindo evidencia_incompleta_sub_tipos.`;

interface InputBody {
  filtro_periodo_dias?: number;
  filtro_bases?: string[];
  forcar_refresh?: boolean;
}

interface AgregadoRow {
  base_responsavel: string;
  usuario_responsavel: string;
  codigo_oc_errada: number;
  codigo_oc_correta: number;
  motivo_categoria: string;
  total_erros: number;
  primeiro_erro: string;
  ultimo_erro: string;
  // Pra EVIDENCIA_INCOMPLETA: lista de textos livres descrevendo o erro
  motivos_textuais?: string[];
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const env = Deno.env.toObject();
    const supabase = createClient(env["SUPABASE_URL"]!, env["SUPABASE_SERVICE_ROLE_KEY"]!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const body = await req.json().catch(() => ({})) as InputBody;
    const periodoDias = body.filtro_periodo_dias ?? 30;
    const bases = (body.filtro_bases ?? []).filter((b) => typeof b === "string" && b.trim().length > 0);
    const forcarRefresh = body.forcar_refresh === true;

    // Chave de cache canônica (mesmo filtros = mesma chave)
    const filtros = {
      periodo_dias: periodoDias,
      bases: bases.slice().sort(),
    };

    // 1. Tenta cache (TTL 24h) — só pra mesma indicador_tipo + filtros idênticos
    if (!forcarRefresh) {
      const limiarTtl = new Date(Date.now() - CACHE_TTL_HORAS * 60 * 60 * 1000).toISOString();
      const { data: cache } = await supabase
        .from("analises_ia_indicadores")
        .select("id, resultado, gerado_em")
        .eq("indicador_tipo", INDICADOR_TIPO)
        .gte("gerado_em", limiarTtl)
        .filter("filtros", "eq", JSON.stringify(filtros))
        .order("gerado_em", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cache?.resultado) {
        return json({ ok: true, resultado: cache.resultado, gerado_em: cache.gerado_em, cache: true });
      }
    }

    // 2. Carrega dados período atual + período anterior pra calcular delta
    const inicioAtual = new Date(Date.now() - periodoDias * 24 * 60 * 60 * 1000);
    const inicioAnterior = new Date(Date.now() - 2 * periodoDias * 24 * 60 * 60 * 1000);
    const fimAnterior = inicioAtual;

    const queryBase = (inicio: Date, fim: Date | null) => {
      let q = supabase
        .from("erros_lancamento_ssw")
        .select("base_responsavel, usuario_responsavel, codigo_oc_errada, codigo_oc_correta, motivo, motivo_categoria, created_at")
        .gte("created_at", inicio.toISOString());
      if (fim) q = q.lt("created_at", fim.toISOString());
      if (bases.length > 0) q = q.in("base_responsavel", bases);
      return q;
    };

    const [{ data: atualRaw }, { data: anteriorRaw }] = await Promise.all([
      queryBase(inicioAtual, null),
      queryBase(inicioAnterior, fimAnterior),
    ]);

    // Caio 2026-05-21: agrupa por (base, usuario, oc_errada, oc_correta, categoria).
    // EVIDENCIA_INCOMPLETA gera linha separada mesmo com mesmas ocs — a IA precisa
    // distinguir "lançou oc errada" de "oc correta mas evidência inadequada".
    // Coleta motivos textuais (max 5 por grupo) pra IA classificar sub-tipos.
    const agruparPorErro = (rows: Array<Record<string, unknown>>): AgregadoRow[] => {
      const map = new Map<string, AgregadoRow>();
      for (const r of rows ?? []) {
        const categoria = (r.motivo_categoria as string | null) ?? "OC_DIFERENTE";
        const k = `${r.base_responsavel}|${r.usuario_responsavel}|${r.codigo_oc_errada}|${r.codigo_oc_correta}|${categoria}`;
        const created = r.created_at as string;
        const motivo = (r.motivo as string | null)?.trim();
        const ex = map.get(k);
        if (ex) {
          ex.total_erros += 1;
          if (created < ex.primeiro_erro) ex.primeiro_erro = created;
          if (created > ex.ultimo_erro) ex.ultimo_erro = created;
          if (categoria === "EVIDENCIA_INCOMPLETA" && motivo && ex.motivos_textuais!.length < 5) {
            ex.motivos_textuais!.push(motivo);
          }
        } else {
          map.set(k, {
            base_responsavel: r.base_responsavel as string,
            usuario_responsavel: r.usuario_responsavel as string,
            codigo_oc_errada: r.codigo_oc_errada as number,
            codigo_oc_correta: r.codigo_oc_correta as number,
            motivo_categoria: categoria,
            total_erros: 1,
            primeiro_erro: created,
            ultimo_erro: created,
            motivos_textuais: categoria === "EVIDENCIA_INCOMPLETA" && motivo ? [motivo] : [],
          });
        }
      }
      return [...map.values()].sort((a, b) => b.total_erros - a.total_erros);
    };

    const periodoAtual = agruparPorErro((atualRaw ?? []) as Array<Record<string, unknown>>);
    const periodoAnterior = agruparPorErro((anteriorRaw ?? []) as Array<Record<string, unknown>>);

    // Se não houver dados, retorna resultado vazio sem chamar IA (economiza tokens)
    if (periodoAtual.length === 0 && periodoAnterior.length === 0) {
      const vazio = {
        resumo_geral: "Sem reports de erro de lançamento no período. Comece reportando erros pelo botão no histórico SSW dos cards.",
        metricas_chave: [{ label: `Total no período (${periodoDias}d)`, valor: "0", delta_pct: null, tendencia: "estavel" }],
        melhoria_destaques: [],
        piora_destaques: [],
        sugestoes_melhoria: [],
        sugestoes_automacao: [],
        cobrancas_recomendadas: [],
        evidencia_incompleta_sub_tipos: [],
      };
      return json({ ok: true, resultado: vazio, gerado_em: new Date().toISOString(), cache: false });
    }

    // 3. Monta userPrompt + chama Sonnet
    const anthropic = createAnthropicClient({ env: readAnthropicEnvFromProcess(env) });
    const userPrompt = `**Indicador:** Erros de Lançamento da Base
**Período atual:** últimos ${periodoDias} dias
**Período anterior (pra comparar delta):** ${periodoDias} dias anteriores ao período atual
**Filtro bases:** ${bases.length > 0 ? bases.join(", ") : "todas"}

**Categorias de erro:**
- OC_DIFERENTE: base lançou oc X mas era Y (códigos diferentes)
- EVIDENCIA_INCOMPLETA: oc correta lançada, mas evidência (foto/observação) inadequada — \`motivos_textuais\` traz o texto livre dos operadores descrevendo o problema

## Dados período ATUAL (agregado por base/usuário/oc_errada/oc_correta/categoria)
${JSON.stringify(periodoAtual, null, 2)}

## Dados período ANTERIOR (mesma agregação, pra calcular delta)
${JSON.stringify(periodoAnterior, null, 2)}

## Tabela de referência de ocorrências SSW (resumo das mais comuns)
- oc=10 RECUSA TOTAL
- oc=11 PROBLEMAS COM ENDERECO
- oc=19 ENTREGA COM FALTA DE VOLUMES
- oc=21 REENTREGA SOLICITADA PELO CLIENTE
- oc=26 RECUSA NA RECEBENTE (a ser definido pelo Caio caso esteja errado)
- oc=33 REVERSAO DE PERDAS / INDENIZACAO
- oc=35 RECUSA PARCIAL
- oc=44 RETORNO DE CARGA (DEVOLUCAO)
- oc=49 TRATATIVA DE RELACIONAMENTO
- oc=54 AGUARDANDO POSICIONAMENTO DO CLIENTE PAGADOR
- oc=55 AUTORIZAR SEGUIR ENTREGA
- oc=56 FALTA INFO OPERACIONAL

Analise os dados e retorne o JSON estruturado conforme o schema do system prompt.`;

    const completion = await anthropic.complete({
      model: MODEL,
      maxTokens: 4096,
      temperature: 0.3,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    });

    let resultado: Record<string, unknown>;
    try {
      const limpo = completion.text.trim().replace(/^```json\s*/, "").replace(/```\s*$/, "");
      resultado = JSON.parse(limpo);
    } catch (e) {
      throw new Error(`Falha ao parsear JSON da IA: ${e instanceof Error ? e.message : String(e)}. Resposta: ${completion.text.slice(0, 500)}`);
    }

    // 4. Salva no cache
    const { data: cached } = await supabase
      .from("analises_ia_indicadores")
      .insert({
        indicador_tipo: INDICADOR_TIPO,
        filtros,
        resultado,
        modelo: MODEL,
      })
      .select("gerado_em")
      .single();

    return json({
      ok: true,
      resultado,
      gerado_em: cached?.gerado_em ?? new Date().toISOString(),
      cache: false,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

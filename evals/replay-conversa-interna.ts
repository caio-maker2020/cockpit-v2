// =============================================================================
// evals/replay-conversa-interna.ts — ENSAIO A/B do interpretador antes de
// publicar a cerca "conversa do lado do cliente" (Carlos 02/10, NF 1042798).
//
// Pergunta: com o bloco De/Para/Cc + a seção (e) do prompt + a cerca, o
// interpretador para de transformar conversa entre colegas do cliente em ação
// da Sal — SEM estragar as respostas em que ele já acertava (coorte controle,
// e os "Devolução autorizada. @Estoque recepcionar" da Autoglass/AGV)?
//
// Método: a MESMA entrada reconstruída vai pros DOIS prompts (o da ref antiga
// e o atual), mesmo modelo/temperatura/parse do interpretador. Diferença =
// efeito da mudança. Limitações declaradas: (1) o bloco "ESTADO DA TRATATIVA"
// (memória do card) fica de fora nos dois lados — não dá pra reconstruir o
// estado do passado; (2) anexos entram só como lista (sem abrir o arquivo);
// (3) a cadeia R2–R5 não roda (é igual nos dois lados); a cerca roda sobre a
// oc crua do modelo.
//
// Entrada: JSON gerado por SQL SÓ-LEITURA via scripts/dbq.py (dataset com
// e-mail de cliente — NUNCA commitar; repo é público). Saída: JSONL fora do
// repo, retomável (pula message ids já gravados).
//
// Uso:
//   git show master:supabase/functions/interpretador-resposta-cliente/index.ts > /tmp/antigo.ts
//   deno run --allow-read --allow-write --allow-net --allow-env --env-file=.env.local \
//     evals/replay-conversa-interna.ts --dataset X.json --antigo /tmp/antigo.ts \
//     --novo supabase/functions/interpretador-resposta-cliente/index.ts --saida Y.jsonl [--paralelo 4] //     [--reusar-antiga Z.jsonl]   # reaproveita a leitura do prompt ANTIGO de um ensaio anterior
//                                 # (mesmo prompt antigo + mesma entrada) — só o novo é chamado
//     [--confirmar-custo <USD>]   # obrigatório acima de 50 chamadas (INV-167); o custo sai no fim
//
// INV-167 (Caio 02/10): este ensaio rodou em 02/10 com a chave de PRODUÇÃO do
// .env.local (1.083 chamadas Sonnet, ~US$35 invisíveis ao anthropic_usage_log,
// 5 recargas no dia). Agora exige ANTHROPIC_API_KEY_EVALS (workspace Evals-Cockpit,
// teto próprio), conta tokens e barra lote caro sem confirmação — ver _custo-evals.ts.
// =============================================================================

import { createAnthropicClient } from "../supabase/functions/_shared/anthropic-client.ts";
import { ContadorCusto, lerChaveEvals, portaoDeCusto } from "./_custo-evals.ts";
import {
  montarBlocoParticipantes,
  soMencionaQuemNaoEDaSal,
} from "../supabase/functions/_shared/participantes-email.ts";
import {
  aplicarCercaConversaInterna,
  conversaInternaBloqueiaVeto,
  normalizarPedidoDirigidoA,
} from "../supabase/functions/_shared/conversa-interna-cliente.ts";

const MODEL = "claude-sonnet-4-6"; // = MODEL do interpretador-resposta-cliente

interface Caso {
  mid: string;
  coorte: string;
  card_id: string;
  nf: string | null;
  empresa_cliente: string | null;
  operadora: string | null;
  remetente: string | null;
  from: string | null;
  to: string | null;
  cc: string | null;
  conteudo: string;
  oc_antiga: number | null;
  conf_antiga: number | null;
  email_operadora: string | null;
  anexos: Array<{ filename: string; mime_type: string; size_bytes: number }>;
  oc_antes: string | null;
  instrucao_antes: string | null;
}

interface Leitura {
  oc_sugerida: number;
  confianca: number;
  motivo: string;
  pedido_dirigido_a?: string;
  pedido_dirigido_a_detalhe?: string;
}

function arg(nome: string, padrao?: string): string {
  const i = Deno.args.indexOf(`--${nome}`);
  if (i >= 0 && Deno.args[i + 1]) return Deno.args[i + 1]!;
  if (padrao !== undefined) return padrao;
  throw new Error(`falta --${nome}`);
}

/** Extrai o template literal SYSTEM_PROMPT do index.ts (o Loop de Aprendizado
 *  edita o prompt NO index.ts — por isso ele não mora num módulo). */
export function extrairSystemPrompt(fonte: string): string {
  const inicio = fonte.indexOf("const SYSTEM_PROMPT = `");
  if (inicio < 0) throw new Error("SYSTEM_PROMPT não encontrado");
  let i = inicio + "const SYSTEM_PROMPT = `".length;
  let out = "";
  for (; i < fonte.length; i++) {
    const ch = fonte[i]!;
    if (ch === "\\") {
      out += fonte[i + 1] ?? "";
      i++;
      continue;
    }
    if (ch === "`") return out;
    if (ch === "$" && fonte[i + 1] === "{") throw new Error("SYSTEM_PROMPT com interpolação — extrator não suporta");
    out += ch;
  }
  throw new Error("SYSTEM_PROMPT sem fim");
}

function montarUserPrompt(c: Caso, comParticipantes: boolean): string {
  const operadoraNome = c.operadora ?? "a operadora";
  const anexosDescritos = c.anexos.length === 0
    ? "(nenhum anexo)"
    : c.anexos.map((a) => `- ${a.filename} (${a.mime_type}, ${Math.round(a.size_bytes / 1024)}KB)`).join("\n");
  return [
    `OPERADORA: ${operadoraNome}`,
    `Cliente: ${c.empresa_cliente ?? "?"}`,
    `NF: ${c.nf ?? "?"}`,
    `Última oc registrada antes da resposta: ${c.oc_antes ?? "?"}`,
    `Contexto da NF: ${c.instrucao_antes ?? "(sem contexto)"}`,
    "",
    `EMAIL DA OPERADORA (${operadoraNome}, pré-resposta):`,
    "---",
    c.email_operadora ? c.email_operadora.slice(0, 2000) : "(email da operadora não disponível — sem contexto pré-resposta)",
    "---",
    "",
    ...(comParticipantes
      ? [montarBlocoParticipantes({ from: c.from, remetente: c.remetente, to: c.to, cc: c.cc }), ""]
      : []),
    "TEXTO DA RESPOSTA DO CLIENTE:",
    "---",
    c.conteudo.slice(0, 3000),
    "---",
    "",
    "ANEXOS ENVIADOS PELO CLIENTE:",
    anexosDescritos,
    "",
    "Decida oc + pendências + combo 33+44. Responda só JSON.",
  ].join("\n");
}

if (import.meta.main) {
  const dataset = JSON.parse(await Deno.readTextFile(arg("dataset"))) as Caso[];
  const promptAntigo = extrairSystemPrompt(await Deno.readTextFile(arg("antigo")));
  const promptNovo = extrairSystemPrompt(await Deno.readTextFile(arg("novo")));
  if (promptAntigo === promptNovo) throw new Error("prompts idênticos — ref antiga errada?");
  const saida = arg("saida");
  const paralelo = Number(arg("paralelo", "4"));

  const feitos = new Set<string>();
  try {
    for (const l of (await Deno.readTextFile(saida)).split("\n")) {
      if (l.trim()) feitos.add((JSON.parse(l) as { mid: string }).mid);
    }
  } catch { /* saída nova */ }

  const antigasPrevias = new Map<string, unknown>();
  const reusar = arg("reusar-antiga", "");
  if (reusar) {
    for (const l of (await Deno.readTextFile(reusar)).split("\n")) {
      if (!l.trim()) continue;
      const r = JSON.parse(l) as { mid: string; antiga?: unknown };
      if (r.antiga) antigasPrevias.set(r.mid, r.antiga);
    }
  }

  // INV-167: chave PRÓPRIA de eval (recusa a de produção) + cada chamada contada.
  let chaveEvals: string;
  try {
    chaveEvals = lerChaveEvals(Deno.env);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    Deno.exit(1);
  }
  const custo = new ContadorCusto(MODEL);
  const anthropic = createAnthropicClient({
    env: { apiKey: chaveEvals },
    onUsage: (r) =>
      custo.registrar({
        input_tokens: r.inputTokens,
        output_tokens: r.outputTokens,
        cache_creation_input_tokens: r.cacheCreationTokens ?? 0,
        cache_read_input_tokens: r.cacheReadTokens ?? 0,
      }),
  });
  const ler = (system: string, user: string) =>
    anthropic.completeJson<Leitura>({
      model: MODEL,
      system,
      messages: [{ role: "user", content: user }],
      maxTokens: 1800,
      temperature: 0.2,
    });

  const fila = dataset.filter((c) => !feitos.has(c.mid));
  console.log(`dataset=${dataset.length} já feitos=${feitos.size} a fazer=${fila.length}`);
  // INV-167: 2 chamadas por caso (antigo + novo), 1 quando o antigo é reaproveitado.
  // Acima de 50 chamadas só roda com --confirmar-custo <USD> ≥ estimativa.
  {
    const chamadasPrevistas = fila.length * (reusar ? 1 : 2);
    const barrado = portaoDeCusto(MODEL, chamadasPrevistas, arg("confirmar-custo", "") || undefined);
    if (barrado) {
      console.error(barrado);
      Deno.exit(2);
    }
  }
  let n = 0;
  const trabalhador = async () => {
    while (fila.length > 0) {
      const c = fila.shift()!;
      const reg: Record<string, unknown> = {
        mid: c.mid, coorte: c.coorte, nf: c.nf, card_id: c.card_id, oc_producao: c.oc_antiga,
      };
      try {
        const previa = antigasPrevias.get(c.mid) as { oc: number; conf: number; motivo: string } | undefined;
        const [antiga, nova] = await Promise.all([
          previa
            ? Promise.resolve({ oc_sugerida: previa.oc, confianca: previa.conf, motivo: previa.motivo } as Leitura)
            : ler(promptAntigo, montarUserPrompt(c, false)),
          ler(promptNovo, montarUserPrompt(c, true)),
        ]);
        if (previa) reg["antiga_reaproveitada"] = true;
        const pedido = normalizarPedidoDirigidoA(nova.pedido_dirigido_a);
        const mencoes = soMencionaQuemNaoEDaSal({ conteudo: c.conteudo, operadoraNome: c.operadora });
        const cerca = aplicarCercaConversaInterna({
          ocSugerida: nova.oc_sugerida,
          pedidoDirigidoA: pedido,
          detalhe: nova.pedido_dirigido_a_detalhe ?? null,
          ocDoCard: c.oc_antes != null ? Number(c.oc_antes) : null,
          mencoesSoForaDaSal: mencoes,
        });
        // a 56 final sairia sozinha? (só as cercas desta mudança; as demais do veto ficam de fora)
        reg["mencoes_so_fora_da_sal"] = mencoes;
        reg["veto_56_bloqueado"] = cerca.oc === 56 ? conversaInternaBloqueiaVeto(cerca.marca, "lancar_ocorrencia:56") : null;
        Object.assign(reg, {
          antiga: { oc: antiga.oc_sugerida, conf: antiga.confianca, motivo: antiga.motivo },
          nova: {
            oc: nova.oc_sugerida,
            conf: nova.confianca,
            motivo: nova.motivo,
            pedido_dirigido_a: nova.pedido_dirigido_a ?? null,
            detalhe: nova.pedido_dirigido_a_detalhe ?? null,
          },
          final_nova: cerca.oc,
          cerca: cerca.marca,
        });
      } catch (e) {
        reg["erro"] = e instanceof Error ? e.message : String(e);
      }
      await Deno.writeTextFile(saida, JSON.stringify(reg) + "\n", { append: true });
      n++;
      if (n % 10 === 0) console.log(`${n} feitos`);
    }
  };
  await Promise.all(Array.from({ length: paralelo }, trabalhador));
  console.log(custo.relatorio()); // INV-167
  console.log("fim");
}

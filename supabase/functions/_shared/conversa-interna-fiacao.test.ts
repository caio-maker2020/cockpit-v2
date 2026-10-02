// INV-166 (Carlos 02/10, NF 1042798 PRATI): a cerca "conversa do lado do
// cliente" só protege se estiver LIGADA nos 3 lugares — prompt (bloco De/Para/
// Cc + seção (e) + campo), cadeia pós-LLM do interpretador (depois de R2–R5) e
// cerca do veto (lida no agendador, que serve os DOIS call sites). Guard por
// grep: se alguém desligar um elo, a 56 da conversa entre colegas volta a sair sozinha.
// Rodar: deno test --allow-read supabase/functions/_shared/conversa-interna-fiacao.test.ts
import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

const INTERPRETADOR = new URL("../interpretador-resposta-cliente/index.ts", import.meta.url);
const AGENDADOR = new URL("./veto-agendamento.ts", import.meta.url);
const ELEGIBILIDADE = new URL("./veto-elegibilidade.ts", import.meta.url);

Deno.test("INV-166: o prompt do interpretador recebe De/Para/Cc e pergunta a quem é o pedido", async () => {
  const src = await Deno.readTextFile(INTERPRETADOR);
  assert(/montarBlocoParticipantes\(\{/.test(src), "userPrompt sem o bloco De/Para/Cc (montarBlocoParticipantes)");
  assert(src.includes('"pedido_dirigido_a": "sal_express" | "outra_pessoa"'), "schema do prompt sem pedido_dirigido_a");
  assert(src.includes("(e) **A QUEM É O PEDIDO"), "seção (e) do prompt sumiu");
  assert(src.includes("→ outra_pessoa, NUNCA 56."), "seção (e) perdeu o caso-âncora (NF 1042798)");
  assert(src.includes("a regra da 56 é EXATAMENTE a de sempre"), "seção (e) perdeu a ressalva que protege a 56 dirigida à Sal");
});

Deno.test("INV-166: a cerca roda DEPOIS de R2–R5 e a marca é persistida", async () => {
  const src = await Deno.readTextFile(INTERPRETADOR);
  const r5 = src.indexOf("corrigido55Para21 = true;");
  const cerca = src.indexOf("aplicarCercaConversaInterna({");
  assert(r5 > 0 && cerca > r5, "aplicarCercaConversaInterna tem de vir depois da R5 (último elo da cadeia)");
  assert(/ocSugeridaTrilho = cercaConversa\.oc;/.test(src), "resultado da cerca não volta pro ocSugeridaTrilho");
  assert(/mencoesSoForaDaSal: soMencionaQuemNaoEDaSal\(\{ conteudo, operadoraNome \}\)/.test(src),
    "sinal determinístico das menções desligado — a 56 volta a depender só da leitura do modelo");
  assert(/conversa_interna_cliente: conversaInterna,/.test(src), "marca não vai pra ia_sugestao_oc_resposta");
  assert(/texto_56_sugerido: rebaixou56PorConversa \? "" :/.test(src), "texto da 56 rebaixada ainda vai pro SSW");
  assert(/if \(!rebaixou56PorConversa\) \{\s*try \{\s*await devolverAoTerminalSeSemAcao/.test(src),
    "56 rebaixada não pode devolver o card sozinho ao terminal");
});

Deno.test("INV-166: a cerca do veto lê a marca para TODO call site do interpretador", async () => {
  const ag = await Deno.readTextFile(AGENDADOR);
  assert(/ia_sugestao_oc_resposta"\)/.test(ag) || /evidencia_status, ia_sugestao_oc_resposta/.test(ag),
    "agendador não carrega ia_sugestao_oc_resposta");
  assert(/i\.agentName === "interpretador-resposta-cliente" &&\s*conversaInternaBloqueiaVeto\(/.test(ag),
    "agendador não aplica conversaInternaBloqueiaVeto às ações do interpretador");
  assert(/conversaInternaClienteBloqueia,\s*\}\);/.test(ag), "decidirElegibilidadeVeto não recebe a cerca");
  const el = await Deno.readTextFile(ELEGIBILIDADE);
  assert(el.includes('if (c.conversaInternaClienteBloqueia === true) return nao("conversa_interna_cliente");'),
    "cerca conversa_interna_cliente sumiu de decidirElegibilidadeVeto");
});

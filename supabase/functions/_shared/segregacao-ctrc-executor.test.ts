// =============================================================================
// GUARD do GATE da segregação no EXECUTOR (Caio 2026-09-21, PRATI).
//
// A cerca pura (`segregacao-ctrc.ts`) já tem 26 testes e o submit tem 5. Só que
// a decisão que roda em PRODUÇÃO é o gate do `executor/index.ts`: é lá que a
// cerca é chamada, que a origem humana é provada e que o `segregarCtrc` é
// entregue ao `lancarSswPortal`. Esse pedaço não tinha guard nenhum.
//
// Classe de bug que este arquivo trava: um refactor no executor que
//   - reimplementa a decisão inline (e a cerca testada vira enfeite);
//   - volta a ignorar o `error` do SELECT em `todos` (fail-OPEN: "não li o
//     todo" ⇒ "foi humano");
//   - deriva `origemHumana` de uma comparação solta com `auto_approval_rule`;
//   - some com `codigosOcorrenciaCard` (o escopo "só card de extravio" cai e a
//     PRATI passa a segregar carga de RECUSA);
//   - esquece de repassar `segregarCtrc` pro envelope (a operadora marca, o
//     f8 vai "N" e ninguém percebe — falha silenciosa com cara de sucesso);
//   - grava `CtrcSegregado` em skip idempotente (afirma bloqueio que não houve).
// Nenhuma dessas regressões deixa um teste vermelho hoje: por isso o guard é
// sobre o CÓDIGO-FONTE do executor.
//
// Segregar é IRREVERSÍVEL pelo Cockpit (retirada manual, opção 091) — errar
// aqui barra carga de cliente real e o sistema não desfaz.
//
// Rodar com: deno test --allow-read --no-check
//   supabase/functions/_shared/segregacao-ctrc-executor.test.ts
// =============================================================================
import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const CAMINHO_EXECUTOR = "supabase/functions/executor/index.ts";
const SRC_BRUTO = Deno.readTextFileSync(new URL("../executor/index.ts", import.meta.url));

/**
 * Corta comentários de linha e de bloco, pra o guard não passar por causa da
 * PROSA. O executor explica a cerca em comentário logo acima do código — sem
 * essa limpeza, apagar o código e deixar o comentário manteria tudo verde.
 */
function semComentarios(src: string): string {
  return src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

const SRC = semComentarios(SRC_BRUTO);

/**
 * Devolve o trecho `marcador` + corpo balanceado por chaves. Usado pra afirmar
 * coisas DENTRO de uma chamada específica (ex.: o objeto entregue a
 * `lancarSswPortal`) em vez de "aparece em algum lugar do arquivo".
 */
function blocoDaChamada(src: string, marcador: string): string {
  const inicio = src.indexOf(marcador);
  assert(inicio >= 0, `não achei \`${marcador}\` em ${CAMINHO_EXECUTOR}`);
  const abre = src.indexOf("{", inicio);
  assert(abre >= 0, `\`${marcador}\` sem \`{\` em ${CAMINHO_EXECUTOR}`);
  let nivel = 0;
  for (let i = abre; i < src.length; i++) {
    const c = src[i];
    if (c === "{") nivel++;
    else if (c === "}") {
      nivel--;
      if (nivel === 0) return src.slice(inicio, i + 1);
    }
  }
  throw new Error(`chaves não fecharam a partir de \`${marcador}\` em ${CAMINHO_EXECUTOR}`);
}

/**
 * Condição do `if (...)` que abre o bloco onde `alvo` está — o `if` mais
 * próximo ANTES do alvo.
 */
function condicaoDoIfAntesDe(src: string, alvo: string): string {
  const fim = src.indexOf(alvo);
  assert(fim >= 0, `não achei \`${alvo}\` em ${CAMINHO_EXECUTOR}`);
  const antes = src.slice(0, fim);
  const ifs = [...antes.matchAll(/if\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)\s*\{/g)];
  const ultimo = ifs[ifs.length - 1];
  assert(
    ultimo !== undefined,
    `\`${alvo}\` não está sob nenhum \`if\` em ${CAMINHO_EXECUTOR} — a guarda sumiu`,
  );
  return (ultimo[1] ?? "").trim();
}

/**
 * Resolve UM nível de indireção: se a condição é só um identificador, devolve a
 * expressão do `const <id> = ...;`. Assim o guard aceita o refactor legítimo
 * ("dá nome à condição") e continua reprovando o que importa — a condição em si
 * ter perdido uma das partes.
 */
function resolverExpressao(src: string, cond: string): string {
  if (!/^[A-Za-z_$][\w$]*$/.test(cond)) return cond;
  const m = new RegExp(`\\bconst\\s+${cond}\\s*=\\s*([^;]+);`).exec(src);
  assert(
    m !== null,
    `a guarda virou o identificador \`${cond}\`, mas não existe \`const ${cond} = ...\` em ` +
      `${CAMINHO_EXECUTOR} — não dá pra provar o que essa condição contém`,
  );
  return (m![1] ?? "").trim();
}

// --- 1. a decisão mora na cerca, não dentro do executor ----------------------

Deno.test("INV-segregação-1: executor IMPORTA a cerca de ../_shared/segregacao-ctrc.ts", () => {
  assertStringIncludes(
    SRC,
    '"../_shared/segregacao-ctrc.ts"',
    "o executor precisa importar a cerca de ../_shared/segregacao-ctrc.ts. Se este import " +
      "sumir, a decisão de segregar passou a ser reimplementada DENTRO do executor — os 26 " +
      "testes da cerca continuam verdes testando código que produção não usa mais.",
  );
});

Deno.test("INV-segregação-2: executor importa E chama as quatro funções da cerca", () => {
  const importado = blocoDaChamada(SRC, "import {");
  // O primeiro `import {` do arquivo tem de ser o da cerca? Não: procuramos o
  // bloco de import que cita a cerca, por isso a checagem é por função.
  for (const fn of [
    "carregarCnpjsSegregacao",
    "lerMarcacaoSegregar",
    "origemHumanaComprovada",
    "segregacaoPermitida",
  ]) {
    assertMatch(
      SRC,
      new RegExp(`\\n\\s*${fn},`),
      `\`${fn}\` precisa estar na lista de imports do executor — sem ela a peça equivalente ` +
        `foi reescrita à mão e deixou de ser coberta pelos testes da cerca.`,
    );
    assertMatch(
      SRC,
      new RegExp(`\\b${fn}\\(`),
      `\`${fn}\` está importada mas NÃO é chamada no executor — import morto significa que a ` +
        `decisão real virou outra coisa.`,
    );
  }
  assert(
    importado.length > 0,
    "bloco de import do executor ilegível — refactor quebrou a forma esperada",
  );
});

// --- 2. origem humana: só a função fail-closed pode produzi-la ---------------

Deno.test("INV-segregação-3: origemHumana vem de origemHumanaComprovada(), nunca de comparação solta", () => {
  assertMatch(
    SRC,
    /const\s+origemHumana\s*=\s*origemHumanaComprovada\(\s*\{/,
    "`origemHumana` tem de ser produzida por `origemHumanaComprovada({ leuTodo, regraAuto })`. " +
      "Voltar a escrever `const origemHumana = regraAuto == null` reabre o fail-OPEN: erro de " +
      "query/RLS ou todo inexistente vira 'foi humano' e o robô segrega sem ninguém ter olhado.",
  );
  // Nenhuma OUTRA origem para o mesmo nome: cada `origemHumana =` / `origemHumana:`
  // do arquivo tem de ser a chamada da cerca ou o shorthand da passagem adiante.
  const atribuicoes = [...SRC.matchAll(/origemHumana\s*(=|:)\s*([^\n]*)/g)];
  assert(
    atribuicoes.length > 0,
    "sumiu qualquer menção a `origemHumana` no executor — a cerca perdeu a prova de ação humana",
  );
  for (const m of atribuicoes) {
    const valor = (m[2] ?? "").trim();
    assert(
      valor.startsWith("origemHumanaComprovada("),
      "`origemHumana` recebeu valor que NÃO é `origemHumanaComprovada(...)`: `" + valor + "`. " +
        "Qualquer derivação direta de `auto_approval_rule` (== null, !regra, ?? null) colapsa " +
        "'não consegui ler o todo' com 'humano aprovou'.",
    );
  }
  assertMatch(
    SRC,
    /origemHumanaComprovada\(\s*\{\s*leuTodo\s*,\s*regraAuto\s*\}\s*\)/,
    "`origemHumanaComprovada` precisa receber AS DUAS provas ({ leuTodo, regraAuto }). Só a " +
      "regra, sem `leuTodo`, é exatamente o fail-OPEN que a auditoria de 21/09 pegou.",
  );
});

// --- 3. o SELECT em `todos` não pode voltar a ignorar o erro ----------------

Deno.test("INV-segregação-4: o SELECT em `todos` captura o error (error: todoErr) e alimenta leuTodo", () => {
  assertStringIncludes(
    SRC,
    "error: todoErr",
    "o SELECT de `todos.auto_approval_rule` tem de capturar o erro (`error: todoErr`). " +
      "Voltar a `const { data: todoRow } = await supabase...` faz erro de RLS/timeout virar " +
      "`todoRow = null` ⇒ `regraAuto = null` ⇒ 'foi humano' — fail-OPEN numa cerca irreversível.",
  );
  assertMatch(
    SRC,
    /const\s+leuTodo\s*=\s*!todoErr\s*&&\s*todoRow\s*!=\s*null\s*;/,
    "`leuTodo` tem de exigir AS DUAS condições: sem erro E com linha (`!todoErr && todoRow != null`). " +
      "Só uma delas deixa passar o estado (c) do diagnóstico: todo inexistente.",
  );
  assertStringIncludes(
    SRC,
    'select("auto_approval_rule")',
    "o executor precisa continuar lendo `todos.auto_approval_rule` — é a única prova de que a " +
      "aprovação não veio de regra automática.",
  );
});

// --- 4. escopo "só card de extravio" não pode sumir da chamada --------------

Deno.test("INV-segregação-5: codigosOcorrenciaCard é passado para segregacaoPermitida, com as DUAS fontes", () => {
  const chamada = blocoDaChamada(SRC, "segregacaoPermitida({");
  assertStringIncludes(
    chamada,
    "codigosOcorrenciaCard",
    "a chamada de `segregacaoPermitida` tem de passar `codigosOcorrenciaCard`. Sem ele o escopo " +
      "'somente cards de extravio' (Caio 21/09) desaparece e um card da PRATI em RECUSA com " +
      "proposta de 54 passa a barrar a carga — efeito que o Cockpit não desfaz.",
  );
  assertMatch(
    chamada,
    /codigosOcorrenciaCard\s*:\s*\[/,
    "`codigosOcorrenciaCard` tem de ser o ARRAY com as duas fontes; um valor escalar volta a " +
      "olhar uma fonte só.",
  );
  assertMatch(
    chamada,
    /agentState\[\s*"cod_ultima_ocorrencia"\s*\]/,
    "falta a fonte canônica `agentState.cod_ultima_ocorrencia`. O executor SOBRESCREVE " +
      "`cards.cod_ultima_ocorrencia` a cada lançamento (NF 29920): olhar só o campo do card " +
      "bloqueia o fluxo real de extravio em silêncio.",
  );
  assertMatch(
    chamada,
    /card[^\n]*\[\s*"cod_ultima_ocorrencia"\s*\]/,
    "falta a fonte `card.cod_ultima_ocorrencia` — a outra metade do par que a cerca espera.",
  );
  assertStringIncludes(
    chamada,
    "cnpjPagador",
    "a chamada perdeu `cnpjPagador`: sem CNPJ a whitelist da PRATI não é aplicada.",
  );
  assertStringIncludes(
    chamada,
    "cnpjsAutorizados",
    "a chamada perdeu `cnpjsAutorizados` (whitelist + kill-switch da mig 407).",
  );
  assertMatch(
    chamada,
    /origemHumana\s*[,:}]/,
    "a chamada perdeu `origemHumana` — a cerca passaria a autorizar segregação de robô.",
  );
  assertMatch(
    chamada,
    /codigoSsw\s*[,:}]/,
    "a chamada perdeu `codigoSsw` — sem ele a cerca não consegue limitar às ocs 54/59.",
  );
});

// --- 5. a marcação tem de chegar no envelope do portal ----------------------

Deno.test("INV-segregação-6: segregarCtrc é repassado no objeto entregue a lancarSswPortal", () => {
  const chamada = blocoDaChamada(SRC, "lancarSswPortal({");
  assertMatch(
    chamada,
    /\bsegregarCtrc\s*[,:}]/,
    "o objeto passado a `lancarSswPortal` tem de levar `segregarCtrc`. Apagar essa linha é a " +
      "falha silenciosa mais cara da feature: a operadora marca na tela, a cerca aprova, o card " +
      "registra a intenção e o portal recebe f8='N' — ocorrência lançada, carga NÃO bloqueada, " +
      "e nada fica vermelho.",
  );
  assertMatch(
    SRC,
    /let\s+segregarCtrc\s*=\s*false\s*;/,
    "`segregarCtrc` tem de nascer `false` (default do portal é 'N'): qualquer outro valor " +
      "inicial faz a cerca virar opt-out em vez de opt-in.",
  );
  const porta = resolverExpressao(SRC, condicaoDoIfAntesDe(SRC, "segregacaoPermitida({"));
  assertMatch(
    porta,
    /lerMarcacaoSegregar\(\s*extras\s*\)/,
    "a cerca só pode ser avaliada quando a operadora MARCOU: o `if` que abre o bloco do " +
      "`segregacaoPermitida` tem de depender de `lerMarcacaoSegregar(extras)` (direto ou por " +
      "uma constante com esse valor). Condição encontrada: `" + porta + "`. Sem essa porta, " +
      "todo lançamento de 54/59 de cliente whitelistado passaria a segregar sozinho.",
  );
});

// --- 6. o evento CtrcSegregado só existe com submit de verdade --------------

Deno.test("INV-segregação-7: card_event CtrcSegregado exige portalResult.ok E !portalResult.idempotent_skip", () => {
  const ocorrencias = [...SRC.matchAll(/"CtrcSegregado"/g)];
  assertEquals(
    ocorrencias.length,
    1,
    "`CtrcSegregado` tem de ser gravado em UM lugar só do executor. Um segundo INSERT " +
      "(provavelmente sem as guardas) registra bloqueio que pode não ter acontecido.",
  );
  // A guarda pode estar inline no `if` ou com nome (`const segregarCtrcEfetivado = ...`).
  // O que NÃO pode é perder qualquer uma das TRÊS partes.
  const guarda = resolverExpressao(SRC, condicaoDoIfAntesDe(SRC, '"CtrcSegregado"'));
  const prefixo = "a condição do INSERT de `CtrcSegregado` é `" + guarda + "` e ";
  assertMatch(
    guarda,
    /\bsegregarCtrc\b/,
    prefixo + "não depende mais de `segregarCtrc` — passaria a registrar segregação em " +
      "lançamento que ninguém mandou segregar.",
  );
  assertMatch(
    guarda,
    /portalResult\.ok/,
    prefixo + "não exige `portalResult.ok` — o evento afirmaria bloqueio de carga num " +
      "lançamento que FALHOU.",
  );
  assertMatch(
    guarda,
    /!\s*portalResult\.idempotent_skip/,
    prefixo + "não exige `!portalResult.idempotent_skip` — em redelivery do PGMQ o envelope " +
      "bate no UNIQUE e NÃO chama o portal, logo nenhum f8=\"S\" saiu agora. Registrar mesmo " +
      "assim é o histórico mentindo sobre um efeito irreversível pelo Cockpit.",
  );
});

// --- 7. a recusa continua auditável ----------------------------------------

Deno.test("INV-segregação-8: recusa da cerca grava SegregacaoCtrcRecusadaPelaCerca", () => {
  assertStringIncludes(
    SRC,
    '"SegregacaoCtrcRecusadaPelaCerca"',
    "quando a operadora pede e a cerca recusa, tem de sobrar rastro (`card_event " +
      "SegregacaoCtrcRecusadaPelaCerca`). Sem ele a feature falha calada: 'marquei e não " +
      "segregou, ninguém sabe por quê'.",
  );
  assertMatch(
    SRC,
    /if\s*\(\s*!segregarCtrc\s*\)/,
    "a recusa tem de ser gravada exatamente quando `segregarCtrc` ficou false após a cerca.",
  );
  assertMatch(
    SRC,
    /segregar_ctrc\w*\s*:/,
    "o rastro de auditoria (audit_log / card_event da ação) tem de registrar a segregação. " +
      "Ação irreversível pelo Cockpit sem nada no histórico é bloqueio de carga sem dono.",
  );
});

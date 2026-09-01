// =============================================================================
// GUARD DA CLASSE R1 — "tool novo que o front não conhece"
//
// Esta classe de bug já apareceu 5 VEZES no projeto, sempre igual: alguém cria
// um tool novo no backend, esquece de registrar no front, e o clique em
// "aprovar ação →" cai no default `aprovar-direto` — que aprova com
// `extras = null`, SEM abrir o painel de conferência. Histórico catalogado em
// `decidir-clique-aprovacao.ts`:
//   22/07 e-mail às cegas (NF 556392 / 51712) · 22/07 romaneio interno
//   (NF 1025518) · 23/07 input obrigatório 41/56/55/44 (NF 62566) ·
//   24/07 anexos da oc 33 (NF 158084).
//
// Guard em vez de disciplina: a lista de tools é DERIVADA do backend (onde as
// propostas nascem), não mantida à mão — lista nova seria mais um lugar pra
// esquecer. Exceção só existe DECLARADA aqui embaixo, com o motivo.
//
// Rodar com: deno test --allow-read
// =============================================================================
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const RAIZ = new URL("../../../", import.meta.url);

/**
 * Tools que NÃO passam pela lista de propostas do card, com o motivo.
 * Acrescentar aqui é decisão consciente; o guard existe pra que seja consciente.
 */
const FORA_DA_LISTA_DE_PROPOSTAS: Record<string, string> = {
  // Ação AGENDADA pelo veto autônomo: renderiza no BannerAcaoAutonoma, não na
  // lista de propostas. Ver acao-autonoma-veto.ts / acaoAutonomaVeto.ts.
  ignorar_e_aguardar: "ação autônoma agendada — vive no BannerAcaoAutonoma",
  // Disparo do worker de ações agendadas; nunca é um todo aprovável.
  enviar_email_template: "execução agendada pelo worker, não é proposta clicável",
  // Resposta ao cliente: superfície da aba de conversa, não da lista de ocorrências.
  responder_cliente: "vive na aba de e-mail/conversa, não na lista de propostas",
};

async function arquivosTs(dir: URL): Promise<URL[]> {
  const saida: URL[] = [];
  for await (const e of Deno.readDir(dir)) {
    const filho = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
    if (e.isDirectory) {
      saida.push(...await arquivosTs(filho));
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
      saida.push(filho);
    }
  }
  return saida;
}

/**
 * Nomes de tool que o BACKEND é capaz de PROPOR.
 *
 * Casa `tool: "literal"` E `tool: IDENTIFICADOR`, resolvendo o identificador
 * contra as constantes string do backend. Sem a segunda forma o guard daria
 * FALSA CONFIANÇA: a convenção do repo é nomear a tool numa constante
 * (ex.: `TOOL_44_DEVOLUCAO_CTE`), e um guard que só olha literal deixaria
 * passar exatamente o caso novo que ele existe pra pegar.
 */
async function toolsPropostasNoBackend(): Promise<Map<string, string[]>> {
  const arquivos = await arquivosTs(new URL("supabase/functions/", RAIZ));
  const fontes = new Map<string, string>();
  for (const f of arquivos) {
    fontes.set(f.pathname.split("/functions/")[1] ?? f.pathname, await Deno.readTextFile(f));
  }

  // 1. tabela de constantes string do backend inteiro
  const constantes = new Map<string, string>();
  const reConst = /\bconst\s+([A-Z][A-Z0-9_]*)\s*(?::\s*string\s*)?=\s*"([a-z0-9_]+)"/g;
  for (const src of fontes.values()) {
    for (const m of src.matchAll(reConst)) constantes.set(m[1]!, m[2]!);
  }

  // 2. usos de `tool:` — literal ou identificador
  const achados = new Map<string, string[]>();
  const reUso = /\btool:\s*(?:"([a-z0-9_]+)"|([A-Za-z_][A-Za-z0-9_]*))/g;
  for (const [curto, src] of fontes) {
    for (const m of src.matchAll(reUso)) {
      const nome = m[1] ?? (m[2] ? constantes.get(m[2]) : undefined);
      if (!nome) continue; // identificador que não resolve pra string: ignora
      const onde = achados.get(nome) ?? [];
      if (!onde.includes(curto)) onde.push(curto);
      achados.set(nome, onde);
    }
  }
  return achados;
}

Deno.test("R1: todo tool proposto pelo backend aparece em propostasRaw (ou é exceção declarada)", async () => {
  const tools = await toolsPropostasNoBackend();
  const front = await Deno.readTextFile(
    new URL("apps/cockpit-web/src/components/cards/ProposedActions.tsx", RAIZ),
  );
  const ausentes: string[] = [];
  for (const [tool, onde] of tools) {
    if (tool in FORA_DA_LISTA_DE_PROPOSTAS) continue;
    if (!front.includes(`"${tool}"`)) ausentes.push(`${tool} (proposto em ${onde.join(", ")})`);
  }
  assertEquals(
    ausentes,
    [],
    "tool proposto que o front NÃO renderiza na lista — a proposta some da tela do operador:\n" +
      ausentes.join("\n"),
  );
});

Deno.test("R1: todo tool proposto tem destino EXPLÍCITO no clique (nunca cai em aprovar-direto)", async () => {
  const tools = await toolsPropostasNoBackend();
  const decidir = await Deno.readTextFile(
    new URL("apps/cockpit-web/src/lib/decidir-clique-aprovacao.ts", RAIZ),
  );
  const cegos: string[] = [];
  for (const [tool, onde] of tools) {
    if (tool in FORA_DA_LISTA_DE_PROPOSTAS) continue;
    // `lancar_ocorrencia` é o caminho genérico: tem tratamento por código
    // (OCS_COM_INPUT_OBRIGATORIO) e o default aprovar-direto é legítimo pras
    // ocs que não pedem input. Os OUTROS tools precisam de caso próprio.
    if (tool === "lancar_ocorrencia") continue;
    if (!decidir.includes(`"${tool}"`)) cegos.push(`${tool} (proposto em ${onde.join(", ")})`);
  }
  assertEquals(
    cegos,
    [],
    "tool sem caso em decidirCliqueAprovacao ⇒ cai em 'aprovar-direto' e aprova com extras=null, " +
      "SEM abrir o painel. É a 6ª recorrência da classe:\n" + cegos.join("\n"),
  );
});

Deno.test("a lista de exceções não pode conter tool que nem existe mais (higiene)", async () => {
  const tools = await toolsPropostasNoBackend();
  const mortas = Object.keys(FORA_DA_LISTA_DE_PROPOSTAS).filter((t) => !tools.has(t));
  assertEquals(mortas, [], `exceção declarada pra tool que o backend não propõe mais: ${mortas}`);
});

// -----------------------------------------------------------------------------
// Cerca específica da devolução com CT-e (decisão nº 6: agente sugere, MARIA
// aprova). Este tool NUNCA pode virar ação autônoma.
// -----------------------------------------------------------------------------
Deno.test("devolução com CT-e NUNCA é ação autônoma (decisão nº 6 — Maria aprova)", async () => {
  const veto = await Deno.readTextFile(new URL("supabase/functions/_shared/acao-autonoma-veto.ts", RAIZ));
  const i = veto.indexOf("ACOES_ELEGIVEIS");
  const bloco = i >= 0 ? veto.slice(i, veto.indexOf("]", i)) : veto;
  assertEquals(
    bloco.includes("devolucao_cte"),
    false,
    "ação autônoma lançaria oc 44 com documento fiscal sem a Maria ver — decisão nº 6 proíbe",
  );
});

// -----------------------------------------------------------------------------
// Registro EXPLÍCITO da tool da devolução com CT-e.
//
// Vale enquanto a proposta ainda não é criada (degrau 3): o guard derivado acima
// só vê a tool depois que alguém escreve `tool: TOOL_44_DEVOLUCAO_CTE` numa
// inserção de todo. Este teste cobra o registro DESDE JÁ, que é o que a lição
// da classe R1 manda — registrar nas superfícies NO MESMO COMMIT da tool.
// -----------------------------------------------------------------------------
Deno.test("R1: a tool da devolução com CT-e está registrada nas 2 superfícies do front", async () => {
  const { TOOL_44_DEVOLUCAO_CTE } = await import("./devolucao-cte-44.ts");
  const alvos: [string, string][] = [
    ["apps/cockpit-web/src/components/cards/ProposedActions.tsx", "propostasRaw (renderizar na lista)"],
    ["apps/cockpit-web/src/lib/decidir-clique-aprovacao.ts", "destino do clique (nunca aprovar-direto)"],
  ];
  for (const [caminho, papel] of alvos) {
    const src = await Deno.readTextFile(new URL(caminho, RAIZ));
    assertEquals(
      src.includes(`"${TOOL_44_DEVOLUCAO_CTE}"`),
      true,
      `${TOOL_44_DEVOLUCAO_CTE} ausente em ${caminho} — ${papel}`,
    );
  }
});

Deno.test("R1: o clique na 44 com CT-e abre painel de input (volumes/motivo/filial)", async () => {
  const { TOOL_44_DEVOLUCAO_CTE } = await import("./devolucao-cte-44.ts");
  const src = await Deno.readTextFile(
    new URL("apps/cockpit-web/src/lib/decidir-clique-aprovacao.ts", RAIZ),
  );
  // O caso da tool tem de aparecer ANTES do `return "aprovar-direto"` final.
  const iTool = src.indexOf(`"${TOOL_44_DEVOLUCAO_CTE}"`);
  const iDireto = src.lastIndexOf('return "aprovar-direto"');
  assertEquals(iTool > -1 && iTool < iDireto, true, "o caso da tool tem de vir antes do default");
  // E o destino tem de ser abrir-input: a 44 exige volumes+motivo (NF 59299) e
  // aprovar com extras=null lançaria a oc sem o que o setor precisa.
  const trecho = src.slice(iTool, iTool + 320);
  assertEquals(
    trecho.includes("abrir-input"),
    true,
    "destino da 44 com CT-e tem de ser abrir-input, não aprovação cega",
  );
});

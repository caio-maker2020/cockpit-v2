// Guard — a área de Operação não encosta no que o Relacionamento já roda e nasce inerte
// (ADR 0041; INV-180, INV-187). Estático: lê arquivos, sem banco.
// Rodar: deno test --no-check --allow-read supabase/functions/_shared/operacao-isolamento.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const RAIZ = new URL("../../../", import.meta.url);
const ler = (p: string) => Deno.readTextFile(new URL(p, RAIZ));
const M430 = "migration/2026-10-07_430_operacao_fila_e_lancamentos.sql";
const M431 = "migration/2026-10-07_431_operacao_separacao_rls.sql";
const M432 = "migration/2026-10-07_432_cron_materializar_fila_operacao.sql";
const M433 = "migration/2026-10-07_433_cron_processar_lancamentos_operacao.sql";

/** SQL sem comentários de linha (o cabeçalho explica coisas que o código não pode fazer). */
const semComentario = (s: string) => s.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");

async function* arquivosTs(dir: URL, rel = ""): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const r = `${rel}${e.name}`;
    if (e.isDirectory) yield* arquivosTs(new URL(`${e.name}/`, dir), `${r}/`);
    else if (e.isFile && e.name.endsWith(".ts")) yield r;
  }
}

/** Arquivos da Operação (os únicos que podem importar o código da Operação). */
function ehDaOperacao(caminho: string): boolean {
  return /(^|\/)_shared\/(operacao-|lancar-ssw-portal-operacao|bastao-operacao-client)/.test(caminho) ||
    caminho.startsWith("materializar-fila-operacao/") || caminho.startsWith("processar-lancamentos-operacao/") ||
    caminho.startsWith("sugerir-operacao/") || // ADR 0041 D10/D11
    caminho.startsWith("comprovantes-operacao/"); // ADR 0042 D6
}

Deno.test("ISOLAMENTO: nenhuma função do Relacionamento importa a Operação (só o health-check, e só o vigia puro)", async () => {
  const base = new URL("supabase/functions/", RAIZ);
  const violacoes: string[] = [];
  let vistos = 0;
  for await (const rel of arquivosTs(base)) {
    if (ehDaOperacao(rel)) continue;
    vistos++;
    const src = await Deno.readTextFile(new URL(rel, base));
    const imports = [...src.matchAll(/from\s+["']([^"']*(?:operacao-|lancar-ssw-portal-operacao|bastao-operacao-client)[^"']*)["']/g)]
      .map((m) => m[1]!)
      .filter((p) => !p.includes("ponte-operacao"));
    if (rel === "health-check/index.ts") {
      assertEquals(imports, ["../_shared/operacao-vigia.ts"], "o health-check só pode importar o vigia puro");
      continue;
    }
    if (imports.length > 0) violacoes.push(`${rel}: ${imports.join(", ")}`);
  }
  assert(vistos > 100, `varredura suspeita: ${vistos}`);
  assertEquals(violacoes, []);
});

Deno.test("INERTE: mig 430 nasce com flags OFF, lista e regras vazias, sem cron; crons só nas 432/433", async () => {
  const s = semComentario(await ler(M430));
  for (const f of ["operacao_fila", "operacao_lancar_ssw", "operacao_tela"]) {
    assert(new RegExp(`\\('${f}', false,`).test(s), `flag ${f} não nasce false`);
  }
  assert(!/INSERT INTO public\.op_codigos_lancaveis/i.test(s), "a 430 cadastra código");
  assert(!/INSERT INTO public\.op_regra_unidade_por_oc/i.test(s), "a 430 cadastra regra de unidade");
  assert(!/INSERT INTO public\.operacao_membros/i.test(s), "a 430 cadastra membro");
  for (const m of [M430, M431]) assert(!/cron\.schedule/i.test(semComentario(await ler(m))), `${m} agenda cron`);
  for (const m of [M432, M433]) {
    const c = semComentario(await ler(m));
    assert(/cron\.schedule/.test(c));
    assert(!/CREATE (TABLE|POLICY|FUNCTION)|ALTER TABLE|INSERT INTO public/i.test(c), `${m} faz mais que agendar`);
  }
});

Deno.test("PROIBIDOS: CHECK de op_codigos_lancaveis e de op_lancamentos tem 49/54/59/33/44/6/9/16/14 (14 nasce do romaneio); 41/56 exigem texto", async () => {
  const s = semComentario(await ler(M430));
  const lista = "(49, 54, 59, 33, 44, 6, 9, 16, 14)";
  assert(s.includes(`CONSTRAINT opcl_proibidos CHECK (codigo NOT IN ${lista})`));
  assert(s.includes(`codigo_oc NOT IN ${lista}`));
  assert(s.includes("CONSTRAINT opcl_texto_41_56 CHECK (codigo NOT IN (41, 56) OR exige_texto)"));
  assert(s.includes("CONSTRAINT opl_texto_41_56 CHECK (codigo_oc NOT IN (41, 56) OR char_length(btrim(texto_operador)) >= 10)"));
  assert(s.includes("d.responsabilidade = 'Operação'"), "trigger/consulta do dicionário");
});

Deno.test("SECURITY DEFINER: toda função das migs 430/431 fixa search_path = ''", async () => {
  for (const m of [M430, M431]) {
    const s = semComentario(await ler(m));
    const funcs = [...s.matchAll(/CREATE OR REPLACE FUNCTION\s+(public\.[a-z0-9_]+)\(([\s\S]*?)\$\$/g)];
    assert(funcs.length > 0);
    for (const f of funcs) {
      assert(/SET search_path = ''/.test(f[0]), `${f[1]} sem search_path fixo vazio`);
    }
  }
});

Deno.test("TABELAS QUENTES: 430 não altera tabela existente; 431 só ACRESCENTA policy RESTRICTIVE e REVOKE", async () => {
  const s430 = semComentario(await ler(M430));
  assert(!/ALTER TABLE public\.(cards|card_events|todos|audit_log|operadores|messages_inbox)\b/i.test(s430));
  assert(!/CREATE TRIGGER[\s\S]{0,80}ON public\.(cards|card_events|todos|operadores)\b/i.test(s430));
  const s431 = semComentario(await ler(M431));
  assert(!/ALTER TABLE/i.test(s431), "431 altera tabela");
  const policies = [...s431.matchAll(/CREATE POLICY[^;]*?;/gs)].map((m) => m[0]);
  const dinamicas = [...s431.matchAll(/'CREATE POLICY[\s\S]*?\)', t\)/g)].map((m) => m[0]);
  assert(policies.length + dinamicas.length >= 2);
  for (const p of [...policies, ...dinamicas]) assert(/AS RESTRICTIVE/.test(p), `policy permissiva na 431: ${p.slice(0, 80)}`);
  const drops = [...s431.matchAll(/DROP POLICY IF EXISTS (\S+)/g)].map((m) => m[1]);
  assertEquals(drops, ["sep_operadores_insert_so_gestor"], "a 431 só derruba policy dela");
  assert(!/GRANT[^;]*TO (anon|authenticated)[^;]*;/i.test(s431.replace(/GRANT EXECUTE ON FUNCTION public\.eh_membro_relacionamento\(\) TO anon, authenticated, service_role;/, "")),
    "a 431 abre acesso (só pode fechar)");
});

Deno.test("SEPARAÇÃO: a 431 cobre as tabelas centrais do Relacionamento e fecha o self-insert em operadores", async () => {
  const s = semComentario(await ler(M431));
  for (const t of ["cards", "card_events", "todos", "messages_inbox", "clientes", "contatos_cliente", "contatos_escalonamento",
                   "cliente_config", "operadores", "email_anexos", "cards_emails_outbound", "templates_email", "pendencias"]) {
    assert(s.includes(`'${t}'`), `tabela ${t} fora da lista da 431`);
  }
  assert(s.includes("AS RESTRICTIVE FOR INSERT TO anon, authenticated\n  WITH CHECK ((SELECT public.current_operador_papel()) = 'gestor')"));
  assert(s.includes("SELECT EXISTS (SELECT 1 FROM public.operadores o WHERE o.user_id = auth.uid())"));
});

Deno.test("CONTRATO COM O FRONT: RPCs liberadas a authenticated na 430 são exatamente estas", async () => {
  const s = semComentario(await ler(M430));
  const liberadas = [...s.matchAll(/GRANT EXECUTE ON FUNCTION public\.([a-z0-9_]+)\([^)]*\) TO authenticated(?:, service_role)?;/g)].map((m) => m[1]).sort();
  assertEquals(liberadas, [
    "current_op_membro_id", "current_op_unidades", "eh_supervisor_op", "op_aceitar_sugestao", "op_assumir",
    "op_cancelar_lancamento", "op_codigos_disponiveis", "op_eh_gestor", "op_flag", "op_item_detalhe", "op_minha_sessao",
    "op_pode_ver_unidade", "op_previa_lancamento", "op_solicitar_lancamento",
  ]);
  // worker/materializador: só service_role
  for (const f of ["op_materializar_aplicar", "op_reservar_lancamentos", "op_finalizar_lancamento", "op_registrar_confirmacao", "op_vigia_resumo", "op__solicitar", "op__checar_lancamento"]) {
    assert(new RegExp(`REVOKE ALL ON FUNCTION public\\.${f}\\([^)]*\\) FROM PUBLIC, anon, authenticated;`).test(s), `${f} aberto a authenticated`);
  }
  assert(s.includes("CREATE VIEW public.op_v_fila WITH (security_invoker = true)"));
});

Deno.test("as edges novas exigem service_role por capacidade (não abrem para usuário logado)", async () => {
  for (const e of ["materializar-fila-operacao", "processar-lancamentos-operacao"]) {
    const src = await ler(`supabase/functions/${e}/index.ts`);
    assert(src.includes('if (!(await ehServiceRoleOperacao(url, req.headers.get("Authorization")))) {'), `${e} sem gate`);
  }
  const cfg = await ler("supabase/config.toml");
  assert(cfg.includes("[functions.materializar-fila-operacao]") && cfg.includes("[functions.processar-lancamentos-operacao]"));
});

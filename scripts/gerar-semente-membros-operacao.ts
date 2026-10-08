// =============================================================================
// Gera a migration de SEMENTE dos membros da Operação (ADR 0042) a partir da planilha
// exportada do Pendências (perfis, setores e filiais de cada pessoa).
//
// Por que planilha: no código do Pendências (@a884368) os membros NÃO existem — perfis
// (user_roles), setores (user_sectors) e filiais (user_branches) só vivem no banco dele.
// A Sal (Tatiana, admin do Pendências) exporta; nada aqui lê aquele banco.
//
// Uso (sem rede, sem banco):
//   deno run --allow-read --allow-write scripts/gerar-semente-membros-operacao.ts \
//     data/operacao/membros-pendencias.csv migration/2026-10-08_442_operacao_membros_semente.sql
//
// Colunas (separador ';'): email;nome;perfil_pendencias;setores_pendencias;filiais;pode_lancar
//   perfil_pendencias: admin|diretor|head|gerente_filial|usuario_setor
//   setores_pendencias: valores do enum do Pendências separados por vírgula (operacao,
//     agendamento, devolucao, ressarcimento, perdas, cliente, relacionamento)
//   filiais: siglas do SSW separadas por vírgula; pode_lancar: sim|nao (padrão nao)
//
// Regras de tradução (docs/PENDENCIAS-REGRAS.md, seção 2):
//   usuario_setor  → operador_op, setores = os dele (sem relacionamento), unidades = filiais
//   gerente_filial → gerente_op, setores = todos da Operação, unidades = filiais
//   admin|diretor|head → supervisor_op (todas as unidades e setores)
//   quem só tem o setor relacionamento → NÃO entra (é do Cockpit do Relacionamento); listado.
//   pode_lancar nasce false salvo 'sim' explícito (ADR 0041 D3).
// =============================================================================

const SETORES_OP = ["OPERACAO", "AGENDAMENTO", "DEVOLUCAO", "RESSARCIMENTO", "PERDAS", "CLIENTE"];

export interface LinhaSemente {
  email: string;
  nome: string;
  papel_op: "operador_op" | "gerente_op" | "supervisor_op";
  setores: string[];
  unidades: string[];
  pode_lancar: boolean;
}

const ORDEM_PERFIL = ["admin", "diretor", "head", "gerente_filial", "usuario_setor"];

/**
 * Export do SQL editor do Pendências (08/10): acesso_total;ativo;email;filiais;nome;perfis;setores,
 * com perfis e setores separados por '|'. Perfil efetivo = o maior (AuthContext.tsx:99-104).
 * Setores = interseção com os da Operação; vazio → {OPERACAO} (os membros já estão cadastrados;
 * a semente só acerta setores — ninguém fica "fora").
 */
export function traduzirExport(csv: string): { linhas: LinhaSemente[]; fora: { email: string; motivo: string }[] } {
  const linhas: LinhaSemente[] = [];
  const fora: { email: string; motivo: string }[] = [];
  const [cab, ...resto] = csv.split(/\r?\n/).filter((l) => l.trim());
  const cols = (cab ?? "").split(";").map((c) => c.trim().toLowerCase());
  const col = (c: string[], n: string) => (c[cols.indexOf(n)] ?? "").trim();
  for (const l of resto) {
    const c = l.split(";");
    const email = col(c, "email").toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) { fora.push({ email, motivo: "e-mail inválido" }); continue; }
    if (col(c, "ativo") === "false") { fora.push({ email, motivo: "inativo no Pendências" }); continue; }
    const perfis = col(c, "perfis").toLowerCase().split("|").filter(Boolean);
    const perfil = ORDEM_PERFIL.find((p) => perfis.includes(p)) ?? "usuario_setor";
    const setores0 = col(c, "setores").toUpperCase().split("|").map((x) => x.trim()).filter((x) => SETORES_OP.includes(x));
    const setores = setores0.length ? SETORES_OP.filter((x) => setores0.includes(x)) : ["OPERACAO"];
    const papel_op = ["admin", "diretor", "head"].includes(perfil) ? "supervisor_op" : perfil === "gerente_filial" ? "gerente_op" : "operador_op";
    linhas.push({ email, nome: col(c, "nome") || email.split("@")[0]!, papel_op, setores, unidades: [], pode_lancar: false });
  }
  return { linhas, fora };
}

export function traduzir(csv: string): { linhas: LinhaSemente[]; fora: { email: string; motivo: string }[] } {
  const linhas: LinhaSemente[] = [];
  const fora: { email: string; motivo: string }[] = [];
  const [cab, ...resto] = csv.split(/\r?\n/).filter((l) => l.trim());
  const cols = (cab ?? "").split(";").map((c) => c.trim().toLowerCase());
  const idx = (n: string) => cols.indexOf(n);
  for (const l of resto) {
    const c = l.split(";").map((x) => x.trim());
    const email = (c[idx("email")] ?? "").toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) { fora.push({ email, motivo: "e-mail inválido" }); continue; }
    const nome = c[idx("nome")] || email.split("@")[0]!;
    const perfil = (c[idx("perfil_pendencias")] ?? "").toLowerCase();
    const setoresP = (c[idx("setores_pendencias")] ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    const unidades = (c[idx("filiais")] ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    const pode_lancar = (c[idx("pode_lancar")] ?? "").toLowerCase() === "sim";
    if (["admin", "diretor", "head"].includes(perfil)) {
      linhas.push({ email, nome, papel_op: "supervisor_op", setores: [...SETORES_OP], unidades, pode_lancar });
    } else if (perfil === "gerente_filial") {
      linhas.push({ email, nome, papel_op: "gerente_op", setores: [...SETORES_OP], unidades, pode_lancar });
    } else if (perfil === "usuario_setor" || perfil === "") {
      const setores = setoresP.filter((s) => SETORES_OP.includes(s));
      if (setores.length === 0) { fora.push({ email, motivo: setoresP.includes("RELACIONAMENTO") ? "só Relacionamento (fica no Cockpit do Relacionamento)" : "sem setor da Operação" }); continue; }
      linhas.push({ email, nome, papel_op: "operador_op", setores, unidades, pode_lancar });
    } else {
      fora.push({ email, motivo: `perfil desconhecido: ${perfil}` });
    }
  }
  return { linhas, fora };
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const arr = (a: string[]) => `ARRAY[${a.map(q).join(", ")}]::text[]`;

export function gerarSql(t: ReturnType<typeof traduzir>, origem: string): string {
  const valores = t.linhas
    .map((l) => `  (${q(l.email)}, ${q(l.nome)}, ${q(l.papel_op)}, ${arr(l.setores)}, ${arr(l.unidades)}, ${l.pode_lancar})`)
    .join(",\n");
  const foraTxt = t.fora.map((f) => `--   ${f.email}: ${f.motivo}`).join("\n") || "--   (nenhum)";
  return `-- =============================================================================
-- 2026-10-08_442 — Semente dos membros da Operação vindos do Pendências (ADR 0042).
-- GERADA por scripts/gerar-semente-membros-operacao.ts a partir de: ${origem}
-- Acerta SETORES (e gerente_op) dos membros que JÁ existem em operacao_membros, casando pelo
-- e-mail (gerente_filial → gerente_op; admin/diretor/head → supervisor_op; usuario_setor mantém
-- o papel atual; unidades e pode_lancar intocados). Não insere membro, não cria login nem senha: quem não casa fica 'pendente'.
-- Idempotente (UPDATE só quando muda). pode_lancar e unidades NÃO são tocados.
-- DEPENDÊNCIAS: 430 (operacao_membros) e 441 (setores, gerente_op).
-- CLASSIFICAÇÃO: TIPO B. AUTORIZACAO: "<quem>, <quando>: <ordem/motivo>" (--autorizado-por).
-- REVERSÃO: UPDATE public.operacao_membros SET setores = '{OPERACAO}' (e papel_op de volta, se preciso);
--           DROP TABLE IF EXISTS public.op_membros_semente;
-- Ficaram de fora da planilha:
${foraTxt}
-- ⚠ NÃO APLICADA. ⚠ SEM BEGIN/COMMIT interno.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.op_membros_semente (
  email       text PRIMARY KEY CHECK (email = lower(btrim(email))),
  nome        text NOT NULL,
  papel_op    text NOT NULL CHECK (papel_op IN ('operador_op', 'supervisor_op', 'gerente_op')),
  setores     text[] NOT NULL,
  unidades    text[] NOT NULL DEFAULT '{}',
  pode_lancar boolean NOT NULL DEFAULT false,
  status      text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'cadastrado', 'ja_existia')),
  fonte       text NOT NULL DEFAULT 'Pendências (export da Sal)',
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.op_membros_semente ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.op_membros_semente FROM anon, authenticated;

${valores ? `INSERT INTO public.op_membros_semente (email, nome, papel_op, setores, unidades, pode_lancar) VALUES
${valores}
ON CONFLICT (email) DO UPDATE SET nome = EXCLUDED.nome, papel_op = EXCLUDED.papel_op, setores = EXCLUDED.setores,
  unidades = EXCLUDED.unidades, pode_lancar = EXCLUDED.pode_lancar, atualizado_em = now();` : "-- Planilha vazia: regenere este arquivo com o export da Sal antes de aplicar."}

-- Os membros JÁ existem em operacao_membros (90 linhas cadastradas em 08/10, vindas do
-- Pendências). Esta semente NÃO insere ninguém: só acerta setores (e gerente_op) dos que casam
-- pelo e-mail. Quem não está em operacao_membros fica 'pendente' (nenhum login é criado).
WITH alvo AS (
  SELECT s.*, m.id AS membro_id
    FROM public.op_membros_semente s
    JOIN public.operacao_membros m ON lower(m.email) = s.email
), upd AS (
  UPDATE public.operacao_membros m
     SET setores = a.setores,
         papel_op = CASE WHEN a.papel_op IN ('gerente_op', 'supervisor_op') THEN a.papel_op ELSE m.papel_op END,
         updated_at = now()
    FROM alvo a
   WHERE m.id = a.membro_id
     AND (m.setores IS DISTINCT FROM a.setores OR (a.papel_op IN ('gerente_op', 'supervisor_op') AND m.papel_op IS DISTINCT FROM a.papel_op))
  RETURNING lower(m.email) AS email
)
UPDATE public.op_membros_semente s
   SET status = CASE WHEN s.email IN (SELECT email FROM upd) THEN 'cadastrado' ELSE 'ja_existia' END,
       atualizado_em = now()
 WHERE s.email IN (SELECT email FROM alvo);

-- Conferência (leitura): quem ficou pendente por não ter login no Cockpit.
-- SELECT email, papel_op, setores, unidades FROM public.op_membros_semente WHERE status = 'pendente';
`;
}

if (import.meta.main) {
  const [entrada, saida] = Deno.args;
  if (!entrada || !saida) {
    console.error("uso: gerar-semente-membros-operacao.ts <planilha.csv> <saida.sql>");
    Deno.exit(2);
  }
  const texto = await Deno.readTextFile(entrada);
  const t = /(^|;)perfis(;|$)/.test(texto.split(/\r?\n/)[0] ?? "") ? traduzirExport(texto) : traduzir(texto);
  await Deno.writeTextFile(saida, gerarSql(t, entrada));
  console.log(`${t.linhas.length} membros na semente; ${t.fora.length} de fora.`);
  for (const f of t.fora) console.log(`  fora: ${f.email} (${f.motivo})`);
}

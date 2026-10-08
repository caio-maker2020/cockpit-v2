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
-- Casa cada pessoa com auth.users pelo e-mail (minúsculas). Quem não tem login no Cockpit NÃO
-- é criado (nem login, nem senha): fica em op_membros_semente com status 'pendente'.
-- Idempotente: ON CONFLICT (user_id) DO NOTHING — nunca sobrescreve um cadastro feito à mão.
-- DEPENDÊNCIAS: 430 (operacao_membros) e 441 (setores, gerente_op).
-- CLASSIFICAÇÃO: TIPO B. AUTORIZACAO: "<quem>, <quando>: <ordem/motivo>" (--autorizado-por).
-- REVERSÃO: DELETE FROM public.operacao_membros WHERE criado_por = 'semente_pendencias_442';
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

-- Casa pelo e-mail e cadastra quem já tem login no Cockpit.
WITH casados AS (
  SELECT s.*, u.id AS user_id
    FROM public.op_membros_semente s
    JOIN auth.users u ON lower(u.email) = s.email
), ins AS (
  INSERT INTO public.operacao_membros (user_id, nome, email, papel_op, setores, unidades, pode_lancar, criado_por)
  SELECT user_id, nome, email, papel_op, setores, unidades, pode_lancar, 'semente_pendencias_442' FROM casados
  ON CONFLICT (user_id) DO NOTHING
  RETURNING email
)
UPDATE public.op_membros_semente s
   SET status = CASE WHEN s.email IN (SELECT email FROM ins) THEN 'cadastrado' ELSE 'ja_existia' END,
       atualizado_em = now()
 WHERE s.email IN (SELECT email FROM casados);

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
  const t = traduzir(await Deno.readTextFile(entrada));
  await Deno.writeTextFile(saida, gerarSql(t, entrada));
  console.log(`${t.linhas.length} membros na semente; ${t.fora.length} de fora.`);
  for (const f of t.fora) console.log(`  fora: ${f.email} (${f.motivo})`);
}

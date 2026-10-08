import { assertEquals } from "jsr:@std/assert@1";
import { gerarSql, traduzir, traduzirExport } from "./gerar-semente-membros-operacao.ts";

Deno.test("semente: perfis do Pendências viram papéis da Operação; Relacionamento fica fora", () => {
  const t = traduzir(
    "email;nome;perfil_pendencias;setores_pendencias;filiais;pode_lancar\n" +
      "A@x.com;A;usuario_setor;operacao,relacionamento;vga;sim\n" +
      "b@x.com;B;gerente_filial;;BHZ;\n" +
      "c@x.com;C;head;;;\n" +
      "d@x.com;D;usuario_setor;relacionamento;VGA;\n" +
      "e@x.com;E;usuario_setor;agendamento;POA;nao\n",
  );
  assertEquals(t.linhas.map((l) => [l.email, l.papel_op, l.setores.join(","), l.unidades.join(","), l.pode_lancar]), [
    ["a@x.com", "operador_op", "OPERACAO", "VGA", true],
    ["b@x.com", "gerente_op", "OPERACAO,AGENDAMENTO,DEVOLUCAO,RESSARCIMENTO,PERDAS,CLIENTE", "BHZ", false],
    ["c@x.com", "supervisor_op", "OPERACAO,AGENDAMENTO,DEVOLUCAO,RESSARCIMENTO,PERDAS,CLIENTE", "", false],
    ["e@x.com", "operador_op", "AGENDAMENTO", "POA", false],
  ]);
  assertEquals(t.fora.map((f) => f.email), ["d@x.com"]);
  const sql = gerarSql(t, "teste.csv");
  assertEquals(sql.includes("INSERT INTO public.operacao_membros"), false);
  assertEquals(sql.includes("UPDATE public.operacao_membros m"), true);
  assertEquals(/RELACIONAMENTO'\]/.test(sql), false);
});

Deno.test("export do Pendências: maior perfil, interseção de setores, vazio → OPERACAO", () => {
  const t = traduzirExport(
    "acesso_total;ativo;email;filiais;nome;perfis;setores\n" +
      "false;true;g@x.com;;G;gerente_filial;devolucao|operacao|relacionamento\n" +
      "true;true;a@x.com;;A;admin|gerente_filial;\n" +
      "false;true;u@x.com;;U;usuario_setor;relacionamento\n" +
      "false;false;i@x.com;;I;usuario_setor;operacao\n",
  );
  assertEquals(t.linhas.map((l) => [l.email, l.papel_op, l.setores.join(",")]), [
    ["g@x.com", "gerente_op", "OPERACAO,DEVOLUCAO"],
    ["a@x.com", "supervisor_op", "OPERACAO"],
    ["u@x.com", "operador_op", "OPERACAO"],
  ]);
  assertEquals(t.fora.map((f) => f.email), ["i@x.com"]);
});

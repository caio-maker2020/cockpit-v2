// Testes do núcleo do robô Würth. A tabela-fixture espelha o RELATÓRIO REAL
// dos frames dos vídeos (Emp | Nota Fiscal | Data | CGC/CPF | Razão Social |
// Telefone | Solução | Data Solução | Obs) — NFs sintéticas, sem PII.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  chaveDedupe,
  loginPorPrefixoCtrc,
  mapearEfeito,
  normalizarNfWurth,
  parseTabelaConsulta,
} from "./wurth-intranet.ts";

// ── prefixo → login (regra do Caio 11/08) ────────────────────────────────────
Deno.test("prefixos de Betim (AMB/WTB) → login AMPLA", () => {
  assertEquals(loginPorPrefixoCtrc("AMB123456-7"), "ampla");
  assertEquals(loginPorPrefixoCtrc("WTB492185-2"), "ampla");
  assertEquals(loginPorPrefixoCtrc("wtb492185-2"), "ampla");
});

Deno.test("prefixos de Cotia (WTC/ARP) → login SAL", () => {
  assertEquals(loginPorPrefixoCtrc("WTC000111-3"), "sal");
  assertEquals(loginPorPrefixoCtrc("ARP987654-1"), "sal");
});

Deno.test("prefixo desconhecido → null (robô consulta os DOIS logins)", () => {
  assertEquals(loginPorPrefixoCtrc("SBD492185-2"), null);
  assertEquals(loginPorPrefixoCtrc(null), null);
  assertEquals(loginPorPrefixoCtrc(""), null);
});

// ── Solução → efeito ─────────────────────────────────────────────────────────
Deno.test("Reentrega → sugerir 21 levando a Obs (instrução da operação)", () => {
  const e = mapearEfeito({
    solucao: "Reentrega",
    obs: "REENTREGAR EM HORÁRIO COMERCIAL - EVITAR ALMOÇO - BERENICE",
  });
  assertEquals(e, {
    tipo: "sugerir_21",
    instrucao: "REENTREGAR EM HORÁRIO COMERCIAL - EVITAR ALMOÇO - BERENICE",
  });
});

Deno.test("Devolver a Wurth → sugerir 44 (motivo vem da ressalva do card)", () => {
  assertEquals(mapearEfeito({ solucao: "Devolver a Wurth", obs: "DEVOLVER BERENICE" }), {
    tipo: "sugerir_44",
  });
});

Deno.test("Obs com CCE vence a Solução — a sugestão nasce do E-MAIL da carta", () => {
  assertEquals(mapearEfeito({ solucao: "Reentrega", obs: "CCE ENVIADA - ATT ELAINE" }), {
    tipo: "aguardar_cce",
  });
});

Deno.test("solução desconhecida → ignorar com motivo (nunca inventa ação)", () => {
  const e = mapearEfeito({ solucao: "Em análise", obs: "" });
  assertEquals(e.tipo, "ignorar");
});

// ── dedupe ───────────────────────────────────────────────────────────────────
Deno.test("mesma linha = mesma chave; linha nova da mesma NF = chave nova (ciclo)", () => {
  const a = chaveDedupe({ nf: "679034", dataSolucao: "2026-08-10 11:23", solucao: "Reentrega" });
  const b = chaveDedupe({ nf: "679034", dataSolucao: "2026-08-10 11:23", solucao: "Reentrega" });
  const c = chaveDedupe({ nf: "679034", dataSolucao: "2026-08-15 09:00", solucao: "Devolver a Wurth" });
  assertEquals(a, b);
  assertEquals(a.data_solucao === c.data_solucao, false);
});

Deno.test("NF normalizada: zeros à esquerda e pontuação fora", () => {
  assertEquals(normalizarNfWurth("00679.034"), "679034");
});

// ── parser da tabela ─────────────────────────────────────────────────────────
const TABELA = `
<html><body><h1>CONSULTA DEVOLUÇÃO</h1>
<table border=1>
<tr><td>Emp</td><td>Nota Fiscal</td><td>Data</td><td>CGC/CPF</td><td>Razão Social</td><td>Telefone</td><td>Solução</td><td>Data Solução</td><td>Obs</td></tr>
<tr><td>24</td><td><a href="#">679034</a></td><td>06/08/2026</td><td>017.875.154/0003-91</td><td>CLIENTE EXEMPLO A</td><td>35 999</td><td>Reentrega</td><td>2026-08-10 11:23</td><td>VENDEDOR SOLICITA NOVA REENTREGA. ATT ANA</td></tr>
<tr><td>24</td><td><a href="#">678448</a></td><td>05/08/2026</td><td>018.842.263/0001-11</td><td>CLIENTE EXEMPLO B</td><td>32 999</td><td>Devolver a Wurth</td><td>2026-08-10 16:11</td><td>DEVOLVER BERENICE</td></tr>
<tr><td>28</td><td><a href="#">345648</a></td><td>07/01/2026</td><td>005.421.047/0000-09</td><td>CLIENTE EXEMPLO C</td><td>(33) 98</td><td>Reentrega</td><td>2026-01-12 10:45</td><td>CCE ENVIADA -ATT ELAINE</td></tr>
<tr><td colspan=9>&nbsp;</td></tr>
</table></body></html>`;

Deno.test("parser: acha as colunas por CABEÇALHO e extrai as 3 linhas reais", () => {
  const linhas = parseTabelaConsulta(TABELA);
  assertEquals(linhas.length, 3);
  assertEquals(linhas[0].nf, "679034");
  assertEquals(linhas[0].solucao, "Reentrega");
  assertEquals(linhas[0].obs, "VENDEDOR SOLICITA NOVA REENTREGA. ATT ANA");
  assertEquals(linhas[1].solucao, "Devolver a Wurth");
  assertEquals(linhas[2].obs, "CCE ENVIADA -ATT ELAINE");
  assertEquals(linhas[0].emp, "24");
  assertEquals(linhas[0].dataSolucao, "2026-08-10 11:23");
});

Deno.test("parser: tolera coluna extra e ordem levemente diferente", () => {
  const html = `<table>
<tr><th>Filial</th><th>Extra</th><th>Nota Fiscal</th><th>Solução</th><th>Data Solução</th><th>Obs</th></tr>
<tr><td>24</td><td>x</td><td>111222</td><td>Reentrega</td><td>2026-08-01</td><td>OK</td></tr>
</table>`;
  const linhas = parseTabelaConsulta(html);
  assertEquals(linhas.length, 1);
  assertEquals(linhas[0].nf, "111222");
  assertEquals(linhas[0].emp, "24");
});

Deno.test("parser: sem tabela reconhecível → lista vazia (nunca lança)", () => {
  assertEquals(parseTabelaConsulta("<html><p>login expirou</p></html>"), []);
  assertEquals(parseTabelaConsulta(null), []);
  assertEquals(parseTabelaConsulta("<table><tr><td>só uma linha</td></tr></table>"), []);
});

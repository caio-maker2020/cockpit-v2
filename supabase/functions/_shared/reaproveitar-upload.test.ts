// Guard de não-regressão do bug NF 941225 (Carlos 2026-10-07, INV-172): cada
// clique recusado na oc 33 subia de novo as páginas do PDF convertido e enchia
// as 20 vagas do card com cópias. O upload que pede o reaproveitamento devolve
// o anexo pendente IDÊNTICO (mesmo card + to-do + nome + tamanho + bytes).
//
// Rodar: deno test supabase/functions/_shared/reaproveitar-upload.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  acharAnexoIdentico,
  type AnexoCandidato,
  bytesIguais,
  CAMPO_REAPROVEITAR,
  MAX_CANDIDATOS_COMPARADOS,
  deveRegistrarDiagnostico,
  type DiagnosticoReaproveitamento,
  linhaAuditDiagnostico,
  pedeReaproveitamento,
  queryCandidatosReaproveitamento,
  reaproveitarUploadIdentico,
  registrarDiagnosticoReaproveitamento,
} from "./reaproveitar-upload.ts";

const enc = (s: string) => new TextEncoder().encode(s);

function candidato(id: string, filename: string, conteudo: string, uploaded_at: string): AnexoCandidato {
  return {
    id,
    filename,
    mime_type: "image/jpeg",
    size_bytes: enc(conteudo).byteLength,
    storage_path: `card-x/${id}/${filename}`,
    uploaded_at,
  };
}

// --- opt-in -----------------------------------------------------------------

Deno.test("pedeReaproveitamento: só o '1' explícito liga", () => {
  assertEquals(CAMPO_REAPROVEITAR, "reaproveitar_identico");
  assertEquals(pedeReaproveitamento("1"), true);
  assertEquals(pedeReaproveitamento(null), false, "sem o campo = comportamento antigo");
  assertEquals(pedeReaproveitamento(""), false);
  assertEquals(pedeReaproveitamento("true"), false);
  assertEquals(pedeReaproveitamento("0"), false);
});

// --- a query ----------------------------------------------------------------

function spyClient(
  resultado: { data: unknown; error: unknown } = { data: [], error: null },
  guardado: string | null = null,
) {
  const calls: { method: string; args: unknown[] }[] = [];
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "neq", "is", "order", "limit"]) {
    builder[m] = (...args: unknown[]) => {
      calls.push({ method: m, args });
      return builder;
    };
  }
  builder.then = (ok: (v: unknown) => unknown) => Promise.resolve(resultado).then(ok);
  const downloads: string[] = [];
  const client = {
    from: (table: string) => {
      calls.push({ method: "from", args: [table] });
      return builder;
    },
    storage: {
      from: (_bucket: string) => ({
        download: (path: string) => {
          downloads.push(path);
          return Promise.resolve(
            guardado === null
              ? { data: null, error: { message: "sem arquivo no teste" } }
              : { data: new Blob([enc(guardado)]), error: null },
          );
        },
      }),
    },
  };
  return { client, calls, downloads };
}

Deno.test("queryCandidatosReaproveitamento: mesmo card + to-do + nome + tamanho, só outbound pendente", () => {
  const { client, calls } = spyClient();
  // deno-lint-ignore no-explicit-any
  queryCandidatosReaproveitamento(client as any, {
    cardId: "card-1",
    todoId: "todo-1",
    filename: "romaneio-scan_p1.jpg",
    sizeBytes: 1234,
  });
  assertEquals(calls.find((c) => c.method === "from")?.args, ["email_anexos"]);
  const eqs = calls.filter((c) => c.method === "eq").map((c) => c.args);
  assert(eqs.some((a) => a[0] === "card_id" && a[1] === "card-1"));
  assert(eqs.some((a) => a[0] === "todo_id" && a[1] === "todo-1"), "escopo é UM to-do");
  assert(eqs.some((a) => a[0] === "origem" && a[1] === "outbound"), "arquivo do cliente (inbound) nunca é devolvido");
  assert(eqs.some((a) => a[0] === "filename" && a[1] === "romaneio-scan_p1.jpg"));
  assert(eqs.some((a) => a[0] === "size_bytes" && a[1] === 1234));
  const isCols = calls.filter((c) => c.method === "is").map((c) => c.args[0]);
  assert(isCols.includes("enviado_em"), "já enviado não volta");
  assert(isCols.includes("deletado_em"), "apagado não volta");
  assertEquals(calls.find((c) => c.method === "order")?.args, ["uploaded_at", { ascending: false }]);
  assertEquals(calls.find((c) => c.method === "limit")?.args, [MAX_CANDIDATOS_COMPARADOS]);
});

// --- quem decide são os bytes -----------------------------------------------

Deno.test("bytesIguais: compara conteúdo, não só tamanho", () => {
  assertEquals(bytesIguais(enc("abcd"), enc("abcd")), true);
  assertEquals(bytesIguais(enc("abcd"), enc("abce")), false, "mesmo tamanho, conteúdo diferente");
  assertEquals(bytesIguais(enc("abc"), enc("abcd")), false);
});

Deno.test("acharAnexoIdentico: devolve o guardado com os MESMOS bytes", async () => {
  const c = candidato("a1", "romaneio-scan_p1.jpg", "PAGINA-1", "2026-08-27T20:25:36Z");
  const achado = await acharAnexoIdentico(
    [c],
    { filename: "romaneio-scan_p1.jpg", bytes: enc("PAGINA-1") },
    () => Promise.resolve(enc("PAGINA-1")),
  );
  assertEquals(achado?.id, "a1");
});

Deno.test("acharAnexoIdentico: mesmo nome e tamanho mas bytes diferentes = cópia nova", async () => {
  const c = candidato("a1", "romaneio-scan_p1.jpg", "PAGINA-1", "2026-08-27T20:25:36Z");
  const achado = await acharAnexoIdentico(
    [c],
    { filename: "romaneio-scan_p1.jpg", bytes: enc("PAGINA-X") },
    () => Promise.resolve(enc("PAGINA-1")),
  );
  assertEquals(achado, null);
});

Deno.test("acharAnexoIdentico: falha ao baixar pula pro próximo e nunca lança", async () => {
  const c1 = candidato("a2", "romaneio-scan_p1.jpg", "PAGINA-1", "2026-09-28T14:18:29Z");
  const c2 = candidato("a1", "romaneio-scan_p1.jpg", "PAGINA-1", "2026-08-27T20:25:36Z");
  const achado = await acharAnexoIdentico(
    [c1, c2],
    { filename: "romaneio-scan_p1.jpg", bytes: enc("PAGINA-1") },
    (path) => path.includes("/a2/") ? Promise.reject(new Error("storage fora")) : Promise.resolve(enc("PAGINA-1")),
  );
  assertEquals(achado?.id, "a1");

  const nenhum = await acharAnexoIdentico(
    [c1],
    { filename: "romaneio-scan_p1.jpg", bytes: enc("PAGINA-1") },
    () => Promise.resolve(null),
  );
  assertEquals(nenhum, null, "sem conseguir ler o guardado, sobe cópia nova");
});

Deno.test("acharAnexoIdentico: nome ou tamanho diferente nem baixa", async () => {
  let baixou = 0;
  const achado = await acharAnexoIdentico(
    [
      candidato("a1", "outra-pagina_p2.jpg", "PAGINA-1", "2026-08-27T20:25:36Z"),
      candidato("a2", "romaneio-scan_p1.jpg", "PAGINA-1-MAIOR", "2026-08-27T20:25:36Z"),
    ],
    { filename: "romaneio-scan_p1.jpg", bytes: enc("PAGINA-1") },
    () => {
      baixou++;
      return Promise.resolve(enc("PAGINA-1"));
    },
  );
  assertEquals(achado, null);
  assertEquals(baixou, 0);
});

Deno.test("acharAnexoIdentico: compara no máximo MAX_CANDIDATOS_COMPARADOS cópias", async () => {
  let baixou = 0;
  const muitos = Array.from({ length: 8 }, (_, i) =>
    candidato(`a${i}`, "romaneio-scan_p1.jpg", "PAGINA-1", `2026-08-27T20:2${i}:00Z`));
  await acharAnexoIdentico(
    muitos,
    { filename: "romaneio-scan_p1.jpg", bytes: enc("PAGINA-1") },
    () => {
      baixou++;
      return Promise.resolve(enc("OUTRA"));
    },
  );
  assertEquals(baixou, MAX_CANDIDATOS_COMPARADOS);
});

// --- orquestração -----------------------------------------------------------

Deno.test("reaproveitarUploadIdentico: sem to-do não consulta nada", async () => {
  const { client, calls } = spyClient();
  const r = await reaproveitarUploadIdentico(
    // deno-lint-ignore no-explicit-any
    client as any,
    { cardId: "card-1", todoId: null, filename: "romaneio-scan_p1.jpg", bytes: enc("PAGINA-1") },
  );
  assertEquals(r, null);
  assertEquals(calls.length, 0);
});

Deno.test("reaproveitarUploadIdentico: erro na consulta = cópia nova (comportamento antigo)", async () => {
  const { client } = spyClient({ data: null, error: { message: "falhou" } });
  const r = await reaproveitarUploadIdentico(
    // deno-lint-ignore no-explicit-any
    client as any,
    { cardId: "card-1", todoId: "todo-1", filename: "romaneio-scan_p1.jpg", bytes: enc("PAGINA-1") },
  );
  assertEquals(r, null);
});

Deno.test("reaproveitarUploadIdentico: arquivo guardado ilegível = cópia nova", async () => {
  const c = candidato("a1", "romaneio-scan_p1.jpg", "PAGINA-1", "2026-08-27T20:25:36Z");
  const { client, downloads } = spyClient({ data: [c], error: null });
  const r = await reaproveitarUploadIdentico(
    // deno-lint-ignore no-explicit-any
    client as any,
    { cardId: "card-1", todoId: "todo-1", filename: "romaneio-scan_p1.jpg", bytes: enc("PAGINA-1") },
  );
  assertEquals(r, null);
  assertEquals(downloads, [c.storage_path]);
});

Deno.test("reaproveitarUploadIdentico: guardado idêntico no bucket → devolve o registro existente", async () => {
  const c = candidato("a1", "romaneio-scan_p1.jpg", "PAGINA-1", "2026-08-27T20:25:36Z");
  const { client, downloads } = spyClient({ data: [c], error: null }, "PAGINA-1");
  const r = await reaproveitarUploadIdentico(
    // deno-lint-ignore no-explicit-any
    client as any,
    { cardId: "card-1", todoId: "todo-1", filename: "romaneio-scan_p1.jpg", bytes: enc("PAGINA-1") },
  );
  assertEquals(r?.id, "a1");
  assertEquals(downloads, [c.storage_path]);
});

// --- o caso real, com nomes fictícios ----------------------------------------

Deno.test("cenário NF 941225: 5 cópias pendentes da página 1 → devolve a mais recente, sem cópia nova", async () => {
  // A consulta já vem do banco ordenada (mais recente primeiro) e limitada.
  const copias = [
    candidato("p1-28set", "romaneio-scan_p1.jpg", "PAGINA-1", "2026-09-28T14:18:29Z"),
    candidato("p1-27ago-d", "romaneio-scan_p1.jpg", "PAGINA-1", "2026-08-27T20:27:23Z"),
    candidato("p1-27ago-c", "romaneio-scan_p1.jpg", "PAGINA-1", "2026-08-27T20:26:56Z"),
  ];
  let baixou = 0;
  const achado = await acharAnexoIdentico(
    copias,
    { filename: "romaneio-scan_p1.jpg", bytes: enc("PAGINA-1") },
    () => {
      baixou++;
      return Promise.resolve(enc("PAGINA-1"));
    },
  );
  assertEquals(achado?.id, "p1-28set");
  assertEquals(baixou, 1, "a 1ª cópia idêntica basta");
});

// --- diagnóstico (Carlos 08/10): só descreve, nunca muda a decisão ----------

async function diagnosticar(
  resultadoQuery: { data: unknown; error: unknown },
  guardado: string | null,
  todoId: string | null = "todo-1",
): Promise<{ r: AnexoCandidato | null; d: DiagnosticoReaproveitamento | null }> {
  const { client } = spyClient(resultadoQuery, guardado);
  let d: DiagnosticoReaproveitamento | null = null;
  const r = await reaproveitarUploadIdentico(
    // deno-lint-ignore no-explicit-any
    client as any,
    { cardId: "card-1", todoId, filename: "romaneio-scan_p1.jpg", bytes: enc("PAGINA-1") },
    (x) => {
      d = x;
    },
  );
  return { r, d };
}

Deno.test("diagnóstico: cada motivo sai certo e a decisão é a mesma de antes", async () => {
  const c = candidato("a1", "romaneio-scan_p1.jpg", "PAGINA-1", "2026-08-27T20:25:36Z");

  const ok = await diagnosticar({ data: [c], error: null }, "PAGINA-1");
  assertEquals(ok.r?.id, "a1");
  assertEquals(ok.d, { resultado: "reaproveitado", candidatos: 1, baixados: 1 });

  const dif = await diagnosticar({ data: [c], error: null }, "PAGINA-X");
  assertEquals(dif.r, null);
  assertEquals(dif.d, { resultado: "bytes_diferentes", candidatos: 1, baixados: 1 });

  const semArq = await diagnosticar({ data: [c], error: null }, null);
  assertEquals(semArq.r, null);
  assertEquals(semArq.d, { resultado: "download_falhou", candidatos: 1, baixados: 0 });

  const vazio = await diagnosticar({ data: [], error: null }, null);
  assertEquals(vazio.r, null);
  assertEquals(vazio.d, { resultado: "sem_candidato", candidatos: 0, baixados: 0 });

  const erro = await diagnosticar({ data: null, error: { message: "x" } }, null);
  assertEquals(erro.r, null);
  assertEquals(erro.d, { resultado: "erro_consulta", candidatos: 0, baixados: 0 });

  const semTodo = await diagnosticar({ data: [c], error: null }, "PAGINA-1", null);
  assertEquals(semTodo.r, null);
  assertEquals(semTodo.d, { resultado: "sem_todo", candidatos: 0, baixados: 0 });
});

Deno.test("diagnóstico: callback que lança não muda o resultado nem quebra", async () => {
  const c = candidato("a1", "romaneio-scan_p1.jpg", "PAGINA-1", "2026-08-27T20:25:36Z");
  const { client } = spyClient({ data: [c], error: null }, "PAGINA-1");
  const r = await reaproveitarUploadIdentico(
    // deno-lint-ignore no-explicit-any
    client as any,
    { cardId: "card-1", todoId: "todo-1", filename: "romaneio-scan_p1.jpg", bytes: enc("PAGINA-1") },
    () => {
      throw new Error("callback quebrado");
    },
  );
  assertEquals(r?.id, "a1");
});

Deno.test("deveRegistrarDiagnostico: quem pediu, ou página convertida com to-do", () => {
  assertEquals(deveRegistrarDiagnostico({ pedido: true, filename: "qualquer.pdf", todoId: null }), true);
  assertEquals(deveRegistrarDiagnostico({ pedido: false, filename: "romaneio-scan_p3.jpg", todoId: "t" }), true,
    "página convertida SEM o pedido = tela antiga: é exatamente o que precisamos ver");
  assertEquals(deveRegistrarDiagnostico({ pedido: false, filename: "romaneio-scan_P12.JPG", todoId: "t" }), true);
  assertEquals(deveRegistrarDiagnostico({ pedido: false, filename: "romaneio-scan_p1.jpg", todoId: null }), false);
  assertEquals(deveRegistrarDiagnostico({ pedido: false, filename: "foto-avaria.jpg", todoId: "t" }), false);
  assertEquals(deveRegistrarDiagnostico({ pedido: false, filename: "nota_p1.pdf", todoId: "t" }), false);
});

Deno.test("linhaAuditDiagnostico: valores que o banco aceita + o que responde a dúvida", () => {
  const base = {
    cardId: "card-1",
    todoId: "todo-1",
    operadorId: "op-1",
    filename: "romaneio-scan_p1.jpg",
    sizeBytes: 8,
  };
  const pedida = linhaAuditDiagnostico({
    ...base,
    pedido: true,
    diagnostico: { resultado: "bytes_diferentes", candidatos: 2, baixados: 2 },
  }, "k1");
  // CHECKs de audit_log (mig 001): actor_type, external_system e status.
  assertEquals(pedida.actor_type, "operator");
  assertEquals(pedida.external_system, "internal");
  assertEquals(pedida.status, "success");
  assertEquals(pedida.idempotency_key, "k1");
  assertEquals(pedida.card_id, "card-1");
  assertEquals(pedida.action_type, "upload_reaproveitamento_diagnostico");
  assertEquals(pedida.request_payload.pedido, true);
  assertEquals(pedida.request_payload.resultado, "bytes_diferentes");
  assertEquals(pedida.request_payload.candidatos, 2);

  const naoPedida = linhaAuditDiagnostico({ ...base, pedido: false, diagnostico: null }, "k2");
  assertEquals(naoPedida.request_payload.pedido, false);
  assertEquals(naoPedida.request_payload.resultado, "nao_pedido");
  assertEquals(naoPedida.request_payload.candidatos, null);

  const comErro = linhaAuditDiagnostico({ ...base, pedido: true, diagnostico: null, erro: "falhou" }, "k3");
  assertEquals(comErro.request_payload.resultado, "erro");
  assertEquals(comErro.request_payload.erro, "falhou");
});

const registroBase = {
  cardId: "card-1",
  todoId: "todo-1",
  operadorId: "op-1",
  filename: "romaneio-scan_p1.jpg",
  sizeBytes: 8,
  pedido: true,
  diagnostico: { resultado: "reaproveitado" as const, candidatos: 1, baixados: 1 },
};

Deno.test("registrarDiagnostico: grava UMA linha em audit_log", async () => {
  const gravados: { tabela: string; linha: Record<string, unknown> }[] = [];
  const client = {
    from: (tabela: string) => ({
      insert: (linha: Record<string, unknown>) => {
        gravados.push({ tabela, linha });
        return Promise.resolve({ error: null });
      },
    }),
  };
  await registrarDiagnosticoReaproveitamento(client, registroBase);
  assertEquals(gravados.length, 1);
  assertEquals(gravados[0]!.tabela, "audit_log");
  assert(typeof gravados[0]!.linha.idempotency_key === "string");
});

Deno.test("registrarDiagnostico: erro do banco, exceção ou demora NUNCA lançam nem travam", async () => {
  // banco devolve erro
  await registrarDiagnosticoReaproveitamento(
    { from: () => ({ insert: () => Promise.resolve({ error: { message: "check violado" } }) }) },
    registroBase,
  );
  // insert rejeita
  await registrarDiagnosticoReaproveitamento(
    { from: () => ({ insert: () => Promise.reject(new Error("rede caiu")) }) },
    registroBase,
  );
  // from() lança na hora
  await registrarDiagnosticoReaproveitamento(
    {
      from: () => {
        throw new Error("client quebrado");
      },
    },
    registroBase,
  );
  // insert que nunca responde: volta no teto de tempo
  const inicio = Date.now();
  await registrarDiagnosticoReaproveitamento(
    { from: () => ({ insert: () => new Promise(() => {}) }) },
    registroBase,
    30,
  );
  assert(Date.now() - inicio < 2000, "o teto de tempo tem de soltar o upload");
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Guarda do MODO SOMENTE-LEITURA (piloto de migração do Lovable).
 *
 * A propriedade que este teste protege: com VITE_ACOES_DESABILITADAS=true,
 * NENHUMA escrita sai do browser. Não basta a UI desabilitar o botão; a
 * chamada não pode nem chegar na rede. Por isso asserimos sobre `fetch`.
 */

const ENV_BASE: Record<string, string> = {
  VITE_SUPABASE_URL: "https://exemplo.supabase.co",
  VITE_SUPABASE_ANON_KEY: "anon-key-de-teste",
};

/** RPCs que MUDAM estado. Nenhum destes pode passar no modo leitura. */
const RPC_DE_ESCRITA = [
  "aprovar_e_executar",
  "lancar_oc_emergencial_acao_executada",
  "adotar_thread_preexistente",
  "descartar_email_preexistente",
  "marcar_card_nao_importante",
  "reportar_erro_lancamento",
  "marcar_cancelamento_tratado",
  "extravios_atualizar_status",
  "cadastrar_cliente_completo",
  "desativar_cliente",
  "liberar_card_suspeito_lockado",
  "ignorar_pendencias_resposta_cliente",
  // Carlos/Caio 04/09 (NF 632603): confirmar evidência do dossiê MUDA estado
  // (agent_state + recarimba meta.gate_oc33) — modo leitura tem que barrar.
  "confirmar_evidencia_dossie",
];

/** Edge functions com efeito externo (e-mail, SSW, admin). */
const FN_DE_ESCRITA = [
  "responder-email-cliente",
  "cobrar-cliente-aguardando",
  "enviar-cobranca-base",
  "redator-email-saida",
  "executar-sugestao-evidencia",
  "forcar-cancelamento-reentrega",
  "criar-card-manual",
  "admin-operadores",
  "recuperar-senha-operador",
  "upload-anexo-email",
];

async function carregarClient(acoesDesabilitadas?: string) {
  vi.resetModules();
  for (const [k, v] of Object.entries(ENV_BASE)) vi.stubEnv(k, v);
  // SEMPRE controla a flag no teste. Senão o `.env.local` do projeto (que tem
  // VITE_ACOES_DESABILITADAS=true pro piloto) vaza pro import.meta.env do
  // vitest e contamina o caso "default". "" simula a var ausente (= off).
  vi.stubEnv("VITE_ACOES_DESABILITADAS", acoesDesabilitadas ?? "");
  return await import("./supabase");
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn(
    async () =>
      new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("modo somente-leitura ligado", () => {
  it("bloqueia TODOS os rpc de escrita, e nada chega na rede", async () => {
    const { supabase, ACOES_DESABILITADAS } = await carregarClient("true");
    expect(ACOES_DESABILITADAS).toBe(true);

    for (const rpc of RPC_DE_ESCRITA) {
      const { error } = (await supabase.rpc(rpc as never)) as {
        error: { name?: string } | null;
      };
      expect(error?.name, `rpc ${rpc} deveria estar bloqueado`).toBe(
        "AcaoBloqueadaModoLeitura",
      );
    }

    expect(fetchSpy, "nenhuma escrita pode sair do browser").not.toHaveBeenCalled();
  });

  it("bloqueia TODAS as edge functions de escrita, e nada chega na rede", async () => {
    const { supabase } = await carregarClient("true");

    for (const fn of FN_DE_ESCRITA) {
      const { error } = await supabase.functions.invoke(fn);
      expect(
        (error as { name?: string } | null)?.name,
        `fn ${fn} deveria estar bloqueada`,
      ).toBe("AcaoBloqueadaModoLeitura");
    }

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("bloqueia escrita DIRETA em tabela (insert/update/upsert/delete)", async () => {
    const { supabase } = await carregarClient("true");

    // Casos reais do front: update state, assigned_operator_id, insert card_events, delete.
    const escritas: Array<Promise<{ error: { name?: string } | null }>> = [
      supabase.from("cards").update({ state: "X" }).eq("id", "1") as never,
      supabase.from("cards").update({ assigned_operator_id: "op" }).eq("id", "1") as never,
      supabase.from("card_events").insert({ card_id: "1" }) as never,
      supabase.from("contatos_escalonamento").delete().eq("id", "1") as never,
    ];
    for (const p of escritas) {
      const { error } = await p;
      expect(error?.name).toBe("AcaoBloqueadaModoLeitura");
    }
    expect(fetchSpy, "escrita direta em tabela não pode sair").not.toHaveBeenCalled();
  });

  it("deixa passar o SELECT (leitura em tabela), senão a board fica vazia", async () => {
    const { supabase } = await carregarClient("true");
    await supabase.from("cards").select("id").limit(1);
    expect(fetchSpy, "SELECT precisa alcançar a rede").toHaveBeenCalled();
  });

  it("deixa passar a leitura via rpc (allowlist), senão a operadora não enxerga nada", async () => {
    const { supabase } = await carregarClient("true");

    const { error } = (await supabase.rpc("status_ultimo_sync_bastao" as never)) as {
      error: { name?: string } | null;
    };
    expect(error?.name).not.toBe("AcaoBloqueadaModoLeitura");
    expect(fetchSpy, "leitura precisa alcançar a rede").toHaveBeenCalled();
  });
});

describe("modo somente-leitura desligado (default)", () => {
  it("sem a env var, o comportamento é o de hoje: escrita passa", async () => {
    const { supabase, ACOES_DESABILITADAS } = await carregarClient(undefined);
    expect(ACOES_DESABILITADAS).toBe(false);

    const { error } = (await supabase.rpc("aprovar_e_executar" as never)) as {
      error: { name?: string } | null;
    };
    expect(error?.name).not.toBe("AcaoBloqueadaModoLeitura");
    expect(fetchSpy, "sem a flag, a chamada sai normal").toHaveBeenCalled();
  });

  it("VITE_ACOES_DESABILITADAS=false também deixa passar", async () => {
    const { ACOES_DESABILITADAS } = await carregarClient("false");
    expect(ACOES_DESABILITADAS).toBe(false);
  });
});

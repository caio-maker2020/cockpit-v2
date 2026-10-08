// Fila e fluxo prévia → confirmação da tela da Operação, contra o adaptador
// em memória (as mesmas regras da mig 430), sem rede e sem Supabase.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("@/lib/supabase", () => ({ supabase: null, isSupabaseConfigured: false }));
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { id: "u-teste" }, operador: null, operadorCarregado: true }),
}));

import Operacao from "./Operacao";
import EspelhoRelacionamento from "./EspelhoRelacionamento";
import { OpApiProvider } from "@/contexts/OperacaoContext";
import { criarAdaptadorDemo, type OpcoesDemo } from "@/lib/operacao/demo/adaptadorDemo";
import type { OpApi } from "@/lib/operacao/api";
import { lerFixtureFila } from "@/lib/operacao/demo/adaptadorDemo";

function montar(api: OpApi, rota = "/operacao") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <OpApiProvider api={api}>
        <MemoryRouter initialEntries={[rota]}>
          <Routes>
            <Route path="/operacao" element={<Operacao />} />
            <Route path="/operacao/:itemId" element={<Operacao />} />
          </Routes>
        </MemoryRouter>
      </OpApiProvider>
    </QueryClientProvider>,
  );
}

const demo = (o: OpcoesDemo = {}) => criarAdaptadorDemo({ latenciaMs: 0, simularWorker: false, ...o });

beforeEach(() => {
  try {
    window.localStorage?.clear();
  } catch {
    /* sem localStorage no ambiente de teste: usePersistentState cai no padrão */
  }
});

describe("fila da Operação", () => {
  it("lista os 25 itens, o mais parado primeiro", async () => {
    montar(demo());
    await screen.findByText(/25 notas/);
    fireEvent.click(screen.getByRole("button", { name: "Lista" }));
    expect(screen.getByTestId("contagem-fila")).toHaveTextContent("25 de 25");
    const linhas = within(screen.getByRole("list", { name: "Fila da Operação" })).getAllByRole("button");
    // demo-item-10: parado há 96 h, o maior da semente
    expect(linhas[0]).toHaveAttribute("data-testid", "linha-demo-item-10");
  });

  it("filtros: com sugestão, oc e busca", async () => {
    montar(demo());
    await screen.findByText(/25 notas/);
    fireEvent.click(screen.getByRole("button", { name: "Com sugestão" }));
    expect(screen.getByTestId("contagem-fila")).toHaveTextContent("12 de 25");
    fireEvent.click(screen.getByRole("button", { name: /Limpar/ }));
    fireEvent.change(screen.getByLabelText("Filtrar por ocorrência"), { target: { value: "56" } });
    expect(screen.getByTestId("contagem-fila")).toHaveTextContent("2 de 25");
    fireEvent.click(screen.getByRole("button", { name: /Limpar/ }));
    fireEvent.change(screen.getByLabelText("Buscar na fila"), { target: { value: "VGA401200-0" } });
    expect(screen.getByTestId("contagem-fila")).toHaveTextContent("1 de 25");
  });
});

describe("lançar: SEMPRE prévia → confirmação (INV-041/053/185)", () => {
  it("mostra CTRC, NF, código, texto e conta, e só lança com o token da prévia", async () => {
    const api = demo();
    const solicitar = vi.spyOn(api, "solicitar");
    const previa = vi.spyOn(api, "previa");
    montar(api, "/operacao/demo-item-01");
    await screen.findByTestId("detalhe-item-operacao");

    fireEvent.change(screen.getByLabelText("Código"), { target: { value: "14" } });
    fireEvent.change(screen.getByLabelText(/Texto/), { target: { value: "Motorista saiu para a rota" } });
    expect(solicitar).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Ver prévia do lançamento/ }));

    const caixa = await screen.findByTestId("previa-lancamento");
    expect(previa).toHaveBeenCalledWith("demo-item-01", 14, "Motorista saiu para a rota");
    expect(caixa).toHaveTextContent("VGA401200-0");
    expect(caixa).toHaveTextContent("880100");
    expect(caixa).toHaveTextContent("oc 14");
    expect(caixa).toHaveTextContent("Entrega iniciada");
    expect(caixa).toHaveTextContent("Motorista saiu para a rota (Operação VGA por Marina Duarte)");
    expect(caixa).toHaveTextContent("ai.salex");
    expect(solicitar).not.toHaveBeenCalled(); // a prévia não grava nada

    const token = (await previa.mock.results[0]!.value) as { confirmacao: string };
    fireEvent.click(screen.getByRole("button", { name: /Confirmar e lançar oc 14/ }));
    await waitFor(() => expect(solicitar).toHaveBeenCalledTimes(1));
    expect(solicitar).toHaveBeenCalledWith("demo-item-01", 14, "Motorista saiu para a rota", token.confirmacao);
    await waitFor(() => expect(screen.queryByTestId("previa-lancamento")).not.toBeInTheDocument());
    expect(await screen.findAllByText(/Na fila · oc 14/)).not.toHaveLength(0);
  });

  it("prévia desatualizada: mostra a prévia NOVA e exige novo clique", async () => {
    const api = demo();
    let primeira = true;
    const solicitar = vi.spyOn(api, "solicitar").mockImplementation(async (id, cod, txt) => {
      const p = await api.previa(id, cod, txt);
      const ok = p as Extract<typeof p, { ok: true }>;
      if (primeira) {
        // O servidor viu mudança entre a prévia e o clique: devolve a prévia nova, nada grava.
        primeira = false;
        return {
          ok: false,
          erro: "previa_desatualizada",
          previa: { ...ok.previa, oc_atual: 99, texto_ssw: "TEXTO NOVO DO SERVIDOR" },
          confirmacao: "token-novo",
        };
      }
      return { ok: true, lancamento_id: "l-teste", status: "fila", previa: ok.previa };
    });
    montar(api, "/operacao/demo-item-01");
    await screen.findByTestId("detalhe-item-operacao");
    fireEvent.change(screen.getByLabelText("Código"), { target: { value: "15" } });
    fireEvent.click(screen.getByRole("button", { name: /Ver prévia do lançamento/ }));
    await screen.findByTestId("previa-lancamento");
    fireEvent.click(screen.getByRole("button", { name: /Confirmar e lançar/ }));

    await screen.findByText(/mudou desde a prévia/);
    expect(screen.getByTestId("previa-lancamento")).toHaveTextContent("TEXTO NOVO DO SERVIDOR");
    expect(solicitar).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /Confirmar e lançar/ }));
    await waitFor(() => expect(solicitar).toHaveBeenCalledTimes(2));
    expect(solicitar.mock.calls[1]![3]).toBe("token-novo");
  });

  it("oc que exige texto (56) não abre prévia sem o texto da pessoa", async () => {
    const api = demo();
    const previa = vi.spyOn(api, "previa");
    montar(api, "/operacao/demo-item-01");
    await screen.findByTestId("detalhe-item-operacao");
    fireEvent.change(screen.getByLabelText("Código"), { target: { value: "56" } });
    fireEvent.click(screen.getByRole("button", { name: /Ver prévia do lançamento/ }));
    expect(await screen.findByText(/exige o seu texto/)).toBeInTheDocument();
    expect(previa).not.toHaveBeenCalled();
  });

  it("erro do servidor vira mensagem humana (cerca do Relacionamento)", async () => {
    montar(demo(), "/operacao/demo-item-11");
    await screen.findByTestId("detalhe-item-operacao");
    fireEvent.change(screen.getByLabelText("Código"), { target: { value: "14" } });
    fireEvent.click(screen.getByRole("button", { name: /Ver prévia do lançamento/ }));
    expect(await screen.findByText(/tratativa aberta no Relacionamento/)).toBeInTheDocument();
    expect(screen.queryByTestId("previa-lancamento")).not.toBeInTheDocument();
  });

  it("aceitar sugestão = 1 clique que abre a MESMA prévia; o pedido leva o token", async () => {
    const api = demo();
    const aceitar = vi.spyOn(api, "aceitarSugestao");
    const previa = vi.spyOn(api, "previa");
    montar(api, "/operacao/demo-item-02");
    await screen.findByTestId("detalhe-item-operacao");
    fireEvent.click(screen.getByRole("button", { name: "Aceitar sugestão" }));
    const caixa = await screen.findByTestId("previa-lancamento");
    expect(previa).toHaveBeenCalledWith("demo-item-02", 15, "Base sem janela de entrega para a cidade hoje");
    expect(caixa).toHaveTextContent("oc 15");
    expect(aceitar).not.toHaveBeenCalled();
    const token = ((await previa.mock.results[0]!.value) as { confirmacao: string }).confirmacao;
    fireEvent.click(screen.getByRole("button", { name: /Confirmar e lançar oc 15/ }));
    await waitFor(() => expect(aceitar).toHaveBeenCalledWith("demo-item-02", token));
  });

  it("cancelar enquanto está na fila", async () => {
    const api = demo();
    const cancelar = vi.spyOn(api, "cancelar");
    montar(api, "/operacao/demo-item-03");
    await screen.findByTestId("detalhe-item-operacao");
    fireEvent.click(await screen.findByRole("button", { name: "Cancelar pedido" }));
    await waitFor(() => expect(cancelar).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancelar pedido" })).not.toBeInTheDocument());
  });

  it("lista de códigos vazia: estado vazio claro", async () => {
    montar(demo({ codigos: [] }), "/operacao/demo-item-01");
    expect(await screen.findByText("A Operação ainda não liberou códigos para lançamento")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Ver prévia do lançamento/ })).not.toBeInTheDocument();
  });

  it("sem permissão de lançar: o formulário fica travado e diz por quê", async () => {
    const api = demo({
      membro: { id: "m", nome: "Ana Leitura", email: null, papel_op: "operador_op", unidades: ["VGA"], pode_lancar: false },
    });
    montar(api, "/operacao/demo-item-01");
    await screen.findByTestId("detalhe-item-operacao");
    expect(screen.getAllByText(/só de leitura/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Ver prévia do lançamento/ })).toBeDisabled();
  });
});

describe("kanban por problema (visão principal)", () => {
  it("abre agrupado pela família da oc, com o andamento como selo no cartão", async () => {
    montar(demo());
    await screen.findByText(/25 notas/);
    const pronta = screen.getByTestId("coluna-pronta_entrega");
    // demo-item-02: oc 36 (chegada na base para entrega)
    const cartao = within(pronta).getByTestId("cartao-demo-item-02");
    expect(within(cartao).getByTestId("selo-andamento")).toHaveTextContent("Nova");
    // demo-item-03: oc 13 com pedido na fila
    const c3 = within(screen.getByTestId("coluna-entrega_impossivel")).getByTestId("cartao-demo-item-03");
    expect(within(c3).getByTestId("selo-andamento")).toHaveTextContent("Na fila");
    let total = 0;
    for (const col of screen.getAllByTestId(/^coluna-/)) total += within(col).queryAllByTestId(/^cartao-/).length;
    expect(total).toBe(25);
  });

  it("filtros valem também no kanban", async () => {
    montar(demo());
    await screen.findByText(/25 notas/);
    fireEvent.change(screen.getByLabelText("Filtrar por ocorrência"), { target: { value: "36" } });
    let total = 0;
    for (const col of screen.getAllByTestId(/^coluna-/)) total += within(col).queryAllByTestId(/^cartao-/).length;
    expect(total).toBe(within(screen.getByTestId("coluna-pronta_entrega")).queryAllByTestId(/^cartao-/).length);
    expect(total).toBeGreaterThan(0);
  });

  it("coluna grande mostra 50 por vez, com 'ver mais'", async () => {
    const linhas = lerFixtureFila(
      Array.from({ length: 120 }, (_, i) => ({
        op_item_id: `r${i}`,
        ctrc: `VGA${100000 + i}-1`,
        nf: String(5000 + i),
        unidade: "VGA",
        cod_ultima_ocorrencia: 13,
        data_ultima_ocorrencia: new Date(Date.now() - (i + 1) * 3_600_000).toISOString(),
      })),
    );
    montar(demo({ linhasReais: linhas }));
    await screen.findByText(/120 notas/);
    const col = screen.getByTestId("coluna-entrega_impossivel");
    const cartoes = within(col).getAllByTestId(/^cartao-/);
    expect(cartoes).toHaveLength(50);
    expect(cartoes[0]).toHaveAttribute("data-testid", "cartao-r119"); // o mais parado primeiro
    fireEvent.click(within(col).getByRole("button", { name: /Ver mais 50 \(faltam 70\)/ }));
    expect(within(col).getAllByTestId(/^cartao-/)).toHaveLength(100);
  });
});

describe("kanban por andamento (alternativa)", () => {
  it("6 colunas de status e cada item em exatamente uma", async () => {
    montar(demo());
    await screen.findByText(/25 notas/);
    fireEvent.click(screen.getByRole("button", { name: "Por andamento" }));
    const ids = ["nova", "assumida", "na_fila_ssw", "lancada", "confirmada", "problema"];
    let total = 0;
    for (const id of ids) total += within(screen.getByTestId(`coluna-${id}`)).queryAllByTestId(/^cartao-/).length;
    expect(total).toBe(25);
    expect(within(screen.getByTestId("coluna-na_fila_ssw")).getByTestId("cartao-demo-item-03")).toBeInTheDocument();
    expect(within(screen.getByTestId("coluna-problema")).getByTestId("cartao-demo-item-12")).toBeInTheDocument();
    expect(within(screen.getByTestId("coluna-assumida")).getByTestId("cartao-demo-item-05")).toBeInTheDocument();
  });

});

describe("ações no cartão", () => {
  it("sugestão destacada no cartão com confiança e casos", async () => {
    montar(demo());
    await screen.findByText(/25 notas/);
    expect(within(screen.getByTestId("cartao-demo-item-02")).getByText(
      "Sugestão: 15 — 82% (aprendida com a Sal: 41 de 50 casos parecidos)",
    )).toBeInTheDocument();
  });

  it("aceitar sugestão no cartão abre a MESMA prévia; só o confirmar pede o lançamento", async () => {
    const api = demo();
    const aceitar = vi.spyOn(api, "aceitarSugestao");
    const previa = vi.spyOn(api, "previa");
    montar(api);
    await screen.findByText(/25 notas/);
    fireEvent.click(screen.getByRole("button", { name: "Aceitar sugestão da NF 880213" }));
    const caixa = await screen.findByTestId("previa-lancamento");
    expect(caixa).toHaveTextContent("VGA401237-7");
    expect(caixa).toHaveTextContent("ai.salex");
    expect(aceitar).not.toHaveBeenCalled();
    const token = ((await previa.mock.results[0]!.value) as { confirmacao: string }).confirmacao;
    fireEvent.click(screen.getByRole("button", { name: /Confirmar e lançar oc 15/ }));
    await waitFor(() => expect(aceitar).toHaveBeenCalledWith("demo-item-02", token));
    await waitFor(() =>
      expect(within(screen.getByTestId("cartao-demo-item-02")).getByTestId("selo-andamento")).toHaveTextContent("Na fila"),
    );
  });

  it("assumir no cartão move para Assumida", async () => {
    const api = demo();
    montar(api);
    await screen.findByText(/25 notas/);
    fireEvent.click(screen.getByRole("button", { name: "Por andamento" }));
    expect(within(screen.getByTestId("coluna-nova")).getByTestId("cartao-demo-item-04")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Assumir NF 880439" }));
    await waitFor(() =>
      expect(within(screen.getByTestId("coluna-assumida")).getByTestId("cartao-demo-item-04")).toBeInTheDocument(),
    );
  });
});

describe("encaminhar ao Relacionamento (D11)", () => {
  it("sugestão do agente no cartão → prévia com o texto exato da 49 → encaminhar com o token; o item sai das colunas", async () => {
    const api = demo();
    const encaminhar = vi.spyOn(api, "encaminhar");
    const previa = vi.spyOn(api, "previaEncaminhamento");
    const aceitar = vi.spyOn(api, "aceitarSugestao");
    montar(api);
    await screen.findByText(/25 notas/);
    const cartao = screen.getByTestId("cartao-demo-item-10");
    expect(within(cartao).getByTestId("sugestao-cartao")).toHaveTextContent(
      "Sugestão: encaminhar ao Relacionamento — agente de IA: 72% — Três tentativas",
    );
    fireEvent.click(within(cartao).getByRole("button", { name: /Encaminhar ao Relacionamento a NF/ }));
    const caixa = await screen.findByTestId("previa-encaminhamento");
    expect(caixa).toHaveTextContent("Cliente recusa receber; pedir autorização de reentrega (pedido da operação BHZ por Marina Duarte)");
    expect(caixa).toHaveTextContent("Texto da 49");
    expect(screen.getByTestId("destino-espelho")).toHaveTextContent("Destino: ESPELHO do Relacionamento (não chega ao Cockpit real)");
    expect(encaminhar).not.toHaveBeenCalled();
    const token = ((await previa.mock.results[0]!.value) as { confirmacao: string }).confirmacao;
    fireEvent.click(screen.getByRole("button", { name: "Confirmar e enviar ao espelho" }));
    await waitFor(() => expect(encaminhar).toHaveBeenCalledWith("demo-item-10", "Cliente recusa receber; pedir autorização de reentrega", token));
    await waitFor(() => expect(screen.queryByTestId("cartao-demo-item-10")).not.toBeInTheDocument());
    expect(aceitar).not.toHaveBeenCalled(); // aceitar sugestão não serve para encaminhar
    expect(await screen.findByText(/24 notas/)).toBeInTheDocument();
  });

  it("depois de encaminhar, o detalhe mostra só o evento (saiu da fila)", async () => {
    const api = demo();
    montar(api, "/operacao/demo-item-10");
    await screen.findByTestId("sugestao-detalhe");
    fireEvent.click(screen.getByRole("button", { name: "Encaminhar ao Relacionamento" }));
    await screen.findByTestId("previa-encaminhamento");
    fireEvent.click(screen.getByRole("button", { name: /Confirmar e (encaminhar|enviar ao espelho)/ }));
    // Modo padrão (mig 438) = ESPELHO: nada chega ao Relacionamento real.
    expect(await screen.findByTestId("item-encerrado")).toHaveTextContent("Encaminhada ao espelho do Relacionamento");
    expect(screen.getByTestId("item-encerrado")).toHaveTextContent("Não chegou ao Cockpit real");
    expect(screen.getAllByText("Encaminhada ao espelho do Relacionamento").length).toBeGreaterThan(0);
    expect(screen.queryByText("Lançar ocorrência no SSW")).not.toBeInTheDocument();
  });

  it("encaminhamento manual pelo detalhe, com o texto da pessoa", async () => {
    const api = demo();
    const encaminhar = vi.spyOn(api, "encaminhar");
    montar(api, "/operacao/demo-item-01");
    await screen.findByTestId("detalhe-item-operacao");
    fireEvent.change(screen.getByLabelText("Motivo do encaminhamento"), { target: { value: "Cliente pede contato do comercial" } });
    fireEvent.click(screen.getByRole("button", { name: /Ver prévia do encaminhamento/ }));
    expect(await screen.findByTestId("previa-encaminhamento")).toHaveTextContent("Cliente pede contato do comercial (pedido da operação VGA");
    fireEvent.click(screen.getByRole("button", { name: /Confirmar e (encaminhar|enviar ao espelho)/ }));
    await waitFor(() => expect(encaminhar).toHaveBeenCalledWith("demo-item-01", "Cliente pede contato do comercial", expect.any(String)));
  });

  it("encaminhamento automático agendado: aparece com 'desfazer' e desfazer mantém a nota na fila", async () => {
    const api = demo();
    const desfazer = vi.spyOn(api, "desfazerEncaminhamento");
    montar(api);
    await screen.findByText(/25 notas/);
    const cartao = screen.getByTestId("cartao-demo-item-24");
    expect(within(cartao).getByTestId("encaminhamento-agendado")).toHaveTextContent("Encaminhamento agendado");
    expect(within(cartao).queryByRole("button", { name: /Encaminhar ao Relacionamento a NF/ })).not.toBeInTheDocument();
    fireEvent.click(within(cartao).getByRole("button", { name: "Desfazer" }));
    await waitFor(() => expect(desfazer).toHaveBeenCalledWith("demo-enc-demo-item-24"));
    await waitFor(() => expect(within(screen.getByTestId("cartao-demo-item-24")).queryByTestId("encaminhamento-agendado")).not.toBeInTheDocument());
  });

  it("encaminhar desligado vira mensagem humana e nada sai", async () => {
    montar(demo({ encaminharLigado: false, modoEncaminhar: "real" }), "/operacao/demo-item-10");
    await screen.findByTestId("sugestao-detalhe");
    fireEvent.click(screen.getByRole("button", { name: "Encaminhar ao Relacionamento" }));
    expect(await screen.findByText(/encaminhamento ao Relacionamento está desligado/)).toBeInTheDocument();
    expect(screen.queryByTestId("previa-encaminhamento")).not.toBeInTheDocument();
  });
});

describe("modo real × espelho (D12)", () => {
  it("modo real: sem aviso de espelho, status 'enviado'", async () => {
    const api = demo({ modoEncaminhar: "real" });
    const encaminhar = vi.spyOn(api, "encaminhar");
    montar(api, "/operacao/demo-item-10");
    await screen.findByTestId("sugestao-detalhe");
    fireEvent.click(screen.getByRole("button", { name: "Encaminhar ao Relacionamento" }));
    await screen.findByTestId("previa-encaminhamento");
    expect(screen.queryByTestId("destino-espelho")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirmar e encaminhar" }));
    await waitFor(() => expect(encaminhar).toHaveBeenCalled());
    expect(await encaminhar.mock.results[0]!.value).toMatchObject({ ok: true, status: "enviado" });
  });
});

describe("Espelho do Relacionamento (/operacao/espelho)", () => {
  function montarEspelho(api: OpApi) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <OpApiProvider api={api}>
          <MemoryRouter initialEntries={["/operacao/espelho"]}>
            <Routes>
              <Route path="/operacao" element={<Operacao />} />
              <Route path="/operacao/espelho" element={<EspelhoRelacionamento />} />
              <Route path="/operacao/:itemId" element={<Operacao />} />
            </Routes>
          </MemoryRouter>
        </OpApiProvider>
      </QueryClientProvider>,
    );
  }

  it("lista com CTRC, NF, texto da 49, origem; contadores e % que teria aceitado", async () => {
    montarEspelho(demo());
    const c1 = await screen.findByTestId("espelho-demo-esp-hist-1");
    expect(c1).toHaveTextContent("BHZ401911-1");
    expect(c1).toHaveTextContent("pedido da operação BHZ");
    expect(c1).toHaveTextContent("automático · agente de IA · 91%");
    expect(screen.getByText("Encaminhadas").parentElement).toHaveTextContent("3");
    expect(screen.getByText("Avaliadas").parentElement).toHaveTextContent("2");
    expect(screen.getByText("Teria aceitado", { selector: "div" }).parentElement).toHaveTextContent("50%");
  });

  it("teria recusado exige motivo ≥ 5; teria aceitado grava direto", async () => {
    const api = demo();
    const avaliar = vi.spyOn(api, "espelhoAvaliar");
    montarEspelho(api);
    const c1 = await screen.findByTestId("espelho-demo-esp-hist-1");
    fireEvent.click(within(c1).getByRole("button", { name: /Teria recusado/ }));
    fireEvent.change(within(c1).getByLabelText(/Por que o Relacionamento teria recusado/), { target: { value: "não" } });
    fireEvent.click(within(c1).getByRole("button", { name: "Confirmar recusa" }));
    expect(await within(c1).findByRole("alert")).toHaveTextContent("pelo menos 5 caracteres");
    expect(avaliar).not.toHaveBeenCalled();
    fireEvent.change(within(c1).getByLabelText(/Por que o Relacionamento teria recusado/), { target: { value: "A Operação resolve sozinha" } });
    fireEvent.click(within(c1).getByRole("button", { name: "Confirmar recusa" }));
    await waitFor(() => expect(avaliar).toHaveBeenCalledWith("demo-esp-hist-1", false, "A Operação resolve sozinha"));
    await waitFor(() => expect(screen.getByText("Avaliadas").parentElement).toHaveTextContent("3"));
  });

  it("filtro por avaliação", async () => {
    montarEspelho(demo());
    await screen.findByTestId("espelho-demo-esp-hist-1");
    fireEvent.change(screen.getByLabelText("Filtrar por avaliação"), { target: { value: "recusaria" } });
    expect(screen.getByTestId("contagem-espelho")).toHaveTextContent("1 de 3");
    expect(screen.getByTestId("espelho-demo-esp-hist-3")).toBeInTheDocument();
  });

  it("encaminhar na fila faz o item aparecer no espelho", async () => {
    const api = demo();
    const p = await api.previaEncaminhamento("demo-item-10", "");
    await api.encaminhar("demo-item-10", "", (p as { confirmacao: string }).confirmacao);
    montarEspelho(api);
    expect(await screen.findByText(/Cliente recusa receber; pedir autorização de reentrega \(pedido da operação BHZ por Marina Duarte\)/)).toBeInTheDocument();
  });

  it("operador da Operação (não supervisor) não vê o espelho", async () => {
    const api = demo({
      membro: { id: "m", nome: "Ana", email: null, papel_op: "operador_op", unidades: ["VGA"], pode_lancar: true },
    });
    montarEspelho(api);
    expect(await screen.findByText(/só do gestor e da supervisão/)).toBeInTheDocument();
    expect(screen.queryByTestId(/^espelho-/)).not.toBeInTheDocument();
  });

  it("o link para o espelho aparece para a supervisão na fila", async () => {
    montar(demo());
    expect(await screen.findByRole("link", { name: /Espelho do Relacionamento/ })).toHaveAttribute("href", "/operacao/espelho");
  });
});

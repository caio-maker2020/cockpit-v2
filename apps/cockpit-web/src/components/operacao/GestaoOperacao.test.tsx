import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OpFilaLinha } from "@/lib/operacao/tipos";
import { GestaoOperacao } from "./GestaoOperacao";

// Quinta, 08/10/2026, 12h em São Paulo. Próximo dia útil: sexta 09/10.
const AGORA = Date.parse("2026-10-08T15:00:00Z");
let seq = 0;
function linha(p: Partial<OpFilaLinha> = {}): OpFilaLinha {
  seq++;
  return {
    op_item_id: `g${seq}`, ctrc: `C${seq}`, nf: `${seq}`, unidade: "VGA", status: "aberto",
    cod_ultima_ocorrencia: 36, descricao_oc: "CHEGADA NA BASE", data_ultima_ocorrencia: "2026-10-06",
    instrucao_ultima_ocorrencia: null, pagador: "PAGADOR", destinatario: null, cidade_destino: "VARGINHA", uf_destino: "MG",
    previsao_entrega: "2026-10-01", atraso_original: null, qtd_volumes: 1, tipo_cte: "NORMAL", assumido_por: null, assumido_por_nome: null,
    assumido_em: null, sugestao: null, sugestao_em: null, lancamento_id: null, lancamento_status: null,
    lancamento_codigo_oc: null, lancamento_solicitado_por_nome: null, lancamento_solicitado_em: null,
    materializado_em: "2026-10-08T14:50:00Z", updated_at: "2026-10-08T14:50:00Z", ...p,
  };
}

function montar(ls: OpFilaLinha[], onAbrir = vi.fn()) {
  render(<GestaoOperacao linhas={ls} agoraMs={AGORA} papel="Gerente" setor={null} onAbrirNota={onAbrir} demo={false} />);
  return onAbrir;
}

afterEach(() => vi.restoreAllMocks());

describe("GestaoOperacao: exportar carga parada", () => {
  it("pede confirmação com o resumo e só baixa se a pessoa confirmar", () => {
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    const clique = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const confirmar = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    montar([linha(), linha({ unidade: "AJF", tipo_cte: "DEVOLUCAO", cod_ultima_ocorrencia: 2 })]);

    const botao = screen.getByRole("button", { name: "Baixar carga parada (CSV)" });
    fireEvent.click(botao);
    expect(confirmar.mock.calls[0]![0]).toContain("2 notas em 2 bases (pré-entrega: 1, devolução/reversa: 1)");
    expect(clique).not.toHaveBeenCalled();
    fireEvent.click(botao);
    expect(clique).toHaveBeenCalledTimes(1);
  });

  it("sem nota para cobrar, avisa e não pergunta", () => {
    const confirmar = vi.spyOn(window, "confirm");
    montar([linha({ previsao_entrega: "2026-10-30" })]);
    fireEvent.click(screen.getByRole("button", { name: "Baixar carga parada (CSV)" }));
    expect(confirmar).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Nenhuma nota para cobrar agora");
  });
});

describe("GestaoOperacao: detalhes recolhidos", () => {
  it("'Comece por aqui' vem primeiro; pré-entrega, regional e o aviso de histórico só ao abrir", () => {
    const onAbrir = montar([
      linha({ data_ultima_ocorrencia: "2026-09-25", previsao_entrega: "2026-10-09" }),
      linha({ unidade: "AJF", previsao_entrega: "2026-10-20" }),
    ]);
    expect(screen.getByRole("heading", { name: "Comece por aqui" })).toBeInTheDocument();
    expect(screen.getByText(/1 pré-entrega obrigatória até 09\/10/)).toBeInTheDocument();
    expect(screen.queryByText("Pré-entrega obrigatórias")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Ver mais detalhes/ }));
    expect(screen.getByText("Pré-entrega obrigatórias")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Abrir a nota mais urgente de VARGINHA" }));
    expect(onAbrir).toHaveBeenCalled();

    expect(screen.getByRole("heading", { name: "Bruno" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Daiene" })).toBeInTheDocument();
    expect(screen.getByText(/Histórico não disponível no Cockpit — depende de acesso de leitura ao Pendências/)).toBeInTheDocument();
  });
});

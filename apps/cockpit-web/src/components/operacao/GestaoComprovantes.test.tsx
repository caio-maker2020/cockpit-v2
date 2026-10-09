import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { OpFilaLinha } from "@/lib/operacao/tipos";
import { GestaoOperacao } from "./GestaoOperacao";

const AGORA = Date.parse("2026-10-08T15:00:00Z");
let seq = 0;
function linha(p: Partial<OpFilaLinha> = {}): OpFilaLinha {
  seq++;
  return {
    op_item_id: `i${seq}`, ctrc: `C${seq}`, nf: `${seq}`, unidade: "VGA", status: "aberto",
    cod_ultima_ocorrencia: 41, descricao_oc: "INFORMACAO COMPLEMENTAR", data_ultima_ocorrencia: "2026-09-25",
    instrucao_ultima_ocorrencia: null, pagador: "PAGADOR", destinatario: null, cidade_destino: "VARGINHA", uf_destino: "MG",
    previsao_entrega: "2026-09-20", atraso_original: null, qtd_volumes: 1, tipo_cte: null, assumido_por: null, assumido_por_nome: null,
    assumido_em: null, sugestao: null, sugestao_em: null, lancamento_id: null, lancamento_status: null,
    lancamento_codigo_oc: null, lancamento_solicitado_por_nome: null, lancamento_solicitado_em: null,
    materializado_em: "2026-10-08T14:50:00Z", updated_at: "2026-10-08T14:50:00Z", ...p,
  };
}

describe("GestaoOperacao", () => {
  it("mostra o gargalo e abre a nota mais antiga", () => {
    const onAbrir = vi.fn();
    const ls = [linha({ data_ultima_ocorrencia: "2026-09-20" }), linha(), linha({ unidade: "BHZ", cod_ultima_ocorrencia: 36, data_ultima_ocorrencia: "2026-10-06" })];
    render(<GestaoOperacao linhas={ls} agoraMs={AGORA} papel="Gerente" setor={null} onAbrirNota={onAbrir} demo />);
    expect(screen.getByText("Onde a operação está travando")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Abrir a nota mais antiga de VGA" }));
    expect(onAbrir).toHaveBeenCalledWith(ls[0]!.op_item_id);
    expect(screen.getByRole("button", { name: "Baixar carga parada (CSV)" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Você confirma/ })).toBeInTheDocument();
  });
});

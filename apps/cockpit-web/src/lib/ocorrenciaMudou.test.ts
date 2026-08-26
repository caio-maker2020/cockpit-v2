// Guard INV-104 (Caio 26/08, NF 26033): mudança de oc no SSW GRITA pro
// operador — detector compara histórico fresco × oc do card; dado ausente
// nunca gera alarme falso.
import { describe, expect, it } from "vitest";
import {
  detectarOcorrenciaMudou,
  tsDoHistorico,
  ultimaOcorrenciaDoHistorico,
} from "./ocorrenciaMudou";
import type { HistoricoSswOcorrencia } from "./types";

const h = (codigo: number | null, data: string, descricao = ""): HistoricoSswOcorrencia => ({
  codigo, descricao, instrucao: "", data, filial: null, usuario: null, tem_foto: false,
});

// réplica do caso real NF 26033 (26/08): card dizia 54; SSW já tinha 14→13→21
const HISTORICO_26033 = [
  h(21, "26/08/26 12:13", "REENTREGA SOLICITADA PELO CLIENTE"),
  h(13, "26/08/26 12:00", "ENTREGA IMPOSSIBILITADA: LIMITACAO CLIENTE"),
  h(13, "26/08/26 11:54", "ENTREGA IMPOSSIBILITADA: LIMITACAO CLIENTE"),
  h(54, "25/08/26 15:36", "AGUARDANDO RETORNO DO CLIENTE PAGADOR"),
  h(null, "25/08/26 10:00", "SEM CODIGO"),
];

describe("detector OCORRÊNCIA MUDOU (caso âncora NF 26033)", () => {
  it("parse da data do histórico DD/MM/YY HH:MI ordena certo", () => {
    expect(tsDoHistorico("26/08/26 12:13")).toBeGreaterThan(tsDoHistorico("25/08/26 15:36"));
    expect(tsDoHistorico("lixo")).toBe(0);
  });

  it("última oc real ignora entradas sem código e escolhe pela DATA (não pela posição)", () => {
    const bagunçado = [...HISTORICO_26033].reverse();
    expect(ultimaOcorrenciaDoHistorico(bagunçado)!.codigo).toBe(21);
  });

  it("NF 26033: card diz 54, SSW já está em 21 → ALERTA com descrição e data", () => {
    const alerta = detectarOcorrenciaMudou({ cod_ultima_ocorrencia: 54, historico_ssw: HISTORICO_26033 });
    expect(alerta).toEqual({
      ocCard: 54,
      ocSsw: 21,
      descricaoSsw: "REENTREGA SOLICITADA PELO CLIENTE",
      dataSsw: "26/08/26 12:13",
    });
  });

  it("card em dia (oc do card = última do SSW) → sem alerta", () => {
    expect(detectarOcorrenciaMudou({ cod_ultima_ocorrencia: 21, historico_ssw: HISTORICO_26033 })).toBeNull();
  });

  it("dado ausente NUNCA vira alarme falso", () => {
    expect(detectarOcorrenciaMudou({ cod_ultima_ocorrencia: 54, historico_ssw: null })).toBeNull();
    expect(detectarOcorrenciaMudou({ cod_ultima_ocorrencia: null, historico_ssw: HISTORICO_26033 })).toBeNull();
    expect(detectarOcorrenciaMudou({ cod_ultima_ocorrencia: 54, historico_ssw: [h(null, "26/08/26 10:00")] })).toBeNull();
  });
});

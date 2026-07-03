import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import type { HistoricoSswOcorrencia } from "@/lib/types";

type SetorResp =
  | "Relacionamento"
  | "Cliente"
  | "Operação"
  | "Devolução"
  | "Perdas"
  | "Ressarcimento"
  | "Agendamento";

interface OcDicionario {
  codigo: number;
  descricao: string;
  responsabilidade: SetorResp;
}

const ORDEM_SETOR: SetorResp[] = [
  "Relacionamento",
  "Cliente",
  "Operação",
  "Devolução",
  "Perdas",
  "Ressarcimento",
  "Agendamento",
];

type OcCorretaSelecionada =
  | { tipo: "mesma"; codigo: number }
  | { tipo: "diferente"; codigo: number };

type Props = {
  cardId: string;
  ocorrencia: HistoricoSswOcorrencia;
  onClose: () => void;
};

export function ModalReportarErroLancamento({ cardId, ocorrencia, onClose }: Props) {
  const ocReportada = ocorrencia.codigo ?? null;
  const [ocsCatalogo, setOcsCatalogo] = useState<OcDicionario[]>([]);
  const [ocCorretaSelecionada, setOcCorretaSelecionada] =
    useState<OcCorretaSelecionada | null>(null);
  const [motivo, setMotivo] = useState("");
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    if (!supabase) return;
    supabase
      .from("ocorrencias_dicionario")
      .select("codigo, descricao, responsabilidade")
      .order("codigo")
      .then(({ data }) => setOcsCatalogo((data ?? []) as OcDicionario[]));
  }, []);

  const gruposPorSetor = useMemo(
    () =>
      ORDEM_SETOR.map((setor) => ({
        setor,
        ocs: ocsCatalogo
          .filter((o) => o.responsabilidade === setor && o.codigo !== ocReportada)
          .sort((a, b) => a.codigo - b.codigo),
      })).filter((g) => g.ocs.length > 0),
    [ocsCatalogo, ocReportada],
  );

  const isEvidenciaIncompleta = ocCorretaSelecionada?.tipo === "mesma";
  const motivoMin = isEvidenciaIncompleta ? 10 : 0;
  const motivoTrim = motivo.trim();
  const motivoValido = motivoTrim.length >= motivoMin;
  const podeSubmeter = ocCorretaSelecionada !== null && motivoValido && !enviando;

  async function submit() {
    if (!supabase || !ocCorretaSelecionada) return;
    setEnviando(true);
    const { error } = await supabase.rpc("reportar_erro_lancamento", {
      p_card_id: cardId,
      p_codigo_oc_errada: ocorrencia.codigo,
      p_codigo_oc_correta: ocCorretaSelecionada.codigo,
      p_descricao_oc_errada: ocorrencia.descricao,
      p_data_oc_errada: ocorrencia.data,
      p_base_responsavel: ocorrencia.filial,
      p_usuario_responsavel: ocorrencia.usuario,
      p_motivo: motivoTrim || null,
      p_motivo_categoria: isEvidenciaIncompleta ? "EVIDENCIA_INCOMPLETA" : "OC_DIFERENTE",
    });
    setEnviando(false);
    if (error) {
      toast.error("Não foi possível reportar: " + error.message);
      return;
    }
    toast.success(
      `${isEvidenciaIncompleta ? "Erro de evidência" : "Erro de OC"} reportado. Acompanhe na aba INDICADORES.`,
    );
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/70 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg border-2 border-ink bg-paper p-5 shadow-flat-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-display text-[16px] font-semibold text-ink">
            Reportar erro de lançamento de ocorrência
          </h2>
          <button
            onClick={onClose}
            className="font-mono text-sm text-ink-soft hover:text-ink"
          >
            ✕
          </button>
        </div>

        <div className="mb-4 border border-rule-strong bg-paper-deep/40 p-3 font-mono text-[11px] text-ink">
          <div className="mb-1 text-[9px] uppercase tracking-widest text-ink-soft">
            Ocorrência reportada
          </div>
          <div>
            <span className="text-ink-soft">Código:</span>{" "}
            <strong>{ocorrencia.codigo}</strong> — {ocorrencia.descricao}
          </div>
          <div>
            <span className="text-ink-soft">Data:</span> {ocorrencia.data}
          </div>
          {ocorrencia.filial && (
            <div>
              <span className="text-ink-soft">Base:</span> {ocorrencia.filial}
            </div>
          )}
          {ocorrencia.usuario && (
            <div>
              <span className="text-ink-soft">Usuário SSW:</span> {ocorrencia.usuario}
            </div>
          )}
          {ocorrencia.instrucao && (
            <div className="mt-1 italic text-ink-soft">"{ocorrencia.instrucao}"</div>
          )}
        </div>

        <label className="mb-3 block">
          <span className="mb-1 block font-mono text-[10px] uppercase tracking-widest text-ink-soft">
            Qual era a ocorrência correta? *
          </span>
          <select
            value={
              ocCorretaSelecionada == null
                ? ""
                : ocCorretaSelecionada.tipo === "mesma"
                  ? "mesma"
                  : String(ocCorretaSelecionada.codigo)
            }
            onChange={(e) => {
              const v = e.target.value;
              if (!v) {
                setOcCorretaSelecionada(null);
                return;
              }
              if (v === "mesma") {
                if (ocReportada != null) {
                  setOcCorretaSelecionada({ tipo: "mesma", codigo: ocReportada });
                }
              } else {
                setOcCorretaSelecionada({ tipo: "diferente", codigo: Number(v) });
              }
            }}
            className={
              "w-full border-2 border-ink bg-paper px-2 py-1.5 font-mono text-[12px] " +
              (isEvidenciaIncompleta ? "bg-amber-50 text-amber-900" : "")
            }
          >
            <option value="">Selecione...</option>
            {ocReportada != null && (
              <option value="mesma">
                ⭐ A MESMA (oc={ocReportada} está correta, problema é na evidência)
              </option>
            )}
            {gruposPorSetor.map((g) => (
              <optgroup key={g.setor} label={g.setor}>
                {g.ocs.map((o) => (
                  <option key={o.codigo} value={o.codigo}>
                    {o.codigo} — {o.descricao}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        {isEvidenciaIncompleta ? (
          <div className="mb-4 border-2 border-amber-400 bg-amber-50/60 p-3">
            <div className="mb-2 inline-flex items-center gap-1.5 border border-amber-500 bg-amber-100 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-widest text-amber-900">
              ⚠️ Motivo: EVIDÊNCIA INCOMPLETA OU INDEVIDA
            </div>
            <label className="block">
              <span className="mb-1 block font-mono text-[10px] uppercase tracking-widest text-ink-soft">
                O que exatamente foi o erro? *
              </span>
              <textarea
                value={motivo}
                onChange={(e) => setMotivo(e.target.value.slice(0, 500))}
                placeholder="Ex: foto está desfocada e não dá pra ler a assinatura / NF errada visível / foto é de outro pedido..."
                rows={4}
                className="w-full border-2 border-ink bg-paper px-2 py-1.5 font-display text-[13px]"
              />
              <div
                className={
                  "mt-0.5 text-right font-mono text-[9px] " +
                  (motivoTrim.length >= 10 ? "text-ink-soft" : "text-red-600 font-bold")
                }
              >
                {motivoTrim.length} / 10 (mínimo)
              </div>
            </label>
          </div>
        ) : (
          <label className="mb-4 block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-widest text-ink-soft">
              Motivo (opcional)
            </span>
            <textarea
              value={motivo}
              onChange={(e) => setMotivo(e.target.value.slice(0, 300))}
              placeholder="Ex: era falta de volume, não recusa parcial"
              rows={3}
              className="w-full border-2 border-ink bg-paper px-2 py-1.5 font-display text-[13px]"
            />
            <div className="mt-0.5 text-right font-mono text-[9px] text-ink-soft">
              {motivo.length}/300
            </div>
          </label>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={enviando}
            className="border-2 border-ink bg-paper px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-widest text-ink hover:bg-paper-deep disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            onClick={submit}
            disabled={!podeSubmeter}
            className="border-2 border-ink bg-sal px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-widest text-paper hover:bg-sal-deep disabled:opacity-50"
          >
            {enviando ? "Enviando..." : "Reportar erro"}
          </button>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// FormularioFeedbackOc49 — modal OBRIGATÓRIO (Caio 27/08): o agente não
// reconheceu esta 49; o operador descreve o caso ANTES de executar. As 4
// perguntas foram validadas pelo Caio; a CORREÇÃO não é perguntada — é a
// própria ação que o operador aprovar em seguida (padrão do formulário de
// veto). Singleton montado no AppLayout; aberto pelo wrapper
// lib/aprovarComFeedback.ts via useFeedbackOc49Store.
// =============================================================================
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { useFeedbackOc49Store } from "@/stores/useFeedbackOc49Store";

const CATEGORIAS: Array<{ v: string; rotulo: string }> = [
  { v: "cobranca_retorno", rotulo: "Cobrança de retorno (ninguém respondeu o caso)" },
  { v: "pendencia_docs_indenizacao", rotulo: "Pendência de documentos da indenização" },
  { v: "instrucao_operacional", rotulo: "Instrução operacional (reagendar, endereço, etc.)" },
  { v: "devolucao_retorno", rotulo: "Devolução / retorno de carga" },
  { v: "oc_lancada_errada", rotulo: "A 49 foi lançada errada (não é caso de relacionamento)" },
  { v: "outro", rotulo: "Outro" },
];

const FONTES: Array<{ v: string; rotulo: string }> = [
  { v: "texto_da_49", rotulo: "No próprio texto da 49" },
  { v: "historico_ocorrencias", rotulo: "No histórico de ocorrências" },
  { v: "email_cliente", rotulo: "No e-mail do cliente" },
  { v: "fora_do_cockpit", rotulo: "Fora do Cockpit (WhatsApp/telefone)" },
  { v: "conhecimento_cliente", rotulo: "Rotina/conhecimento do cliente (não está escrito)" },
];

export function FormularioFeedbackOc49() {
  const { pedido, fechar } = useFeedbackOc49Store();
  const [categoria, setCategoria] = useState<string>("");
  const [categoriaOutro, setCategoriaOutro] = useState("");
  const [fontes, setFontes] = useState<Set<string>>(new Set());
  const [recorrencia, setRecorrencia] = useState<string>("");
  const [frase, setFrase] = useState("");
  const [salvando, setSalvando] = useState(false);

  if (!pedido) return null;

  const valido =
    categoria !== "" &&
    (categoria !== "outro" || categoriaOutro.trim().length >= 5) &&
    recorrencia !== "" &&
    frase.trim().length >= 10;

  const limpar = () => {
    setCategoria(""); setCategoriaOutro(""); setFontes(new Set());
    setRecorrencia(""); setFrase("");
  };

  const enviar = async () => {
    if (!supabase || !valido) return;
    setSalvando(true);
    const { error } = await supabase.rpc("registrar_feedback_oc49_v2", {
      p_card_id: pedido.cardId,
      p_categoria: categoria,
      p_categoria_outro: categoria === "outro" ? categoriaOutro.trim() : null,
      p_fontes: [...fontes],
      p_recorrencia: recorrencia,
      p_frase: frase.trim(),
    } as never);
    setSalvando(false);
    if (error) {
      toast.error("Erro ao registrar", { description: error.message });
      return;
    }
    toast.success("Caso registrado — obrigado! Seguindo com a aprovação…");
    limpar();
    fechar(true);
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-rule bg-paper p-5 shadow-xl">
        <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-sal">
          Feedback obrigatório · NF {pedido.nf}
        </p>
        <h3 className="mt-1 text-[15px] font-semibold text-ink">
          O agente não reconheceu esta 49 — descreva o caso pra ele aprender
        </h3>
        <p className="mt-0.5 text-[11.5px] text-ink-soft">
          ~20 segundos. A ação que você aprovar em seguida vira a correção automaticamente.
        </p>

        <div className="mt-4 space-y-4 text-[12.5px] text-ink">
          <fieldset>
            <legend className="mb-1.5 font-semibold">1. O que a área quis dizer com esta 49?</legend>
            {CATEGORIAS.map((c) => (
              <label key={c.v} className="flex cursor-pointer items-start gap-2 py-0.5">
                <input type="radio" name="fb49-cat" checked={categoria === c.v}
                  onChange={() => setCategoria(c.v)} className="mt-0.5" />
                <span>{c.rotulo}</span>
              </label>
            ))}
            {categoria === "outro" && (
              <input value={categoriaOutro} onChange={(e) => setCategoriaOutro(e.target.value)}
                placeholder="Descreva (mín. 5 caracteres)"
                className="mt-1 w-full rounded border border-rule bg-paper px-2 py-1.5 text-[12.5px]" />
            )}
          </fieldset>

          <fieldset>
            <legend className="mb-1.5 font-semibold">2. Onde está a informação que faltou pro agente? <span className="font-normal text-ink-mute">(pode marcar várias)</span></legend>
            {FONTES.map((f) => (
              <label key={f.v} className="flex cursor-pointer items-start gap-2 py-0.5">
                <input type="checkbox" checked={fontes.has(f.v)} className="mt-0.5"
                  onChange={(e) => {
                    const n = new Set(fontes);
                    if (e.target.checked) n.add(f.v); else n.delete(f.v);
                    setFontes(n);
                  }} />
                <span>{f.rotulo}</span>
              </label>
            ))}
          </fieldset>

          <fieldset>
            <legend className="mb-1.5 font-semibold">3. Isso se repete?</legend>
            {[["isolado", "Caso isolado"], ["cliente", "Padrão DESTE cliente"], ["geral", "Padrão geral (vários clientes)"]].map(([v, r]) => (
              <label key={v} className="flex cursor-pointer items-start gap-2 py-0.5">
                <input type="radio" name="fb49-rec" checked={recorrencia === v}
                  onChange={() => setRecorrencia(v)} className="mt-0.5" />
                <span>{r}</span>
              </label>
            ))}
          </fieldset>

          <fieldset>
            <legend className="mb-1.5 font-semibold">4. Explique como se estivesse treinando um novato <span className="font-normal text-ink-mute">(1 frase)</span></legend>
            <textarea value={frase} onChange={(e) => setFrase(e.target.value)} rows={2}
              placeholder="Ex.: quando a indenização lança 49 pedindo docs mas a entrega já está liberada, é só relançar a 21."
              className="w-full rounded border border-rule bg-paper px-2 py-1.5 text-[12.5px]" />
            {frase.trim().length > 0 && frase.trim().length < 10 && (
              <p className="mt-0.5 text-[10.5px] text-sal">mín. 10 caracteres</p>
            )}
          </fieldset>
        </div>

        <div className="mt-5 flex items-center justify-between gap-2">
          <button type="button" onClick={() => { limpar(); fechar(false); }}
            className="rounded-md px-3 py-1.5 text-[12px] text-ink-mute hover:text-ink">
            Cancelar aprovação
          </button>
          <button type="button" disabled={!valido || salvando} onClick={enviar}
            className="rounded-md bg-ink px-4 py-1.5 text-[12.5px] font-semibold text-paper disabled:opacity-40">
            {salvando ? "Registrando…" : "Registrar e aprovar"}
          </button>
        </div>
      </div>
    </div>
  );
}

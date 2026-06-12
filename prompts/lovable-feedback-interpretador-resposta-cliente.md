# Lovable — Feedback IA na sugestão de email do cliente + indicador

**Data:** 2026-05-23
**Backend:** migration 160 (`interpretador_resposta_cliente_feedback` + 2 RPCs + view `v_interpretador_resposta_metricas`) já em produção.

---

## Parte 1 — Botões 👍 👎 no banner "Sugestão da IA" do card

### Onde

No card de detalhe, dentro do banner **lavanda "SUGESTÃO DA IA"** (o do print — "Lançar oc 56 — Falta info operacional · CONFIANÇA: MÉDIA (72%)" etc), que aparece quando `cards.ia_sugestao_oc_resposta` está populado.

### Layout proposto

```
┌─ 🤖 SUGESTÃO DA IA ──────────────────────────────────────────────────────┐
│                                                                          │
│ Lançar oc 56 — Falta info operacional                                   │
│ CONFIANÇA: MÉDIA (72%)              ┃ IA acertou?  [ 👍 acertou ]       │
│                                     ┃               [ 👎 errou   ]      │
│ "O destinatário (Drogaria Araujo)…"                                      │
│                                                                          │
│ [ APROVAR OC 56 ]   [ VER OUTRAS OPÇÕES → ]                              │
└─────────────────────────────────────────────────────────────────────────┘
```

Os botões 👍 👎 ficam **na header do banner**, alinhados à direita da pílula "CONFIANÇA". Pequenos (size sm), discretos, color secondary. Não competem com o CTA "APROVAR OC X".

### Estados visuais dos botões

- **Default:** outline cinza + texto cinza. Ambos clicáveis.
- **Após operador clicar 👍:** botão 👍 vira sólido verde + label "✓ você marcou: acertou". Botão 👎 some.
- **Após operador clicar 👎:** abre modal pedindo motivo + (opcional) qual oc seria a certa. Após salvar, 👎 vira sólido vermelho + label "✗ você marcou: errou". 👍 some.
- **Já tem feedback registrado:** mostra estado final (sólido) + link tiny "alterar →" que reabre o fluxo. Permite trocar 👍↔👎 livremente (RPC faz upsert).

### Implementação

```tsx
type SugestaoIA = {
  oc_sugerida: number;
  motivo: string;
  confianca: number;
  message_id: string;
  // ...
};

type FeedbackExistente = {
  id: string;
  tipo_feedback: "acertou_explicito" | "errou_explicito";
  motivo_correcao: string | null;
  decisao_correta_codigo_ssw: number | null;
  corrigido_em: string;
};

function BannerSugestaoIA({ card }: { card: Card }) {
  const sugestao = card.ia_sugestao_oc_resposta as SugestaoIA | null;
  const [feedback, setFeedback] = useState<FeedbackExistente | null>(null);
  const [modalErrouAberto, setModalErrouAberto] = useState(false);

  // Carrega feedback explícito existente pra esse (card, message_id)
  useEffect(() => {
    if (!sugestao) return;
    supabase
      .from("interpretador_resposta_cliente_feedback")
      .select("id, tipo_feedback, motivo_correcao, decisao_correta_codigo_ssw, corrigido_em")
      .eq("card_id", card.id)
      .eq("origem", "explicito")
      .eq("message_id", sugestao.message_id)
      .maybeSingle()
      .then(({ data }) => setFeedback(data ?? null));
  }, [card.id, sugestao?.message_id]);

  if (!sugestao) return null;

  async function marcarAcertou() {
    const { error } = await supabase.rpc("registrar_feedback_interpretador_resposta_ia", {
      p_card_id: card.id,
      p_acertou: true,
      p_decisao_correta_codigo_ssw: null,
      p_motivo_correcao: null,
    });
    if (error) {
      toast.error(`Falha ao registrar feedback: ${error.message}`);
      return;
    }
    toast.success("Obrigado! Marcado como acerto da IA.");
    // recarrega
    reload();
  }

  async function marcarErrou(payload: { motivo: string; codigo_correto: number | null }) {
    const { error } = await supabase.rpc("registrar_feedback_interpretador_resposta_ia", {
      p_card_id: card.id,
      p_acertou: false,
      p_decisao_correta_codigo_ssw: payload.codigo_correto,
      p_motivo_correcao: payload.motivo,
    });
    if (error) {
      toast.error(`Falha ao registrar feedback: ${error.message}`);
      return;
    }
    toast.success("Obrigado! Marcado como erro da IA.");
    setModalErrouAberto(false);
    reload();
  }

  return (
    <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <h3 className="text-xs font-mono uppercase tracking-wider text-indigo-700">
            🤖 Sugestão da IA
          </h3>
          <p className="mt-1 font-semibold text-ink">
            Lançar oc {sugestao.oc_sugerida} — {tituloOc(sugestao.oc_sugerida)}
          </p>
          <div className="mt-2 inline-block rounded bg-amber-100 px-2 py-0.5 font-mono text-[11px] uppercase">
            Confiança: {nivelConfianca(sugestao.confianca)} ({Math.round(sugestao.confianca * 100)}%)
          </div>
        </div>

        {/* Feedback 👍 👎 */}
        <div className="shrink-0 border-l border-indigo-200 pl-3">
          <p className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
            IA acertou?
          </p>
          {feedback?.tipo_feedback === "acertou_explicito" ? (
            <div className="mt-1">
              <span className="inline-flex items-center gap-1 rounded bg-positive text-bg px-2 py-1 text-xs font-medium">
                ✓ você marcou: acertou
              </span>
              <button
                onClick={() => setModalErrouAberto(true)}
                className="ml-2 text-[10px] text-ink-mute underline hover:text-ink"
              >
                alterar →
              </button>
            </div>
          ) : feedback?.tipo_feedback === "errou_explicito" ? (
            <div className="mt-1">
              <span className="inline-flex items-center gap-1 rounded bg-signal text-bg px-2 py-1 text-xs font-medium">
                ✗ você marcou: errou
              </span>
              <button
                onClick={marcarAcertou}
                className="ml-2 text-[10px] text-ink-mute underline hover:text-ink"
              >
                alterar →
              </button>
            </div>
          ) : (
            <div className="mt-1 flex flex-col gap-1">
              <button
                onClick={marcarAcertou}
                className="rounded border border-positive/40 px-2 py-1 text-xs font-medium text-positive hover:bg-positive hover:text-bg transition"
              >
                👍 acertou
              </button>
              <button
                onClick={() => setModalErrouAberto(true)}
                className="rounded border border-signal/40 px-2 py-1 text-xs font-medium text-signal hover:bg-signal hover:text-bg transition"
              >
                👎 errou
              </button>
            </div>
          )}
        </div>
      </div>

      <blockquote className="mt-3 border-l-2 border-indigo-300 pl-3 text-sm italic text-ink-soft">
        "{sugestao.motivo}"
      </blockquote>

      <div className="mt-4 flex gap-2">
        <button className="rounded bg-indigo-700 text-bg px-4 py-2 text-sm font-medium hover:bg-indigo-800">
          APROVAR OC {sugestao.oc_sugerida}
        </button>
        <button className="text-sm text-indigo-700 hover:underline">
          VER OUTRAS OPÇÕES →
        </button>
      </div>

      {modalErrouAberto && (
        <ModalIAErrou
          ocSugerida={sugestao.oc_sugerida}
          onClose={() => setModalErrouAberto(false)}
          onSalvar={marcarErrou}
        />
      )}
    </div>
  );
}
```

### Modal "IA errou"

```tsx
function ModalIAErrou({
  ocSugerida,
  onClose,
  onSalvar,
}: {
  ocSugerida: number;
  onClose: () => void;
  onSalvar: (p: { motivo: string; codigo_correto: number | null }) => void;
}) {
  const [motivo, setMotivo] = useState("");
  const [codigoCorreto, setCodigoCorreto] = useState<number | null>(null);
  const valido = motivo.trim().length >= 10;

  return (
    <Modal open onClose={onClose}>
      <h2 className="font-display font-semibold text-h6">IA errou — me ajude a melhorar</h2>
      <p className="text-sm text-ink-soft mt-1">
        IA sugeriu <strong>oc {ocSugerida}</strong>. Por que está errado?
      </p>

      <label className="block mt-4 text-xs font-mono uppercase tracking-wider text-ink-mute">
        Qual oc seria a correta? <span className="text-ink-mute">(opcional)</span>
      </label>
      <select
        value={codigoCorreto ?? ""}
        onChange={(e) => setCodigoCorreto(e.target.value ? Number(e.target.value) : null)}
        className="mt-1 w-full border border-border rounded px-3 py-2 text-sm"
      >
        <option value="">— não sei / não se aplica —</option>
        <option value="54">54 — Notificou cliente</option>
        <option value="56">56 — Falta info operacional</option>
        <option value="21">21 — Reentrega solicitada</option>
        <option value="33">33 — Devolução autorizada</option>
        <option value="44">44 — Ressarcimento</option>
        <option value="49">49 — Falta romaneio</option>
      </select>

      <label className="block mt-4 text-xs font-mono uppercase tracking-wider text-ink-mute">
        Motivo (obrigatório, mínimo 10 caracteres)
      </label>
      <textarea
        value={motivo}
        onChange={(e) => setMotivo(e.target.value)}
        rows={3}
        placeholder="Ex.: cliente autorizou devolução claramente, IA não entendeu"
        className="mt-1 w-full border border-border rounded px-3 py-2 text-sm font-display"
      />

      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose} className="px-3 py-2 text-sm text-ink-mute">Cancelar</button>
        <button
          onClick={() => onSalvar({ motivo, codigo_correto: codigoCorreto })}
          disabled={!valido}
          className="rounded bg-signal text-bg px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          Salvar feedback
        </button>
      </div>
    </Modal>
  );
}
```

---

## Parte 2 — Card "🎯 Acerto Agente IA — Interpretação de Email" na aba INDICADORES

### Backend

View `public.v_interpretador_resposta_metricas` (mig 160). Schema:

```ts
type MetricaInterpRow = {
  dia: string;                           // YYYY-MM-DD (BRT)
  oc_sugerida: number;                   // 54 | 56 | 21 | 33 | ...
  operador: string | null;
  total_sugestoes: number;
  acertos_total: number;                 // acertos explícitos + implícitos
  erros_total: number;                   // erros explícitos + implícitos
  acertos_explicitos: number;            // operador clicou 👍
  acertos_implicitos: number;            // executor: aprovou == sugerido
  erros_explicitos: number;              // operador clicou 👎
  erros_implicitos: number;              // executor: aprovou != sugerido
  sem_feedback: number;                  // ainda não decidido
  pct_acerto_ia: number | null;          // acertos / (acertos + erros) × 100
};
```

### Layout do card

```
┌─ 🎯 Acerto Agente IA — Interpretação de Email ─────────────────────────────┐
│                                                                            │
│ Período: [ 7d | 30d | Tudo ]    Operador: [ Todos ▾ ]                     │
│                                                                            │
│ ┌──────────────┐  ┌────────────────┐  ┌────────────────┐  ┌─────────────┐ │
│ │  % ACERTO    │  │   Acertos      │  │   Erros        │  │  Sem decisão│ │
│ │              │  │                │  │                │  │             │ │
│ │     78.3%    │  │  18  (👍 5)    │  │   5 (👎 2)    │  │     12      │ │
│ │              │  │  implícitos:13 │  │  implícitos: 3 │  │  pendentes  │ │
│ └──────────────┘  └────────────────┘  └────────────────┘  └─────────────┘ │
│                                                                            │
│ Por oc sugerida (top 5):                                                  │
│   oc=54 (Notificar)        12 sug → 11 acerto / 1 erro    91.7% ████████  │
│   oc=56 (Falta info)        8 sug →  6 acerto / 2 erro    75.0% ███████░  │
│   oc=33 (Devolução)         5 sug →  4 acerto / 1 erro    80.0% ████████  │
│   oc=21 (Reentrega)         3 sug →  3 acerto / 0 erro   100.0% ██████████│
│                                                                            │
│ Últimos erros marcados (com motivo) — top 5:                              │
│ • "cliente claramente autorizou devolução, IA sugeriu 54 follow-up"      │
│   (Larissa, oc sugerida 54 → correta 33, 2026-05-22)                     │
│ • "destinatário não é o pagador, resposta não vale como decisão"        │
│   (Duilio, oc sugerida 56 → correta 54, 2026-05-21)                      │
│                                                                            │
│ Tabela detalhada (colapsável):                                            │
│ Dia        OC sug  Operador  Total  Acerto  Erro  Pendente  % Acerto    │
│ 2026-05-23  54     larissa     3      2       0      1       100%        │
│ ...                                                                       │
└───────────────────────────────────────────────────────────────────────────┘
```

### Cálculos

```ts
const totalSugestoes = rows.reduce((s, r) => s + r.total_sugestoes, 0);
const acertos = rows.reduce((s, r) => s + r.acertos_total, 0);
const erros = rows.reduce((s, r) => s + r.erros_total, 0);
const semFeedback = rows.reduce((s, r) => s + r.sem_feedback, 0);

const acertosExpl = rows.reduce((s, r) => s + r.acertos_explicitos, 0);
const acertosImpl = rows.reduce((s, r) => s + r.acertos_implicitos, 0);
const errosExpl = rows.reduce((s, r) => s + r.erros_explicitos, 0);
const errosImpl = rows.reduce((s, r) => s + r.erros_implicitos, 0);

const pctAcerto = (acertos + erros) > 0
  ? Math.round(1000 * acertos / (acertos + erros)) / 10
  : null;

// Grupo por oc sugerida
const porOc = new Map<number, { sug: number; acerto: number; erro: number }>();
for (const r of rows) {
  if (!porOc.has(r.oc_sugerida)) porOc.set(r.oc_sugerida, { sug: 0, acerto: 0, erro: 0 });
  const acc = porOc.get(r.oc_sugerida)!;
  acc.sug += r.total_sugestoes;
  acc.acerto += r.acertos_total;
  acc.erro += r.erros_total;
}
```

### Top erros marcados (motivos)

Query separada na tabela `interpretador_resposta_cliente_feedback`:

```ts
const { data: erros } = await supabase
  .from("interpretador_resposta_cliente_feedback")
  .select(`
    id, motivo_correcao, decisao_correta_codigo_ssw, oc_sugerida_pela_ia,
    corrigido_por_nome, corrigido_em,
    card:cards (nf)
  `)
  .eq("tipo_feedback", "errou_explicito")
  .gte("corrigido_em", new Date(Date.now() - 30 * 86400_000).toISOString())
  .order("corrigido_em", { ascending: false })
  .limit(10);
```

### Filtros + agregação

- Período padrão: **7 dias**
- Filtros: `dia >= now() - 7d` (ou 30d/all), `operador = X` (ou null = Todos)
- View já tem RLS — operador só vê cards visíveis pra ele

---

## Filosofia do indicador

- **Acertos implícitos** (executor: aprovou = sugerido) são a fonte principal de sinal — operador valida com a ação dele.
- **Acertos explícitos** (👍) servem pra casos onde o operador concorda mas vai aprovar diferente (raro, mas existe — ex: sugeriu 54, operador concorda mas decide forçar 56 por outro motivo).
- **Erros implícitos** (executor: aprovou ≠ sugerido) são sinal automático de divergência.
- **Erros explícitos** (👎 + motivo) são o sinal mais valioso — vem com **texto livre** que alimenta análise de padrões pra melhorar o prompt no futuro.

## NÃO QUEBRAR

- Realtime sub em `cards` continua.
- O fluxo "APROVAR OC X" / "VER OUTRAS OPÇÕES" do banner segue intacto.
- Modal de feedback é overlay — não bloqueia outras ações do card.
- Aba INDICADORES já tem 4 cards (Erros lançamento, Tempo oc=21→14, Acerto IA oc=13, Acerto IA ocs padrão). Este é o **5º**, segue mesmo padrão visual.

---

## Resumo

| Antes | Depois |
|---|---|
| IA sugere → operador aprova/recusa, sem rastreio | 👍/👎 explícito + sinal implícito do executor |
| Sem métrica de acerto | View `v_interpretador_resposta_metricas` + card na aba INDICADORES |
| Erros se perdem na operação | `motivo_correcao` (texto livre, ≥10 chars) acumula corpus pra melhorar prompt futuro |
| Nada distingue acerto/erro | 4 buckets: acertou_explícito, acertou_implícito, errou_explícito, errou_implícito |

Tudo idempotente — operador pode trocar 👍 ↔ 👎 quantas vezes quiser. Implícito é registrado 1x e não conflita com explícito (buckets separados).

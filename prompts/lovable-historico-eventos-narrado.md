# Lovable — Histórico de eventos NARRADO no card

**Data:** 2026-05-25
**Caso âncora:** NF 648153 (DURAFA) — Caio não conseguiu entender pelo histórico atual que ela tinha aprovado oc=54+email, cliente respondeu, IA classificou como inconclusivo e ela clicou "IGNORAR PENDÊNCIAS". Eventos eram crus tipo `PendenciasRespostaIgnoradas` em JSON.

**Backend:** view `v_card_events_legivel` JÁ EXISTE (mig 166). Cada row tem:
- `id`, `card_id`, `created_at`
- `event_type` (cru — pra debug)
- `payload` (jsonb cru — pra "Ver detalhe técnico" colapsável)
- `actor_type` (`operator` | `agent` | `system`)
- `actor_id` (uuid do operador ou nome do agente)
- **`ator_nome`** — já resolvido (ex: "DURAFA", "Executor", "IA Resposta Cliente", "Sistema")
- **`categoria`** — `bastao` | `ssw` | `ia` | `operador` | `sistema`
- **`severidade`** — `info` | `sucesso` | `atencao` | `erro`
- **`narrativa`** — string PT-BR já formatada (ex: "DURAFA aprovou oc=54 + email")

---

## O que mudar no front

Substituir a aba "EVENTOS" (ou "HISTÓRICO") do card por uma nova versão que:

1. **Carrega `v_card_events_legivel`** filtrada por `card_id`, ordenada por `created_at DESC`.
2. **Renderiza cada evento como linha visual** com:
   - **Hora** (HH:MM:SS BRT)
   - **Ícone** baseado em `categoria` (ver mapping abaixo)
   - **Tag colorida** baseada em `severidade` (info=indigo, sucesso=emerald, atencao=amber, erro=rose)
   - **Ator** (`ator_nome`) em destaque
   - **Narrativa** (linha principal — texto humano)
   - **"Detalhe técnico"** como `<details>` colapsável mostrando `event_type` + `payload` JSON
3. **Filtros no topo** (chips):
   - "Todos" (default)
   - "Operador" (mostra só categoria=operador)
   - "Sistema" (mostra categoria=sistema/bastao/ssw)
   - "IA" (mostra categoria=ia)
   - "Erros" (mostra só severidade=erro/atencao)

---

## Componente: `HistoricoEventosCard.tsx`

```tsx
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";

interface EventoLegivel {
  id: string;
  card_id: string;
  event_type: string;
  payload: Record<string, unknown> | null;
  actor_type: "operator" | "agent" | "system";
  actor_id: string | null;
  created_at: string;
  ator_nome: string;
  categoria: "bastao" | "ssw" | "ia" | "operador" | "sistema";
  severidade: "info" | "sucesso" | "atencao" | "erro";
  narrativa: string;
}

const ICONE_POR_CATEGORIA: Record<EventoLegivel["categoria"], string> = {
  bastao: "🔗",      // Bastão Sal Express
  ssw: "🚛",         // Portal SSW
  ia: "✦",           // IA / Agente
  operador: "👤",    // Operador humano
  sistema: "⚙",      // Sistema interno Cockpit
};

const LABEL_FILTRO: Record<string, string> = {
  todos: "Todos",
  operador: "Operador",
  sistema: "Sistema",
  ia: "IA",
  erros: "Atenção/Erros",
};

const SEVERIDADE_CLASSE: Record<EventoLegivel["severidade"], string> = {
  info: "bg-indigo-50 border-indigo-200 text-indigo-900",
  sucesso: "bg-emerald-50 border-emerald-200 text-emerald-900",
  atencao: "bg-amber-50 border-amber-200 text-amber-900",
  erro: "bg-rose-50 border-rose-200 text-rose-900",
};

export function HistoricoEventosCard({ cardId }: { cardId: string }) {
  const [filtro, setFiltro] = useState<keyof typeof LABEL_FILTRO>("todos");

  const { data: eventos, isLoading } = useQuery({
    queryKey: ["historico-eventos", cardId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_card_events_legivel")
        .select("*")
        .eq("card_id", cardId)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as EventoLegivel[];
    },
    refetchInterval: 15_000, // polling leve — Realtime opcional
  });

  const filtrados = (eventos ?? []).filter((e) => {
    if (filtro === "todos") return true;
    if (filtro === "operador") return e.categoria === "operador";
    if (filtro === "ia") return e.categoria === "ia";
    if (filtro === "sistema") return ["sistema", "bastao", "ssw"].includes(e.categoria);
    if (filtro === "erros") return ["erro", "atencao"].includes(e.severidade);
    return true;
  });

  if (isLoading) return <p className="text-ink-mute font-mono text-caption">Carregando…</p>;

  return (
    <div className="space-y-4">
      {/* Filtros */}
      <div className="flex gap-2 flex-wrap">
        {Object.entries(LABEL_FILTRO).map(([k, lbl]) => (
          <button
            key={k}
            onClick={() => setFiltro(k as keyof typeof LABEL_FILTRO)}
            className={cn(
              "px-3 py-1 text-caption font-mono rounded border transition-colors",
              filtro === k
                ? "bg-ink text-bg border-ink"
                : "bg-bg text-ink-mute border-ink-mute/30 hover:border-ink",
            )}
          >
            {lbl}
          </button>
        ))}
      </div>

      {/* Lista de eventos */}
      {filtrados.length === 0 ? (
        <p className="text-ink-mute italic">Sem eventos nesse filtro.</p>
      ) : (
        <ol className="space-y-2">
          {filtrados.map((ev) => (
            <li
              key={ev.id}
              className={cn(
                "rounded-md border px-4 py-3",
                SEVERIDADE_CLASSE[ev.severidade],
              )}
            >
              <div className="flex items-start gap-3">
                <span className="text-xl leading-none mt-0.5" aria-hidden>
                  {ICONE_POR_CATEGORIA[ev.categoria]}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <time className="font-mono text-caption opacity-70" dateTime={ev.created_at}>
                      {new Date(ev.created_at).toLocaleString("pt-BR", {
                        timeZone: "America/Sao_Paulo",
                        day: "2-digit",
                        month: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                    </time>
                    <span className="font-mono text-caption font-medium">
                      {ev.ator_nome}
                    </span>
                  </div>
                  <p className="mt-1 text-body whitespace-pre-wrap break-words">
                    {ev.narrativa}
                  </p>
                  <details className="mt-2 text-caption">
                    <summary className="cursor-pointer opacity-60 hover:opacity-100">
                      detalhe técnico ({ev.event_type})
                    </summary>
                    <pre className="mt-2 overflow-x-auto bg-bg/50 p-2 rounded font-mono text-xs">
                      {JSON.stringify(ev.payload, null, 2)}
                    </pre>
                  </details>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
```

---

## Onde usar

Substituir o componente atual da aba "EVENTOS" / "HISTÓRICO" do card detalhe por `<HistoricoEventosCard cardId={card.id} />`.

Se o front atual ainda tem aba "HISTÓRICO SSW" separada (mostra ocorrências SSW), MANTER essa — ela é diferente (ocs do SSW), enquanto essa é o histórico do card no Cockpit.

---

## Exemplo de como vai ficar (NF 648153)

```
[Operador] [Sistema] [IA] [Atenção/Erros] [Todos] ← filtros

⚙ 25/05 20:03:11 · DURAFA
   DURAFA ignorou as pendências da IA (card voltou pra AGUARDANDO_CLIENTE)
   ▶ detalhe técnico (PendenciasRespostaIgnoradas)

✦ 25/05 20:02:12 · IA Resposta Cliente
   IA interpretou resposta do cliente: sugere oc=54 (confiança 35%) — Cliente não respondeu
   diretamente à operadora — redirecionou a pergunta para Ariadna Jessica.
   ▶ detalhe técnico (InterpretadorRespostaClienteConcluido)

⚙ 25/05 20:02:12 · Sistema
   Cliente respondeu — sistema criou 3 novas propostas (state=AGUARDANDO_VALIDACAO_HUMANA)
   ▶ detalhe técnico (RetornoClienteEmAguardo)

⚙ 25/05 20:01:58 · Sistema
   Email recebido de giovanna.andrade@isapa.com.br: "Boa tarde, @Ariadna Jessica Pereira
   Macedo por favor, verificar se podemos entregar parcialmente."
   ▶ detalhe técnico (RespostaClienteCapturada)

🚛 25/05 18:56:09 · Sistema
   SSW confirmou oc=54 lançada (state=AGUARDANDO_CLIENTE)
   ▶ detalhe técnico (AcaoExecutadaConfirmadaPeloSsw)

⚙ 25/05 18:56:03 · Executor
   Executor lançou oc=54 no SSW (sucesso — protocolo 1338260000015766)
   ▶ detalhe técnico (AcaoExecutada)

👤 25/05 18:55:06 · DURAFA
   DURAFA aprovou oc=54 + email (FALTA_DE_VOLUME)
   ▶ detalhe técnico (AprovacaoOperador)

⚙ 25/05 18:55:06 · Sistema
   6 propostas canceladas (operador escolheu uma)
   ▶ detalhe técnico (TodosConcorrentesCancelados)
```

Caio lê de cima pra baixo e entende toda a história sem decodificar JSON.

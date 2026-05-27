# Lovable — Composer da aba RESPOSTA: pré-marcar TODOS endereços da thread no CC

**Data:** 2026-05-27
**Caso âncora:** NF 647901 (DURAFA × ISAPA) — cliente Giovanna respondeu adicionando `transporte@isapa.com.br` em CC. Operador respondeu de novo pela aba RESPOSTA mas o email saiu só pra Giovanna (transporte@ ficou de fora).

**Backend:** já deployado.
- `gmail-poll-inbox` agora preserva `raw_payload.to` e `raw_payload.cc` da mensagem inbound.
- `responder-email-cliente` deriva CC dos headers To/Cc da mensagem origem quando o front NÃO passa `body.cc` explícito (operador automático).
- Se o front PASSA `body.cc`, respeita o que veio (operador pode ter desmarcado alguém).

## Mudança no front

O composer da aba RESPOSTA precisa:

1. **Buscar a mensagem origem** (`messages_inbox` por `message_id_header` ou último inbound do card)
2. **Extrair endereços** do `raw_payload.to` + `raw_payload.cc` da última mensagem inbound
3. **Mostrar checkboxes pré-marcados** com todos os endereços (exceto o que vai no TO — remetente — e o email do operador)
4. **Operador pode desmarcar** se quiser tirar alguém
5. **Enviar `cc: [...emails marcados]`** no body do request

### Implementação

```tsx
// src/hooks/useCcSugeridoDaThread.ts
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

export function useCcSugeridoDaThread(cardId: string) {
  return useQuery({
    queryKey: ["cc-sugerido-thread", cardId],
    queryFn: async () => {
      // Última mensagem inbound do card
      const { data: msg } = await supabase
        .from("messages_inbox")
        .select("remetente, raw_payload")
        .eq("card_id", cardId)
        .eq("canal", "email")
        .order("recebido_em", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!msg) return { to: null, ccSugerido: [] as string[] };

      const remetente = (msg.remetente as string)?.toLowerCase();
      const raw = (msg.raw_payload ?? {}) as Record<string, string>;
      const headers = [(raw.to ?? ""), (raw.cc ?? "")].join(", ");
      const emails = headers.match(/[\w._%+-]+@[\w.-]+\.[A-Za-z]{2,}/g) ?? [];

      // Email do operador atual pra filtrar (não copia pra si)
      const { data: op } = await supabase
        .from("operadores")
        .select("email")
        .eq("id", (await supabase.auth.getUser()).data.user?.id ?? "")
        .maybeSingle();
      const operadorEmail = ((op as { email?: string } | null)?.email ?? "").toLowerCase();

      const visto = new Set<string>();
      const ccSugerido = emails
        .map((e) => e.toLowerCase().trim())
        .filter((e) => {
          if (e === remetente || e === operadorEmail || visto.has(e)) return false;
          visto.add(e);
          return true;
        });

      return { to: remetente, ccSugerido };
    },
    enabled: !!cardId,
    staleTime: 60_000,
  });
}
```

```tsx
// No componente do composer da aba RESPOSTA
function ComposerResposta({ cardId }: { cardId: string }) {
  const { data: sugestao } = useCcSugeridoDaThread(cardId);
  const [ccSelecionados, setCcSelecionados] = useState<Set<string>>(new Set());

  // Pré-marca TODOS quando carregar
  useEffect(() => {
    if (sugestao?.ccSugerido) {
      setCcSelecionados(new Set(sugestao.ccSugerido));
    }
  }, [sugestao]);

  const toggleCc = (email: string) => {
    setCcSelecionados((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });
  };

  async function enviarResposta(texto: string, anexosIds: string[]) {
    await supabase.functions.invoke("responder-email-cliente", {
      body: {
        card_id: cardId,
        texto,
        cc: Array.from(ccSelecionados),     // explícito
        anexos_ids: anexosIds,
      },
    });
  }

  return (
    <div>
      {/* Campo TO (fixo, não editável — vai pro remetente da última msg) */}
      <div className="text-caption text-ink-mute">
        Para: <span className="font-mono">{sugestao?.to}</span>
      </div>

      {/* Checkboxes de CC */}
      {(sugestao?.ccSugerido ?? []).length > 0 && (
        <fieldset className="mt-2">
          <legend className="text-caption text-ink-mute font-mono">Em cópia (Cc):</legend>
          {sugestao!.ccSugerido.map((email) => (
            <label key={email} className="flex items-center gap-2 mt-1">
              <input
                type="checkbox"
                checked={ccSelecionados.has(email)}
                onChange={() => toggleCc(email)}
              />
              <span className="font-mono text-body">{email}</span>
            </label>
          ))}
          {/* Campo "+ Adicionar outro" — input opcional */}
          <button onClick={() => /* abrir input pra digitar email novo */} className="text-caption text-ink-mute mt-1 underline">
            + Adicionar outro email
          </button>
        </fieldset>
      )}

      <textarea value={texto} onChange={(e) => setTexto(e.target.value)} />
      <button onClick={() => enviarResposta(texto, anexosIds)}>Enviar resposta</button>
    </div>
  );
}
```

### Posição visual sugerida

```
┌─ Responder cliente ────────────────────────────────────────┐
│ Para: giovanna.andrade@isapa.com.br                        │
│                                                             │
│ Em cópia (Cc):                                              │
│  ☑ transporte@isapa.com.br                                 │
│  ☑ logistica@isapa.com.br                                  │
│  [+ Adicionar outro email]                                  │
│                                                             │
│ [Assunto: Re: Extravio Parcial — NF 647901]                │
│                                                             │
│ [textarea com texto da resposta]                            │
│                                                             │
│ [📎 Anexos]   [Enviar resposta]                             │
└─────────────────────────────────────────────────────────────┘
```

## Compatibilidade com mensagens antigas

Mensagens inbound capturadas ANTES de hoje (2026-05-27) não têm `raw_payload.to`/`raw_payload.cc`. O hook retorna `ccSugerido=[]` nesses casos — operador continua adicionando manualmente via "+ Adicionar outro email". Sem regressão.

Próximas mensagens (a partir do deploy de hoje) já chegam com headers preservados.

## Validação

1. Cliente Giovanna responde adicionando transporte@ em cópia.
2. Operador abre aba RESPOSTA do card.
3. Composer mostra:
   - Para: giovanna.andrade@isapa.com.br
   - Cc: ☑ transporte@isapa.com.br (pré-marcado)
4. Operador clica enviar → email sai pra Giovanna + transporte@.
5. Operador pode desmarcar transporte@ se quiser → email sai só pra Giovanna.

Cola no Lovable.

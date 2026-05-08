# Lovable — Nova aba "CLIENTE RESPONDEU"

## Contexto

Hoje, quando o cliente responde um email enviado pelo Cockpit, o card volta pra aba "AGUARDANDO VOCÊ" com badge "📬 CLIENTE RESPONDEU" no topo do card. Mas a aba mistura tudo:

- Cards lançados pela primeira vez (oc=10/11/35 vindas do Bastão)
- Cards que voltaram do setor responsável (oc=49)
- Cards onde o **cliente respondeu via email**

Larissa pediu uma aba **dedicada** pra ver só os cards onde o cliente respondeu — pra priorizar a tratativa dessas respostas separadamente do fluxo geral.

**Princípio (Caio 2026-05-08):** card respondido pelo cliente fica **APENAS** na aba CLIENTE RESPONDEU. Sai de AGUARDANDO VOCÊ. Sem duplicação.

## Backend — sem mudança

Tudo já existe:

- `cards.state = 'AGUARDANDO_VALIDACAO_HUMANA'`
- `cards.cliente_respondeu_em` (timestamptz) populado pelo vinculador quando cliente responde
- `cards.ia_sugestao_oc_resposta` (jsonb) populado pelo interpretador-resposta-cliente
- Propostas pendentes em `todos` (recriadas/atualizadas por `atualizarPropostasAposRespostaCliente`)

Quando Larissa aprova qualquer todo, RPC `aprovar_e_executar` zera `cliente_respondeu_em` automaticamente (já implementado). Card sai da aba.

## Filtros das duas abas

### Aba "AGUARDANDO VOCÊ" (mudança)

```ts
state === 'AGUARDANDO_VALIDACAO_HUMANA'
  && cliente_respondeu_em == null   // ← NOVO: exclui respondidos
```

Ordenação atual (não muda).

### Aba "CLIENTE RESPONDEU" (nova)

```ts
state === 'AGUARDANDO_VALIDACAO_HUMANA'
  && cliente_respondeu_em != null
```

Ordenação:
```ts
.order('cliente_respondeu_em', { ascending: false })  // resposta mais recente no topo
```

## Layout da aba CLIENTE RESPONDEU

Posição no Kanban: **entre "AGUARDANDO VOCÊ" e "AÇÃO EXECUTADA"**.

```
┌─────────────────────────────┐
│ 📬 CLIENTE RESPONDEU         │
│ aguardando sua tratativa     │
│                              │
│  [card 1]                    │
│  NF 196537 — VALE COML LTDA  │
│  oc 54 — há 12 min           │
│  🤖 IA sugere oc 44 (99%) ✓  │
│                              │
│  [card 2]                    │
│  NF 73221 — DIST ALPHA       │
│  oc 54 — há 2h               │
│  🤖 IA sugere oc 21 (78%)    │
└─────────────────────────────┘
```

Cabeçalho da coluna:
- Cor base: âmbar/laranja (mesma usada hoje no badge "CLIENTE RESPONDEU")
- Subtítulo: "aguardando sua tratativa"
- Contador: número de cards pendentes

## Cada card na aba

Mantém a aparência atual de cards em AGUARDANDO_VOCE com `cliente_respondeu_em` populado (já desenhado em `lovable-banner-ia-sugestao.md` § "Adendo 2026-05-06"):

- **Borda esquerda âmbar** + **fundo levemente colorido** (`bg-amber-50`)
- **Tag topo:** `📬 CLIENTE RESPONDEU · há {tempo_relativo}`
- **NF + cliente + oc atual**
- **Badge IA** (se `ia_sugestao_oc_resposta != null`):
  - `🤖 IA sugere oc {N} ({confianca}%) ✓` (verde se confiança ≥ 80%)
  - `🤖 IA sugere oc {N} ({confianca}%)` (amarelo se 50–80%)
  - `⚠️ IA sem certeza ({confianca}%)` (laranja se < 50%)

## Detalhe do card aberto

Sem mudança no detalhe — o detalhe **já mostra**:

1. Banner indigo `🤖 Sugestão da IA` no topo (vem de `lovable-banner-ia-sugestao.md`)
2. Botão `[Aprovar oc N]` que faz scroll até o todo correspondente
3. Lista completa de propostas pendentes (4 opções: 21/44/54/56)
4. Texto da resposta do cliente acessível via timeline ou query em `messages_inbox`

Larissa fluxo normal:
- Lê o banner indigo, lê a resposta original
- Clica "Aprovar e Executar" no todo desejado
- Backend executa via SSW + manda email se aplicável
- Card vai pra ACAO_EXECUTADA → some das duas abas (CLIENTE RESPONDEU e AGUARDANDO VOCÊ)

## Estado vazio (empty state)

Quando aba não tem cards:

```
┌─────────────────────────────┐
│ 📬 CLIENTE RESPONDEU         │
│                              │
│  Nenhum cliente respondeu    │
│  ainda. Quando algum cliente │
│  responder por email, o card │
│  aparece aqui automaticamente.│
└─────────────────────────────┘
```

## Componente React (esqueleto)

```tsx
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { CardClienteRespondeu } from './CardClienteRespondeu';

export function AbaClienteRespondeu() {
  const [cards, setCards] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function carregar() {
      const { data, error } = await supabase
        .from('cards')
        .select(`
          id, nf, cliente_nome, cod_ultima_ocorrencia,
          cliente_respondeu_em, ia_sugestao_oc_resposta,
          state, agent_state, evidencia_status
        `)
        .eq('state', 'AGUARDANDO_VALIDACAO_HUMANA')
        .not('cliente_respondeu_em', 'is', null)
        .order('cliente_respondeu_em', { ascending: false });

      if (!error && data) setCards(data);
      setLoading(false);
    }
    carregar();

    // Realtime: re-carregar quando cliente_respondeu_em mudar
    const ch = supabase
      .channel('aba-cliente-respondeu')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'cards' },
        () => carregar())
      .subscribe();

    return () => { supabase.removeChannel(ch); };
  }, []);

  if (loading) return <div>Carregando…</div>;
  if (!cards.length) return <EmptyState />;

  return (
    <div className="flex flex-col gap-3">
      {cards.map(c => <CardClienteRespondeu key={c.id} card={c} />)}
    </div>
  );
}
```

## Mudança em "AGUARDANDO VOCÊ"

**Crítico:** filtrar OUT cards com `cliente_respondeu_em != null` na query da aba antiga:

```diff
  .from('cards')
  .select(...)
  .eq('state', 'AGUARDANDO_VALIDACAO_HUMANA')
+ .is('cliente_respondeu_em', null)   // ← NOVO
```

Sem essa mudança, cards aparecem nas duas abas (duplicação que Caio quer evitar).

## Verificação

- [ ] Aba "CLIENTE RESPONDEU" aparece entre "AGUARDANDO VOCÊ" e "AÇÃO EXECUTADA"
- [ ] Cards com `cliente_respondeu_em != null` aparecem APENAS na nova aba
- [ ] Cards sem resposta de cliente continuam em "AGUARDANDO VOCÊ" normal
- [ ] Aprovar todo na nova aba → card some das duas abas → vai pra "AÇÃO EXECUTADA"
- [ ] Empty state quando não há respostas pendentes
- [ ] Realtime atualiza a aba quando novo cliente responde (sem refresh manual)

## Ciclo dinâmico (sanity)

O ciclo abaixo já funciona com a infra atual — a aba só facilita visualização:

1. Cliente responde email → card vai pra **CLIENTE RESPONDEU**
2. Larissa aprova oc=56 (encaminha Operação) → card vai pra **AÇÃO EXECUTADA** → **TRANSFERIDO**
3. Setor responsável devolve com oc=49 → sync detecta → card volta pra **AGUARDANDO VOCÊ** (sem `cliente_respondeu_em`)
4. Larissa aprova oc=54+email → card vai pra **AÇÃO EXECUTADA** → **AGUARDANDO CLIENTE**
5. Cliente responde de novo → card volta pra **CLIENTE RESPONDEU** (passo 1)

Todo state machine + locks + propostas re-geradas já cobertos por backend. Front só precisa das duas abas filtradas.

## Resumo em 1 frase

Filtrar a query da aba "AGUARDANDO VOCÊ" pra excluir `cliente_respondeu_em IS NOT NULL`; criar nova aba "CLIENTE RESPONDEU" que filtra ao contrário; cards aparecem em uma OU outra, nunca nas duas.

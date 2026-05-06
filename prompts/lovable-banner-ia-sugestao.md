# Lovable — Banner com sugestão da IA quando cliente responde email

## Contexto

Quando cliente responde a um email enviado pelo Cockpit, o backend já:
1. Captura a resposta automaticamente (gmail-poll-inbox a cada 5min)
2. Vincula ao card original (via In-Reply-To)
3. Cria todos pra Larissa aprovar (oc=21 reentrega, oc=44 devolução, oc=56 falta info, oc=54 re-lançar)
4. Chama IA (Claude Sonnet 4.6) que interpreta a resposta e popula `cards.ia_sugestao_oc_resposta`
5. Move card pra `state='AGUARDANDO_VALIDACAO_HUMANA'` com lock

A coluna `cards.ia_sugestao_oc_resposta` é JSONB com formato:

```jsonc
{
  "oc_sugerida": 44,           // 21, 44, 54, ou 56
  "confianca": 0.92,            // 0..1
  "motivo": "Cliente respondeu 'pode encaminhar para devolução total'. Frase explícita.",
  "sugerido_em": "2026-05-06T14:30:00Z",
  "message_id": "<...>"
}
```

Quando o todo é aprovado pela Larissa, o backend limpa `ia_sugestao_oc_resposta` automaticamente (RPC `aprovar_e_executar`).

## O que implementar

No componente de detalhe do card (PENDENCIAS), quando `card.ia_sugestao_oc_resposta != null` E `card.state === 'AGUARDANDO_VALIDACAO_HUMANA'`, **renderizar banner indigo no topo**, ACIMA da lista de todos pendentes.

### Layout

```
┌─ 🤖 Sugestão da IA ─────────────────────────────────┐
│                                                       │
│ Lançar oc 44 — Devolução                              │
│ Confiança: alta (92%)  ✓                              │
│                                                       │
│ "Cliente respondeu: 'pode encaminhar para devolução  │
│  total'. Frase explícita."                            │
│                                                       │
│ [Aprovar oc 44]   [Ver outras opções →]              │
└───────────────────────────────────────────────────────┘
```

### Mapeamento oc → label legível

```ts
const OC_LABELS: Record<number, string> = {
  21: 'Reentrega solicitada',
  44: 'Devolução / retorno de carga',
  54: 'Re-lançar 54 (cliente respondeu inconclusivo)',
  55: 'Autorizar entrega parcial',
  56: 'Falta info operacional',
  // ...
};
```

### Badge de confiança

Calcular badge baseado em `confianca`:

```ts
const conf = card.ia_sugestao_oc_resposta.confianca;
let badge: { label: string; cor: string };
if (conf >= 0.8) badge = { label: `alta (${Math.round(conf*100)}%) ✓`, cor: 'green' };
else if (conf >= 0.5) badge = { label: `média (${Math.round(conf*100)}%)`, cor: 'yellow' };
else badge = { label: `⚠️ baixa (${Math.round(conf*100)}%) — confirme leitura do email`, cor: 'orange' };
```

Quando `confianca < 0.5`, **expandir o banner** com aviso:
```
⚠️ Baixa confiança — a resposta do cliente pode ser ambígua.
Confirme lendo o texto original na timeline antes de aprovar.
```

### Comportamento dos botões

- **`[Aprovar oc 44]`**: NÃO auto-aprova direto. Faz **scroll suave** até o todo correspondente na lista de todos pendentes (`proposta_payload.args.codigo_ssw === 44`) E **destaca visualmente** com borda indigo + animação pulse leve por 2s. Larissa clica "Aprovar e Executar" do todo destacado normalmente.

  Justificativa: aprovação requer confirmação humana sempre (Caio decidiu). UI só facilita encontrar o todo certo.

- **`[Ver outras opções →]`**: scroll suave pra lista completa de todos. Sem destaque.

### Onde encontrar o card_id da resposta

A resposta do cliente fica visível na timeline como evento `RespostaClienteCapturada` (gravado pelo gmail-poll-inbox). Texto completo do email está em `messages_inbox.conteudo` filtrando por `card_id`. Se quiser mostrar o texto recebido inline no banner ou em modal "Ver mensagem original", query:

```ts
const { data: msgs } = await supabase
  .from('messages_inbox')
  .select('conteudo, remetente, recebido_em')
  .eq('card_id', card.id)
  .eq('canal', 'email')
  .order('recebido_em', { ascending: false })
  .limit(1);
```

## Edge cases

- **`ia_sugestao_oc_resposta = null`**: não renderiza banner (todo aprovado, ou IA falhou silenciosamente).
- **`oc_sugerida` que não está nas propostas pendentes**: improvável (interpretador só sugere entre 21/44/54/56), mas se acontecer, banner mostra a sugestão mas botão `[Aprovar oc N]` desabilitado com tooltip "oc não disponível nas propostas atuais".
- **Texto do cliente vazio**: banner ainda aparece (motivo da IA é informativo).

## Resumo

- 1 componente novo: `BannerSugestaoIa.tsx` (ou similar)
- Renderiza acima dos todos quando `card.ia_sugestao_oc_resposta != null`
- Cor base indigo, badge confiança variável (verde/amarelo/laranja)
- Botão de "aprovar" só destaca o todo correspondente — não auto-aprova
- Sem mudança de schema — backend já popula tudo

---

## Adendo Caio 2026-05-06 — Destaque visual "CLIENTE RESPONDEU" na lista AGUARDANDO_VOCE

Para Larissa identificar de relance os cards onde o cliente acabou de responder por email, **destacar visualmente** os cards na lista AGUARDANDO_VOCE quando `card.cliente_respondeu_em` está preenchido.

### Schema novo (já aplicado)

```sql
cards.cliente_respondeu_em timestamptz  -- preenchido pelo vinculador, limpo ao aprovar
```

Esse campo é o sinal canônico de "cliente acabou de responder" — independente de `ia_sugestao_oc_resposta` (que pode estar null se IA falhou).

### Onde renderizar

Na **lista/kanban da aba AGUARDANDO_VOCE**, quando renderizar cada card:

```tsx
const respondeu = card.cliente_respondeu_em != null
  && card.state === 'AGUARDANDO_VALIDACAO_HUMANA';
```

Se `respondeu === true`:
- **Borda esquerda colorida** (laranja ou âmbar) ou **fundo levemente colorido** (âmbar 50)
- Tag/badge no topo do card: `📬 CLIENTE RESPONDEU`
- (Opcional) timestamp relativo: `há 5 min`, `há 1h`

### Layout sugerido (ASCII)

```
┌─━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┐
│ 📬 CLIENTE RESPONDEU · há 12 min          │  ← header laranja
│ ─────────────────────────────────────────│
│ NF 196537 — VALE COML LTDA                │
│ oc 54 — aguardando tratativa              │
│                                            │
│ 🤖 IA sugere: oc 44 (devolução) ✓ 99%    │  ← banner indigo
└─━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┘
```

### Ordenação

Cards com `cliente_respondeu_em != null` devem aparecer **no topo** da aba AGUARDANDO_VOCE (mais urgentes — cliente esperando resposta da Larissa).

```ts
.order('cliente_respondeu_em', { ascending: false, nullsFirst: false })
.order('updated_at', { ascending: false })
```

### Quando some

Quando Larissa aprova qualquer todo do card (ou rejeita/reverte), backend limpa `cliente_respondeu_em = NULL` automaticamente (RPC `aprovar_e_executar`). Card volta a aparecer normal — sem destaque, sem badge.

### Sem mudança extra

- Schema: já aplicado (migration 062)
- Backend: vinculador popula automaticamente quando cliente responde
- Front: 1 condição simples + estilo CSS

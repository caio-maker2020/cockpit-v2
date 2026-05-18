# Lovable — Cancelamento automático de reentrega (oc=21 + 24h)

**Data:** 2026-05-18
**Backend:** 100% pronto e testado em produção (NF 141603 cancelada com sucesso via opção 450 SSW).

## O que essa feature faz

Hoje, quando uma NF tem insucesso por culpa da Sal e o cliente autoriza reentrega mas se nega a pagar pela nova viagem, o operador faz manualmente:
1. Aprova oc=21 no Cockpit → sistema lança 21 no SSW
2. SSW emite automaticamente um CT-e de reentrega complementar (~24h depois)
3. Operador entra no portal SSW opção 450, troca unidade pra MTZ, localiza esse CTRC novo, cancela

Estamos automatizando os passos 2 e 3. Operador marca checkbox no modal de aprovação da oc=21. 24h depois, o backend (com o login do PRÓPRIO operador) entra no SSW, identifica o CTRC de reentrega, cancela automaticamente. Se falhar (CTRC faturado, sem permissão, etc.), aparece numa aba dedicada pro operador agir.

A IA `interpretador-resposta-cliente` também detecta automaticamente o padrão "cliente autorizou reentrega mas se nega a pagar" e pré-marca a sugestão de cancelamento + valida se o argumento do cliente é razoável.

## Mudança 1 — Checkbox no modal de aprovação da oc=21

Modal já existe — vamos adicionar 1 seção opcional logo abaixo dos campos atuais.

### Layout

```
┌──────────────────────────────────────────────────────────────────┐
│ Aprovar — Lançar oc 21 (Reentrega)                               │
│                                                                  │
│ Card: NF 1490882 • CTRC AMB...                                   │
│                                                                  │
│ [Campos atuais do modal — texto, etc — mantém como está]         │
│                                                                  │
│ ───────────────────────────────────────────────────────────────  │
│                                                                  │
│ ╔══════════════════════════════════════════════════════════════╗ │
│ ║ 💡 Sugestão IA (azul-índigo — só aparece quando aplicável)   ║ │
│ ║ Cliente autorizou reentrega mas se nega a pagar.             ║ │
│ ║ Avaliação: "Argumento procede: insucesso documentado como    ║ │
│ ║  erro Sal — cliente justifica recusa de pagamento."          ║ │
│ ╚══════════════════════════════════════════════════════════════╝ │
│                                                                  │
│ ☑ Cancelar reentrega automaticamente em 24h (SSW opção 450)      │
│                                                                  │
│   ℹ️ O sistema vai cancelar o CT-e de reentrega complementar    │
│      que o SSW emitir em ~24h, usando seu login. Evita custo     │
│      pra Sal quando o cliente não vai pagar a nova viagem.       │
│                                                                  │
│   Motivo (auto-preenchido pela IA, editável, max 65 chars):      │
│   ┌─────────────────────────────────────────────────────────┐    │
│   │ Argumento procede: insucesso documentado como erro Sal. │    │
│   └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│              [ Cancelar ]   [ Aprovar e executar ]               │
└──────────────────────────────────────────────────────────────────┘
```

### Comportamento

1. **Seção checkbox aparece sempre** que operador abre modal de oc=21 (operador pode marcar manual mesmo sem IA sugerir)
2. **Banner azul-índigo "Sugestão IA"** aparece SÓ quando `card.ia_sugestao_oc_resposta.cliente_autorizou_reentrega_sem_pagar === true`. Conteúdo: texto fixo + `motivo_cliente_recusa_pagar` em itálico
3. **Checkbox default**: pré-marcado (☑) se IA sugeriu, desmarcado caso contrário. Operador edita livre
4. **Campo motivo** (textarea ~3 linhas, **max 65 chars** porque SSW limita): aparece SÓ quando checkbox marcado. Pré-preenche com `motivo_cliente_recusa_pagar` ou fica vazio. Se vazio no submit, backend usa default "PARA FINS DE ROMANEIO"
5. **Submit** (RPC `aprovar_e_executar`) ganha 2 campos novos em `p_extras`:

```ts
const { data, error } = await supabase.rpc('aprovar_e_executar', {
  p_todo_id: todoId,
  p_extras: {
    cancelar_reentrega_24h: checkboxMarcado,           // boolean
    motivo_cancelamento: motivoEditado || undefined,   // string opcional, max 65 chars
    ...outrosCamposExistentes,
  },
});
```

## Mudança 2 — Aba "Cancelamentos Reentrega" (abaixo de AUDITORIA)

Nova aba na navegação principal, **separada do card** (decisão Caio: card sai de visão quando vai pra TRANSFERIDO; aba fora preserva rastreabilidade). Posicionar **abaixo da aba AUDITORIA** na sidebar. Ícone sugerido: 🔁 ou ❌.

### Layout

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Cancelamentos Reentrega (auto)                                                 │
│                                                                                │
│ Filtros: [ Todos ] [ ⏳ Pendente ] [ ✅ Cancelado ] [ ⚠️ Precisa ação ] [ 🔕 Tratado ] │
│                                                                                │
│ ┌─────────┬──────────┬─────────────────────┬───────────────────────────────┐   │
│ │ NF      │ Operador │ Status              │ Ação                          │   │
│ ├─────────┼──────────┼─────────────────────┼───────────────────────────────┤   │
│ │ 141603  │ DUILIO   │ ✅ Cancelado        │ —                             │   │
│ │         │          │   OVD395536-2       │                               │   │
│ │         │          │   18/05/26 15:12    │                               │   │
│ ├─────────┼──────────┼─────────────────────┼───────────────────────────────┤   │
│ │ 1490882 │ DUILIO   │ ⏳ Pendente         │ [⚡ Forçar cancelamento agora] │   │
│ │         │          │   Agendado p/ 19/05 │                               │   │
│ ├─────────┼──────────┼─────────────────────┼───────────────────────────────┤   │
│ │ 351954  │ LARISSA  │ ⚠️ Precisa ação     │ [⚡ Forçar agora]              │   │
│ │         │          │   CTRC FATURADO     │ [✓ Marcar tratado]            │   │
│ │         │          │   "Pedir Maisa..."  │                               │   │
│ ├─────────┼──────────┼─────────────────────┼───────────────────────────────┤   │
│ │ 920161  │ LARISSA  │ 🔕 Tratado          │ —                             │   │
│ │         │          │   "Resolvi manual"  │                               │   │
│ └─────────┴──────────┴─────────────────────┴───────────────────────────────┘   │
│                                                                                │
│ Badge "⚠️ N precisam ação" no canto da aba pulsa quando há linhas               │
│ status='precisa_acao' não tratadas.                                            │
└────────────────────────────────────────────────────────────────────────────────┘
```

### Fonte de dados

View SQL `v_cancelamentos_reentrega` (já criada):

```ts
const { data, error } = await supabase
  .from('v_cancelamentos_reentrega')
  .select('*')
  .order('agendado_em', { ascending: false })
  .limit(100);
```

Colunas da view:
- `id` (bigint) — id da ação, usado pelos botões
- `card_id` (uuid)
- `nf` (text)
- `ctrc_original` (text)
- `executar_em` (timestamptz)
- `processed_at` (timestamptz | null)
- `status` (text) — **5 valores possíveis**:
  - `pendente` → aguardando cron (~24h após oc=21)
  - `processado` → cancelado com sucesso
  - `precisa_acao` → falha definitiva, operador precisa intervir
  - `tratado_manualmente` → operador marcou como resolvido
  - `cancelado` → ação descartada programaticamente (raro)
- `cancelado_motivo` (text | null)
- `operador` (text)
- `responsavel_relacionamento` (text)
- `oc21_lancada_em` (text ISO)
- `ctrc_reentrega_cancelado` (text | null) — só pra `processado`
- `subcategoria_falha` (text | null) — só pra `precisa_acao`
- `sugestao_acao` (text | null) — sugestão contextual pro operador
- `ultima_falha` (text | null)
- `tentativas` (int | null)
- `tratado_em` (text ISO | null)
- `tratado_por` (text | null)
- `tratado_motivo` (text | null)
- `agendado_em` (timestamptz)

### Renderização por status

| Status | Badge | Detalhes mostrados | Botões |
|---|---|---|---|
| `pendente` | 🟦 Pendente (cinza-azul) | "Agendado p/ {executar_em formatado}" | `[⚡ Forçar agora]` |
| `processado` | 🟢 Cancelado (verde) | `ctrc_reentrega_cancelado` + `processed_at` | — |
| `precisa_acao` | 🟠 Precisa ação (laranja) | label da `subcategoria_falha` + `sugestao_acao` | `[⚡ Forçar agora]` `[✓ Marcar tratado]` |
| `tratado_manualmente` | ⚪ Tratado (cinza) | `tratado_motivo` + `tratado_em` | — |
| `cancelado` | ⚫ Descartado | `cancelado_motivo` | — |

**Mapa de `subcategoria_falha` pra label legível:**

```ts
const SUBCATEGORIA_LABEL: Record<string, string> = {
  ctrc_faturado: "CTRC já foi faturado",
  ctrc_inexistente: "CT-e de reentrega não encontrado",
  ctrc_ja_cancelado: "Já estava cancelado",
  sem_permissao: "Sem permissão SSW",
  fora_prazo: "Fora do prazo",
  tela_inesperada: "SSW respondeu tela inesperada",
  outro: "Erro não categorizado",
};
```

### Botão "⚡ Forçar cancelamento agora"

Chama edge function `forcar-cancelamento-reentrega`:

```ts
const { data, error } = await supabase.functions.invoke('forcar-cancelamento-reentrega', {
  body: { acao_id: linha.id }
});

if (data?.ok) {
  toast.success(data.mensagem);
  // recarrega view
} else {
  toast.error(data?.error ?? 'Erro ao forçar cancelamento');
}
```

A função executa o cancelamento na hora (sem esperar cron) e retorna `status_novo`. Front re-fetcha a view pra atualizar a linha.

### Botão "✓ Marcar tratado manualmente"

Abre prompt simples pro operador descrever o que fez. Chama RPC `marcar_cancelamento_tratado`:

```ts
const motivo = await prompt("Como você tratou essa pendência? (ex: 'Maisa excluiu da fatura', 'Conversei com cliente, ele topou pagar')");
if (!motivo) return;

const { error } = await supabase.rpc('marcar_cancelamento_tratado', {
  p_acao_id: linha.id,
  p_motivo: motivo,
});

if (!error) {
  toast.success("Marcado como tratado");
  // recarrega aba
}
```

A RPC muda status pra `tratado_manualmente`, grava `tratado_em`/`tratado_por`/`tratado_motivo` no payload, registra card_event de auditoria.

### Badge contador na sidebar

Counter de `status='precisa_acao'` exibido como pequeno badge vermelho/laranja ao lado da aba:

```ts
const { count } = await supabase
  .from('v_cancelamentos_reentrega')
  .select('*', { count: 'exact', head: true })
  .eq('status', 'precisa_acao');
// Mostra "⚠️ N" no canto da aba se count > 0
```

Atualizar a cada 30s ou após qualquer ação do operador.

## Critério de aceite

1. **Modal oc=21**: checkbox visível abaixo dos campos atuais. Banner IA aparece quando aplicável. Submit envia `cancelar_reentrega_24h` + `motivo_cancelamento` em extras.
2. **Aba "Cancelamentos Reentrega"**: lista a NF 141603 já cancelada com status=processado (foi o teste real validado).
3. **Botão "Forçar agora"**: clicar dispara `forcar-cancelamento-reentrega`; resultado atualiza linha.
4. **Botão "Marcar tratado"**: prompt pede motivo, salva, linha vira ⚪ tratado.
5. **Badge na sidebar**: pulsa com contador de `precisa_acao`.

## Garantias do backend (não precisa mexer)

- Tabela `acoes_agendadas` extendida com estados `precisa_acao` + `tratado_manualmente`
- View `v_cancelamentos_reentrega` expõe todos os campos
- Edge function `forcar-cancelamento-reentrega` deployada
- RPC `marcar_cancelamento_tratado(acao_id, motivo)` deployada
- Executor agenda automaticamente ao aprovar oc=21 com `extras.cancelar_reentrega_24h=true`
- Handler `processar-acoes-agendadas` roda diariamente (12h UTC), categoriza falhas, gera sugestões contextuais
- Login do operador resolvido automaticamente via `card.responsavel_relacionamento` (LARISSA, DUILIO, etc.)

## Caso de teste real validado

NF 141603 (operador Duilio), CTRC OVD395536-2: cancelamento end-to-end executado com sucesso em 2026-05-18 15:12 UTC. Sistema:
1. Logou no SSW como DUILIO
2. Trocou unidade VGA → MTZ (via `menu01?act=TRO&f2=MTZ&f3=450`)
3. Localizou CTRC complementar na opção 101 (filtro: tipo Colet vazio + mesmo pagador)
4. Cancelou via opção 450 (act='CAN', f2='TESTE 450 - PARA FINS DE ROMANEIO', seq_ctrc=10673797)
5. Confirmado visualmente pelo Caio no SSW

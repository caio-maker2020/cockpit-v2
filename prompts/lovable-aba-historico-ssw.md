# Lovable — Aba HISTÓRICO SSW no card + botão "Trazer Histórico SSW"

## Contexto

No card detalhado já existem várias abas (PARA FAZER, AÇÃO EXECUTADA, AGUARDANDO VOCÊ, CLIENTE RESPONDEU, AUDITORIA, etc). Vamos adicionar **uma aba nova: HISTÓRICO SSW**.

A aba mostra um snapshot das ocorrências históricas dessa NF no SSW (sistema da transportadora). Larissa hoje precisa abrir o SSW manualmente pra ver isso — agora dá pra trazer com 1 clique.

**Caio 2026-05-12**: backend pronto. Edge function `puxar-historico-ssw-card` recebe `{card_id}`, loga no SSW interno, busca a NF, lista todas as ocorrências, e grava em 2 colunas:
- `cards.historico_ssw` (jsonb array)
- `cards.historico_ssw_atualizado_em` (timestamptz)

Latência típica: 2-3 segundos.

---

## Layout da aba

```
┌──────────────────────────────────────────────────────────────────┐
│  HISTÓRICO SSW                                                   │
│                                                                   │
│  Atualizado: 05/12 09:36 (há 3 min)  [🔄 Trazer Histórico SSW]   │
│                                                                   │
│  ─── Linha temporal (mais recente em cima) ──────────────────    │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ 05/05/26 17:16 · VGA · l.silva                              │ │
│  │ 54 — AGUARDANDO RETORNO DO CLIENTE PAGADOR                  │ │
│  │ "AGUARDANDO RETORNO DO CLIENTE PAGADOR"                     │ │
│  └─────────────────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ 04/05/26 13:28 · BHZ · t.darlan                             │ │
│  │ 49 — TRATATIVA DE RELACIONAMENTO PARA LIBERACAO DE CARG     │ │
│  │ "ACAREACAO - ROMANEIO DE COLETA - VALOR (LANCAR A 54 ...)"  │ │
│  └─────────────────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ 22/04/26 15:58 · AMP · l.silva                              │ │
│  │ 54 — AGUARDANDO RETORNO DO CLIENTE PAGADOR     [📷 Foto]    │ │
│  │ "AGUARDANDO RETORNO DO CLIENTE PAGADOR"                     │ │
│  └─────────────────────────────────────────────────────────────┘ │
│  ... (mais entradas)                                              │
└──────────────────────────────────────────────────────────────────┘
```

### Cabeçalho da aba

- **Esquerda**: texto "Atualizado: {data formatada} (há X min)" — calcular delta entre `historico_ssw_atualizado_em` e agora.
- **Direita**: botão `🔄 Trazer Histórico SSW`.

### Botão "Trazer Histórico SSW"

- Sempre visível.
- Texto inicial: `🔄 Trazer Histórico SSW` (quando nunca puxou) ou `🔄 Atualizar` (quando já tem snapshot).
- Ao clicar:
  1. Trocar texto pra `⏳ Buscando no SSW... (~3s)`, desabilitar.
  2. Chamar `supabase.functions.invoke('puxar-historico-ssw-card', { body: { card_id: card.id } })`.
  3. Sucesso (`data.ok === true`): atualizar a aba com a nova lista. Toast verde `✓ {data.total} ocorrências carregadas`.
  4. Erro: toast vermelho `✕ Falha ao puxar histórico SSW: {error.message}` (geralmente sessão SSW expirou — backend re-loga automaticamente, então retentar funciona).

### Lista de ocorrências

Renderiza `card.historico_ssw` (array). Mais recente em cima (o backend já entrega ordenado).

Cada item (card branco com borda fina):
- Header: `{data} · {filial} · {usuario}` (texto cinza pequeno)
- Título: `{codigo} — {descricao}` (preto, médio)
- Subtítulo: `"{instrucao}"` em itálico cinza (oculta se vazia ou igual à descricao)
- Badge `📷 Foto` no canto direito se `tem_foto === true` (cor azul claro)

Códigos null (eventos sem código): renderizar só a instrução sem o cabeçalho de código.

### Estado vazio (nunca puxou OU expirou após 24h)

Se `card.historico_ssw === null` ou `card.historico_ssw === []` (snapshot pode estar nulo porque nunca foi puxado OU porque expirou após 24h — cleanup automático no banco):

```
┌──────────────────────────────────────────────────────────────────┐
│  HISTÓRICO SSW                                                   │
│                                                                   │
│  Nenhum histórico carregado ainda.                               │
│                                                                   │
│              [🔄 Trazer Histórico SSW]                            │
│                                                                   │
│  O agente vai logar no SSW e trazer todas as ocorrências dessa   │
│  NF. Latência típica ~3s.                                        │
│                                                                   │
│  ℹ️ Snapshot fica salvo por 24h pra economizar storage. Depois    │
│  você precisa clicar de novo pra puxar versão atualizada.        │
└──────────────────────────────────────────────────────────────────┘
```

### Botão sempre habilitado (mesmo com snapshot recente)

Larissa pode clicar "🔄 Atualizar" mesmo se o snapshot foi puxado há 5 min — é o jeito de forçar refresh quando ela suspeita que tem oc nova no SSW. Não bloquear o botão por throttling.

---

## Posição da aba

Adicionar entre as abas existentes do card. Sugestão de ordem (do esquerdo pro direito):

1. PARA FAZER / AÇÃO EXECUTADA / AGUARDANDO VOCÊ / CLIENTE RESPONDEU (as 4 existentes)
2. **HISTÓRICO SSW** (nova)
3. AUDITORIA (mantém no fim)

---

## Contrato técnico (backend)

Endpoint `puxar-historico-ssw-card` já deployado. Chamada:

```ts
const { data, error } = await supabase.functions.invoke('puxar-historico-ssw-card', {
  body: { card_id: card.id }
});

if (error || !data?.ok) {
  toast.error("Falha ao puxar histórico SSW: " + (error?.message ?? data?.error));
  return;
}

// data.total, data.atualizado_em, data.ocorrencias[], data.ultima_oc
toast.success(`${data.total} ocorrências carregadas`);
// Front pode re-fetchar o card via PostgREST ou usar data.ocorrencias direto
```

### Formato de cada ocorrência

```ts
{
  codigo: number | null,         // ex: 54, 49, 10, ou null pra eventos sem código
  descricao: string,             // ex: "AGUARDANDO RETORNO DO CLIENTE PAGADOR"
  instrucao: string,             // ex: "AGUARDANDO RETORNO DO CLIENTE PAGADOR"
  data: string,                  // ex: "05/05/26 17:16"
  filial: string | null,         // ex: "VGA"
  usuario: string | null,        // ex: "l.silva"
  tem_foto: boolean              // se a oc tem foto vinculada no SSW
}
```

---

## Resumo da UI

| Elemento | Mudança |
|---|---|
| Card detalhado | Nova aba "HISTÓRICO SSW" |
| Header da aba | "Atualizado: X (há N min)" + botão "🔄 Trazer/Atualizar" |
| Lista | Cards por ocorrência, ordenados (mais recente em cima) |
| Estado vazio | Mensagem + botão grande "Trazer Histórico SSW" |
| Endpoint | `supabase.functions.invoke('puxar-historico-ssw-card', { body: { card_id } })` |
| Latência | ~2-3s (login SSW + scraping) |

Nada mais muda no resto do card. A aba é read-only — Larissa só consulta.

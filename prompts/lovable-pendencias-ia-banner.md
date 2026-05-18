# Lovable — Banner de pendências detectadas pela IA + destaque combo 33+44

## Contexto

A IA (`interpretador-resposta-cliente` v3) agora compara o email que a Larissa enviou ao cliente com a resposta dele e identifica:
- **Pendências**: itens que a Larissa pediu mas o cliente não respondeu/anexou. Ex: "Cliente não anexou o romaneio que Larissa pediu".
- **Combo 33+44**: quando o caso é ressarcimento (Larissa pediu romaneio + cliente autorizou devolução), IA sinaliza essa opção como a recomendada.

Os campos estão em `cards.ia_sugestao_oc_resposta`:

```json
{
  "oc_sugerida": 44,
  "confianca": 0.85,
  "motivo": "...",
  "pendencias_resposta_cliente": [
    "Cliente não anexou o romaneio de coleta assinado"
  ],
  "sugere_combo_33_44": true,
  "motivo_combo": "Larissa solicitou romaneio para ressarcimento..."
}
```

Front precisa renderizar 2 elementos novos.

---

## 1. Banner de pendências (laranja, acima das propostas)

**Quando aparecer**: `card.ia_sugestao_oc_resposta?.pendencias_resposta_cliente?.length > 0` E `state === "AGUARDANDO_VALIDACAO_HUMANA"` (aba CLIENTE RESPONDEU).

**Visual**:

```
┌────────────────────────────────────────────────────────────────┐
│ ⚠ IA detectou pendências na resposta do cliente               │
│                                                                │
│ • Cliente não anexou o romaneio de coleta assinado            │
│ • Não respondeu se autoriza a devolução                       │
│                                                                │
│ Considere responder ao cliente cobrando essas informações     │
│ antes de aprovar uma ocorrência.                              │
│                                                                │
│              [✉ Responder cliente]  [Ignorar e seguir]        │
└────────────────────────────────────────────────────────────────┘
```

**Cor**: fundo laranja claro `#FFF4E5` com borda `#FF9800`.

**Botão "Responder cliente"**: scrolla pra aba RESPOSTA / abre composer de resposta inline. Permite o operador pedir as informações que faltam.

**Botão "Ignorar e seguir"** (nova semântica — migration 106, 2026-05-18):

Chama o RPC `ignorar_pendencias_resposta_cliente` no Supabase. Comportamento:
- Card sai de CLIENTE RESPONDEU e volta pra AGUARDANDO_CLIENTE
- Sinal `cliente_respondeu_em` é zerado + banner some (`ia_sugestao_oc_resposta` zerado)
- A mensagem do cliente FICA visível na aba MENSAGENS (só zera o sinal de "novidade")
- Próxima resposta do cliente nessa thread re-aciona o ciclo normalmente

Caso de uso: cliente respondeu mas não tem o que responder (ex: "vou verificar com a área X", "aguarde retorno"). Operador clica "Ignorar e seguir" e o card sai da aba CLIENTE RESPONDEU até cliente mandar próxima mensagem.

```ts
async function ignorarPendencias(cardId: string) {
  const { data, error } = await supabase.rpc('ignorar_pendencias_resposta_cliente', {
    p_card_id: cardId,
    p_motivo: null  // opcional — pode passar string curta
  });
  if (error) {
    toast.error('Falha ao ignorar pendências: ' + error.message);
    return;
  }
  toast.success('Card voltou pra AGUARDANDO_CLIENTE. Próxima resposta re-aciona.');
  // Refresh do card / navegação pra lista
}
```

Confirmação visual sugerida antes de chamar (modal pequeno):
> "Sem ação na resposta atual? O card volta pra AGUARDANDO CLIENTE e o sistema vai puxar a próxima resposta dessa thread automaticamente."
> [Cancelar]  [Sim, ignorar e seguir]

---

## 2. Destaque na 6ª proposta (combo 33+44)

**Quando aparecer**: na lista de propostas, sempre que houver a opção "Lançar 33 + Lançar 44 (Ressarcimento)" — ela é a 6ª opção (vinculador adiciona sempre). Se `card.ia_sugestao_oc_resposta?.sugere_combo_33_44 === true`, **destacar visualmente**:

```
┌─────────────────────────────────────────────────────────────┐
│ 21  Reentrega solicitada                                    │
│ 44  Retorno de carga (Devolução)                            │
│ 56  Falta info operacional                                  │
│ 54  Re-lançar (manter aguardando)                           │
│ 33  Reversão de perdas (solo)                               │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ ⭐ Lançar 33 + Lançar 44 (Ressarcimento)               │ │
│ │    💡 IA sugere: Larissa solicitou romaneio para        │ │
│ │    análise de ressarcimento e o cliente o enviou...    │ │
│ └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

**Destaque**: borda azul-índigo (`#3F51B5`) + ícone ⭐ + texto IA pequeno em cinza com prefixo "💡 IA sugere:" mostrando `motivo_combo` (até 200 chars).

Se `sugere_combo_33_44 === false`, a 6ª opção continua visível mas SEM destaque (texto cinza normal).

### Filtro defensivo

Hoje pode existir card com `ia_sugestao_oc_resposta` antiga (sem o campo `sugere_combo_33_44`). Tratar como `false` (sem destaque).

---

## 3. Filtro/contagem na lista de cards (opcional)

Na listagem de cards (sidebar ou aba CLIENTE RESPONDEU agrupada), mostrar badge `⚠ N` no canto do card quando houver pendências:

```
┌────────────────────────────────────┐
│ NF 920161 — RIOCLARENSE   📬 ⚠ 1   │
│ Cliente respondeu há 4h            │
└────────────────────────────────────┘
```

`⚠ N` representa quantidade de pendências.

---

## Contrato técnico (backend)

Tudo já está em `cards.ia_sugestao_oc_resposta`. Não precisa endpoint novo. PostgREST funciona:

```ts
const card = (await supabase
  .from("cards")
  .select("*, ia_sugestao_oc_resposta")
  .eq("id", cardId)
  .single()).data;

const pendencias = card.ia_sugestao_oc_resposta?.pendencias_resposta_cliente ?? [];
const sugereCombo = card.ia_sugestao_oc_resposta?.sugere_combo_33_44 ?? false;
const motivoCombo = card.ia_sugestao_oc_resposta?.motivo_combo ?? "";
```

---

## Resumo

| Elemento | Condição | Visual |
|---|---|---|
| Banner pendências | `pendencias_resposta_cliente.length > 0` | Laranja acima das propostas com lista + botões |
| Destaque combo 33+44 | `sugere_combo_33_44 === true` | Borda azul-índigo + ⭐ + motivo IA |
| Badge na lista | `pendencias.length > 0` | `⚠ N` no card |

Sem mudança em propostas existentes — só camadas adicionais de informação.

# Lovable — Anexos inbound + banner pendências IA + modal combo 33+44 (PR único)

## Contexto geral

3 funcionalidades novas no front Cockpit, todas conectadas pelo caso de ressarcimento (Larissa pediu romaneio + cliente respondeu com anexo + autorização de devolução). Backend já está pronto e deployado — front precisa de 3 ajustes integrados.

**Significados das ocs no processo Sal Express:**
- **oc=33** = início do processo de **indenização** pelo time de Perdas (precisa do romaneio assinado em mãos)
- **oc=44** = autorização de **devolução** do volume físico ao cliente
- **oc=56** = falta info operacional (cliente questionou evidência) — NÃO usar quando cliente já enviou o documento que faltava

---

# Mudança 1 — Anexos do cliente (inbound) no card

Hoje quando o cliente responde um email **com anexo** (ex: PDF do romaneio de coleta assinado, foto de comprovante), o Cockpit captura o texto mas **não mostra o anexo**. Larissa precisava abrir Gmail manualmente pra baixar.

**Backend agora baixa automático**: anexos do email do cliente ficam salvos em `email_anexos` com `origem='inbound'` + `message_inbox_id`. O front precisa **renderizar esses anexos na timeline de mensagens do card**.

## Onde renderizar

Na timeline de mensagens do card (aba CLIENTE RESPONDEU ou onde o histórico aparece). Cada mensagem **inbound** que tiver anexos mostra um bloco "📎 Anexos do cliente" abaixo do texto.

```
┌─────────────────────────────────────────────────────────────────┐
│ ✉️  transporte6@rioclarense.com.br                  12/05 10:34 │
│                                                                  │
│ Segue conforme solicitado, gentileza informar prazo de buscas.  │
│                                                                  │
│ 📎 Anexos do cliente:                                            │
│ ┌────────────────────────────────────────────┐ ┌──────────────┐ │
│ │ 📄 Untitled_20260512_104420.pdf — 320 KB   │ │ ⬇ Baixar     │ │
│ └────────────────────────────────────────────┘ └──────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## Como buscar (batch — 1 query pelos message_inbox_ids visíveis)

```ts
const msgIds = mensagensInbound.map(m => m.id);
const { data: todosAnexosInbound } = await supabase
  .from("email_anexos")
  .select("id, filename, mime_type, size_bytes, message_inbox_id, storage_path")
  .in("message_inbox_id", msgIds)
  .eq("origem", "inbound");
const anexosPorMsg = groupBy(todosAnexosInbound, "message_inbox_id");
```

## Botão "⬇ Baixar"

URL assinada do bucket privado (TTL 60s):

```ts
const { data: signed } = await supabase.storage
  .from("email_anexos")
  .createSignedUrl(anexo.storage_path, 60);
if (signed?.signedUrl) window.open(signed.signedUrl, "_blank");
```

## Detalhes de UI

- **Ícone por mime_type**: 📄 PDF, 🖼 imagem (`image/*`), 📊 Excel, 📝 Word, 📋 CSV/TXT, 📎 fallback
- **Tamanho**: formatar KB/MB (`320 KB`, `1.2 MB`)
- **Se mensagem não tem anexos**: bloco "📎" **NÃO aparece** (não renderiza header vazio)
- **Filtro obrigatório**: `origem='inbound'` (não mostrar outbound aqui)

---

# Mudança 2 — Banner de pendências IA + destaque combo 33+44

A IA (`interpretador-resposta-cliente`) agora compara o email da Larissa com a resposta do cliente e identifica:
- **Pendências**: itens que a Larissa pediu mas o cliente não respondeu/anexou
- **Combo 33+44**: quando o caso é ressarcimento, IA recomenda a opção combo

Schema novo em `cards.ia_sugestao_oc_resposta`:

```json
{
  "oc_sugerida": 44,
  "confianca": 0.95,
  "motivo": "Cliente enviou o romaneio assinado e autorizou devolução",
  "pendencias_resposta_cliente": [
    "Cliente não anexou o romaneio de coleta assinado"
  ],
  "sugere_combo_33_44": true,
  "motivo_combo": "Larissa pediu romaneio para ressarcimento e cliente enviou PDF assinado autorizando..."
}
```

## 2.1 — Banner laranja de pendências

**Quando aparecer**: `pendencias_resposta_cliente?.length > 0` E `state === "AGUARDANDO_VALIDACAO_HUMANA"` (aba CLIENTE RESPONDEU).

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

- **Cor**: fundo laranja claro `#FFF4E5` com borda `#FF9800`
- **Botão "Responder cliente"**: scrolla pra aba RESPOSTA / abre composer
- **Botão "Ignorar e seguir"**: fecha visual (sem persistir)
- **Se array vazio**: banner não aparece

## 2.2 — Destaque na 6ª proposta (combo 33+44)

A 6ª proposta **sempre existe** no card pós-resposta cliente (criada pelo vinculador). Identificação:

```ts
const ehCombo = todo.proposta_payload?.tool === "lancar_combo_33_44";
// ou tipo_acao
const tipoAcao = todo.proposta_payload?.meta?.tipo_acao; // 'combo_33_44'
```

**Quando destacar visualmente**: `card.ia_sugestao_oc_resposta?.sugere_combo_33_44 === true`.

```
┌─────────────────────────────────────────────────────────────┐
│ 21  Reentrega solicitada                                    │
│ 44  Retorno de carga (Devolução)                            │
│ 56  Falta info operacional                                  │
│ 54  Re-lançar (manter aguardando)                           │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ ⭐ Lançar 33 + Lançar 44 (Ressarcimento)               │ │
│ │    💡 IA sugere: Larissa pediu romaneio para            │ │
│ │    ressarcimento e cliente enviou o PDF assinado...    │ │
│ └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

- **Destaque**: borda azul-índigo `#3F51B5` + ícone ⭐ + texto pequeno cinza com prefixo "💡 IA sugere:" mostrando `motivo_combo` (até 200 chars)
- **Se `sugere_combo_33_44 === false`**: 6ª opção continua visível mas SEM destaque (texto normal)
- **Se campo ausente** (cards antigos): tratar como `false`

## 2.3 — Badge na listagem (opcional fase 2)

Na sidebar/lista de cards, badge `⚠ N` quando pendências:

```
┌────────────────────────────────────┐
│ NF 920161 — RIOCLARENSE   📬 ⚠ 1   │
│ Cliente respondeu há 4h            │
└────────────────────────────────────┘
```

---

# Mudança 3 — Modal de aprovação do combo 33+44

Quando Larissa clica em **"Lançar 33 + Lançar 44 (Ressarcimento)"**, abre um modal DIFERENTE dos outros: **2 blocos numa tela só** (um pra cada oc), submit único.

## Layout do modal

```
┌──────────────────────────────────────────────────────────────────┐
│ Lançar 33 + Lançar 44 (Ressarcimento)                            │
│                                                                  │
│ 💡 IA sugere essa opção: {motivo_combo do card.ia_sugestao}      │
│                                                                  │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│  Parte 1 — oc=33 (Reversão de perdas / Indenização)              │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                                  │
│ Texto pra Operação:                                              │
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ Cliente enviou o romaneio assinado autorizando devolução.  │  │
│ │ Iniciar processo de indenização.                           │  │
│ └────────────────────────────────────────────────────────────┘  │
│ (até 500 chars)                                                  │
│                                                                  │
│ Romaneio (imagem do cliente):                                   │
│ ○ Usar anexo do cliente: Untitled_20260512_104420.pdf  [selec.] │
│ ○ Subir outro arquivo: [+ Adicionar imagem]                     │
│                                                                  │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│  Parte 2 — oc=44 (Retorno de carga / Devolução)                  │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                                  │
│ Quantidade de volumes: [____]                                   │
│ Motivo: [____________________________________]                  │
│ Filial: [____]                                                  │
│                                                                  │
│ ⚠ A oc=44 só é lançada SE a oc=33 for confirmada no SSW.        │
│                                                                  │
│                          CANCELAR  [CONFIRMAR LANÇAR COMBO →]    │
└──────────────────────────────────────────────────────────────────┘
```

## Bloco Parte 1 — oc=33

- **Textarea "Texto pra Operação"** (até 500 chars, opcional)
  - Pré-preencher com `card.ia_sugestao_oc_resposta?.motivo_combo` se existir (Larissa edita)
  - Placeholder: "Ex: Cliente enviou romaneio assinado autorizando devolução. Iniciar processo de indenização."
- **Romaneio (imagem) — obrigatório**:
  - Listar anexos inbound do card (mesma query da Mudança 1, mas pra todas msgs do card). Radio button "Usar anexo do cliente: {filename}".
  - Botão alternativo "Subir outro arquivo" — upload pro bucket `email_anexos` (padrão dos outros uploads do Cockpit).
  - Larissa precisa escolher 1 dos 2 caminhos (validação obrigatória).

## Bloco Parte 2 — oc=44

3 campos obrigatórios (mesma regra da aprovação de oc=44 solo):
- **Quantidade de volumes** (number)
- **Motivo** (text)
- **Filial** (text curto, ex: "VGA", "BHZ")

## Submit (chamada única)

```ts
const { data, error } = await supabase.rpc("aprovar_e_executar", {
  p_todo_id: comboTodoId,
  p_extras: {
    texto_descricao: textoOc33,            // pra oc=33
    anexo_id: anexoIdEscolhido,            // pra oc=33 (UUID)
    combo_44: {
      quantidade_volumes: volumesOc44,
      motivo: motivoOc44,
      filial: filialOc44,
    },
  },
});
```

Backend executa oc=33 → se OK enfileira oc=44 automático. Se falhar a 33, reverte. Se a 44 falhar pós 33 OK, card vai pra AVH com `acao_falhou_motivo` claro.

## Toasts pós-submit

- **Sucesso (oc=33 OK + oc=44 enfileirada)**: `✓ Combo iniciado: oc=33 lançada, aguarde oc=44 (~30s)`
- **Falha oc=33**: `✕ Oc=33 falhou no SSW: <motivo>. Combo não prosseguiu.`
- **Falha oc=44 pós oc=33 OK**: `⚠ Oc=33 lançada (protocolo X) mas oc=44 falhou. Retentar só a 44 manualmente.` (Card vai pra AVH com aviso claro.)

---

# Contratos técnicos consolidados

## Tabelas/colunas

| Tabela | Coluna | Tipo | Uso |
|---|---|---|---|
| `email_anexos` | `origem` | `'inbound' \| 'outbound'` | Filtrar inbound na timeline |
| `email_anexos` | `message_inbox_id` | uuid | FK pra messages_inbox (só inbound) |
| `email_anexos` | `storage_path` | text | Path no bucket `email_anexos` (privado) |
| `cards` | `ia_sugestao_oc_resposta.pendencias_resposta_cliente` | string[] | Banner laranja |
| `cards` | `ia_sugestao_oc_resposta.sugere_combo_33_44` | boolean | Destaque 6ª proposta |
| `cards` | `ia_sugestao_oc_resposta.motivo_combo` | string | Texto do destaque |
| `todos` | `proposta_payload.tool` | `'lancar_combo_33_44'` | Identifica combo |
| `todos` | `proposta_payload.meta.tipo_acao` | `'combo_33_44'` | Identifica combo (alternativo) |

## Padrão de chamada (sempre usar)

**Edge functions** via `supabase.functions.invoke()`:
```ts
const { data, error } = await supabase.functions.invoke('nome-da-funcao', { body: {...} });
```

**RPCs** via `supabase.rpc()`:
```ts
const { data, error } = await supabase.rpc('aprovar_e_executar', { p_todo_id, p_extras });
```

**Storage** sempre signedUrl (bucket privado):
```ts
const { data: signed } = await supabase.storage.from('email_anexos').createSignedUrl(path, 60);
```

NÃO usar `fetch` com `import.meta.env.VITE_SUPABASE_URL` (env vars não funcionam confiável no Lovable — usar sempre o client `supabase` já configurado).

---

# Resumo final

| Mudança | Onde | O que muda |
|---|---|---|
| **1. Anexos inbound** | Timeline de mensagens | Bloco "📎 Anexos do cliente" com download |
| **2.1 Banner pendências** | Acima das propostas (laranja) | Lista de itens que cliente não respondeu/anexou |
| **2.2 Destaque combo** | 6ª proposta (azul-índigo + ⭐) | Só quando IA sugere combo |
| **2.3 Badge listagem** | Lista de cards (opcional fase 2) | `⚠ N` com qtd pendências |
| **3. Modal combo** | Aprovação 6ª proposta | 2 blocos (33 + 44) submit único |

Nada quebra o fluxo atual — todas mudanças são camadas adicionais. Edge functions e tabelas existentes não mudam.

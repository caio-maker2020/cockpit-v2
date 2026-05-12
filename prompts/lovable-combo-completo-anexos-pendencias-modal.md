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

## 2.2 — Banner "Sugestão da IA" (topo da coluna direita)

**Regra essencial**: a IA sugere UMA coisa só. Quando `sugere_combo_33_44 === true`, o banner principal **DEVE mostrar o combo**, não a oc=44 solo. Larissa NÃO pode ver dois sinais diferentes ("Aprovar oc 44" + "⭐ Combo 33+44") — isso confunde.

**Lógica de renderização do banner principal:**

```ts
const ia = card.ia_sugestao_oc_resposta;
const ehCombo = ia?.sugere_combo_33_44 === true;

if (ehCombo) {
  // Banner mostra o combo
  titulo = "Lançar 33 + Lançar 44 — Ressarcimento";
  confianca = ia.confianca;
  motivo = ia.motivo_combo; // texto do combo, NÃO o motivo da oc=44 solo
  botaoPrincipal = "Aprovar Combo 33+44"; // abre o modal da Mudança 3
  botaoSecundario = "Ver outras opções →"; // mostra todas 6 propostas
} else {
  // Comportamento atual: banner mostra a oc solo sugerida
  titulo = `Lançar oc ${ia.oc_sugerida} — ${descricaoCurta(ia.oc_sugerida)}`;
  confianca = ia.confianca;
  motivo = ia.motivo;
  botaoPrincipal = `Aprovar oc ${ia.oc_sugerida}`;
  botaoSecundario = "Ver outras opções →";
}
```

## 2.3 — Destaque na 6ª proposta (na lista "Ações sugeridas")

A 6ª proposta **sempre existe** no card pós-resposta cliente (criada pelo vinculador). Identificação:

```ts
const ehCombo = todo.proposta_payload?.tool === "lancar_combo_33_44";
// ou tipo_acao
const tipoAcao = todo.proposta_payload?.meta?.tipo_acao; // 'combo_33_44'
```

**Quando destacar visualmente** (na lista): `card.ia_sugestao_oc_resposta?.sugere_combo_33_44 === true`.

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

### ⚠ NÃO renderizar 2 sugestões diferentes simultâneas

Erro a evitar: banner superior mostrar "Aprovar oc 44" + 6ª proposta destacada com ⭐ "combo 33+44" ao mesmo tempo. Larissa vê 2 ações diferentes recomendadas, sem saber qual é a certa.

**Regra dura**: quando `sugere_combo_33_44 === true`, o banner principal já é o combo (ver lógica em 2.2). A 6ª proposta na lista continua com destaque ⭐ pra reforçar visualmente, mas o **botão de ação principal é o do banner superior** (Aprovar Combo 33+44). Não criar 2 caminhos paralelos.

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

- **Textarea "Texto pra Operação"** (até **70 chars** — SSW limita f6)
  - Pré-preencher com `card.ia_sugestao_oc_resposta?.motivo_combo` truncado (Larissa edita)
  - Placeholder: "Ex: Romaneio anexo, cliente autorizou devolução"
- **Imagens — obrigatório (1 ou mais, SSW SÓ aceita JPEG/PNG, NÃO PDF)**:
  - **Caminho A**: usar anexos inbound do cliente. Listar `email_anexos` filtrado por `card_id` E `origem='inbound'`. Multi-select. Se anexo é **PDF**, conversão automática no browser via **pdf.js** → cada página vira 1 JPEG (Larissa vê preview, marca quais; default todas). Cada JPEG sobe pro bucket e UUID entra em `anexos_ids[]`.
  - **Caminho B**: upload manual (mesmo padrão atual). Aceita JPEG/PNG, ≤10MB cada, total ≤20MB (limite SSW).
  - Pode combinar A + B.
  - Validação: pelo menos 1 imagem no array final.

### Conversão pdf.js → JPEG (snippet)

```ts
import * as pdfjsLib from "pdfjs-dist";
pdfjsLib.GlobalWorkerOptions.workerSrc = "/path/to/pdf.worker.js";

async function pdfParaJpegs(pdfBlob: Blob): Promise<File[]> {
  const pdf = await pdfjsLib.getDocument({ data: await pdfBlob.arrayBuffer() }).promise;
  const jpegs: File[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1.5 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d")!, viewport }).promise;
    const blob: Blob = await new Promise((r) => canvas.toBlob((b) => r(b!), "image/jpeg", 0.85));
    jpegs.push(new File([blob], `pagina_${i}.jpg`, { type: "image/jpeg" }));
  }
  return jpegs;
}
```

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
    texto_descricao: textoOc33,             // pra oc=33 (até 70 chars)
    anexos_ids: [uuid1, uuid2, uuid3],      // N imagens JPEG/PNG pra oc=33
    combo_44: {
      quantidade_volumes: volumesOc44,
      motivo: motivoOc44,
      filial: filialOc44,
    },
  },
});
```

Backend (deployado): detecta `tool='lancar_combo_33_44'` no executor, NÃO usa WebAPI. Loga no portal interno SSW (opção 101) e lança ambas via upload multipart — mesmo caminho que Larissa faz manual. Se oc=33 OK, lança oc=44 com texto agregado (volumes/motivo/filial). Ambas OK → card ACAO_EXECUTADA cod_ultima=44.

## Toasts pós-submit

- **Combo OK**: `✓ Combo lançado no SSW (33 + 44). Card foi pra "AÇÃO EXECUTADA".`
- **Falha oc=33**: `✕ Oc=33 falhou no SSW: <motivo>. Nenhuma oc foi lançada.`
- **Falha oc=44 pós oc=33 OK**: `⚠ Oc=33 lançada com sucesso, MAS oc=44 falhou. Retentar SOMENTE a oc=44 manualmente.` (Card vai pra AVH+lock.)

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

# Lovable PATCH — Modal "Reportar Erro" ganha categoria "Evidência Incompleta"

**Data:** 2026-05-21
**Backend:** já está deployado (migration 145, RPC `reportar_erro_lancamento` v2 aceitando `p_motivo_categoria`, IA atualizada pra classificar sub-tipos). **Esse prompt mexe SÓ no frontend.**

**Skill ativada:** `frontend-design` — design consistente com o que já existe no modal atual. Cores semânticas (vermelho/amarelo pra obrigatório), microcopy direta, transições suaves.

---

## Contexto

O modal "Reportar Erro" hoje cobre só erros de OC (base lançou oc=35, era oc=49). Caio identificou um 2º tipo igualmente importante: a OC pode estar CORRETA mas a foto/evidência associada está errada (desfocada, sem assinatura, NF errada visível, foto de outro pedido, etc).

Solução: dropdown "OC correta" passa a ter uma opção **"⭐ A MESMA"** no topo. Quando o operador escolhe ela, aparecem campos obrigatórios pra descrever o problema da evidência.

---

## Mudanças neste patch

### 1. Dropdown "Qual era a ocorrência correta?"

Acrescentar **opção SEMPRE no topo** (antes das opções atuais), com separador visual:

```
┌─────────────────────────────────────────────────────────────┐
│ ⭐ A MESMA (oc=13 está correta, problema é na evidência)   │   ← NOVO, primeiro
│ ──────────────────────────────────────                      │   ← separador
│ 10 — RECUSA TOTAL                                           │
│ 11 — PROBLEMAS COM ENDEREÇO                                 │
│ ...                                                         │
└─────────────────────────────────────────────────────────────┘
```

O número 13 no label é o código da OC reportada (dinâmico — substitui pelo `codigoOcErrada` do contexto).

**Implementação:**

```ts
type OcOption =
  | { tipo: "mesma"; codigo: number; label: string }
  | { tipo: "diferente"; codigo: number; label: string };

function buildDropdown(ocReportada: number): OcOption[] {
  return [
    {
      tipo: "mesma",
      codigo: ocReportada,
      label: `⭐ A MESMA (oc=${ocReportada} está correta, problema é na evidência)`,
    },
    // ↓ lista existente (não muda) — todas com tipo: "diferente"
    { tipo: "diferente", codigo: 10, label: "10 — RECUSA TOTAL" },
    { tipo: "diferente", codigo: 11, label: "11 — PROBLEMAS COM ENDEREÇO" },
    { tipo: "diferente", codigo: 19, label: "19 — ENTREGA COM FALTA DE VOLUMES" },
    { tipo: "diferente", codigo: 20, label: "20 — EXTRAVIO LOCALIZADO" },
    { tipo: "diferente", codigo: 21, label: "21 — REENTREGA SOLICITADA" },
    { tipo: "diferente", codigo: 26, label: "26 — RECUSA NA RECEBENTE" },
    { tipo: "diferente", codigo: 33, label: "33 — REVERSÃO DE PERDAS / INDENIZAÇÃO" },
    { tipo: "diferente", codigo: 35, label: "35 — RECUSA PARCIAL" },
    { tipo: "diferente", codigo: 41, label: "41 — INFORMAÇÃO COMPLEMENTAR" },
    { tipo: "diferente", codigo: 44, label: "44 — RETORNO DE CARGA (DEVOLUÇÃO)" },
    { tipo: "diferente", codigo: 49, label: "49 — TRATATIVA DE RELACIONAMENTO" },
    { tipo: "diferente", codigo: 54, label: "54 — AGUARDANDO POSICIONAMENTO DO CLIENTE" },
    { tipo: "diferente", codigo: 55, label: "55 — AUTORIZAR SEGUIR ENTREGA" },
    { tipo: "diferente", codigo: 56, label: "56 — FALTA INFO OPERACIONAL" },
  ].filter((o) => o.tipo === "mesma" || o.codigo !== ocReportada);
}
```

Renderização: a opção `tipo="mesma"` tem destaque visual (ícone ⭐, cor diferente — sugiro background amarelo claro / texto âmbar). Entre ela e as outras, um separador horizontal sutil.

### 2. Estado + condicional do bloco "Evidência Incompleta"

Quando operador seleciona opção `tipo="mesma"`:

- **Esconde** o bloco antigo "Motivo (opcional)"
- **Mostra** novo bloco com 2 elementos:
  1. Badge fixo (não editável): **"Motivo: EVIDÊNCIA INCOMPLETA OU INDEVIDA"** — cor de alerta amarelo/âmbar
  2. Textarea OBRIGATÓRIA com label **"O que exatamente foi o erro? *"**
     - Placeholder: `"Ex: foto está desfocada e não dá pra ler a assinatura / NF errada visível / foto é de outro pedido..."`
     - Mínimo 10 caracteres
     - Contador `{texto.length} / 10 (mínimo)` em vermelho até atingir 10, depois cinza
     - Botão "Reportar erro" fica DESABILITADO até `texto.trim().length >= 10`

Quando seleciona qualquer outra opção (`tipo="diferente"`):

- Mantém o bloco "Motivo (opcional)" atual como está
- Botão "Reportar erro" habilita assim que selecionar dropdown

```ts
const [ocCorretaSelecionada, setOcCorretaSelecionada] = useState<OcOption | null>(null);
const [motivoTexto, setMotivoTexto] = useState("");

const isEvidenciaIncompleta = ocCorretaSelecionada?.tipo === "mesma";
const motivoMin = isEvidenciaIncompleta ? 10 : 0;
const motivoValido = motivoTexto.trim().length >= motivoMin;

const podeSubmeter = ocCorretaSelecionada !== null && motivoValido;
```

### 3. Layout dinâmico (referência ASCII)

```
┌──────────────────────────────────────────────────────────────────┐
│ Reportar erro de lançamento de ocorrência                     ✕  │
│                                                                  │
│ ┌─ Ocorrência reportada (readonly) ───────────────────────────┐  │
│ │ Código: 13 — ENTREGA IMPOSSIBILITADA                        │  │
│ │ Data: 20/05/2026 13:50 · Base: SAA · Usuário: pimejuli      │  │
│ └─────────────────────────────────────────────────────────────┘  │
│                                                                  │
│ Qual era a ocorrência correta? *                                 │
│ ┌─────────────────────────────────────────────────────────────┐  │
│ │ ⭐ A MESMA (oc=13 está correta, problema é na evidência) ▼ │  │
│ └─────────────────────────────────────────────────────────────┘  │
│                                                                  │
│ ┌────────────────────────────────────────────────────────────┐   │
│ │ ⚠️  Motivo: EVIDÊNCIA INCOMPLETA OU INDEVIDA              │   │
│ │                                                            │   │
│ │ O que exatamente foi o erro? *                             │   │
│ │ ┌────────────────────────────────────────────────────────┐ │   │
│ │ │ Foto está totalmente desfocada, não dá pra ler a       │ │   │
│ │ │ assinatura do cliente. Precisa refazer.                │ │   │
│ │ └────────────────────────────────────────────────────────┘ │   │
│ │ 87 / 10 (mínimo)                                           │   │
│ └────────────────────────────────────────────────────────────┘   │
│                                                                  │
│                       [ Cancelar ]   [ Reportar erro ]           │
└──────────────────────────────────────────────────────────────────┘
```

### 4. Submit — adiciona `p_motivo_categoria`

```ts
async function submitErro() {
  const isMesma = ocCorretaSelecionada!.tipo === "mesma";

  const { data, error } = await supabase.rpc("reportar_erro_lancamento", {
    p_card_id: cardId,
    p_codigo_oc_errada: ocReportada,
    p_codigo_oc_correta: ocCorretaSelecionada!.codigo, // mesma quando isMesma
    p_descricao_oc_errada: descricaoOcErrada,
    p_data_oc_errada: dataOcErrada,
    p_base_responsavel: baseResponsavel,
    p_usuario_responsavel: usuarioResponsavel,
    p_motivo: motivoTexto.trim() || null,
    p_motivo_categoria: isMesma ? "EVIDENCIA_INCOMPLETA" : "OC_DIFERENTE",   // ← NOVO param
  });

  if (error) {
    toast.error("Não foi possível reportar: " + error.message);
    return;
  }
  const tipo = isMesma ? "Erro de evidência" : "Erro de OC";
  toast.success(`${tipo} reportado. Acompanhe na aba INDICADORES.`);
  fecharModal();
}
```

### 5. Erros do backend pra surfar no toast

A RPC retorna mensagens claras se a validação falhar — só mostrar `error.message` no toast já basta:

- Texto curto: `"Pra erro de evidência, descreva o que exatamente estava errado (mínimo 10 caracteres)"`
- Códigos iguais sem categoria EVIDENCIA: `"Pra erro de OC, oc correta deve ser DIFERENTE da errada (se a oc está certa mas a evidência não, use motivo_categoria=EVIDENCIA_INCOMPLETA)"`

A validação client-side (mín 10 chars + disabled no botão) já previne 99% dos casos. RPC é defesa adicional.

---

## Bônus: aba INDICADORES — sub-seção "Sub-tipos de evidência incompleta"

A IA `analisar-indicador-erros-lancamento` agora retorna um array novo no resultado:

```json
{
  // ... outros campos do schema (resumo_geral, metricas_chave, etc) ...
  "evidencia_incompleta_sub_tipos": [
    {
      "sub_tipo": "FOTO_DESFOCADA_OU_ILEGIVEL",
      "total": 4,
      "exemplos_textuais": [
        "foto está totalmente desfocada",
        "não dá pra identificar o produto"
      ]
    },
    {
      "sub_tipo": "SEM_ASSINATURA_OU_ASSINATURA_ILEGIVEL",
      "total": 2,
      "exemplos_textuais": ["não tem assinatura nenhuma na foto"]
    }
  ]
}
```

Renderizar (no card "📊 Erros de Lançamento da Base", abaixo do painel IA atual) **apenas se `evidencia_incompleta_sub_tipos.length > 0`**:

```
┌── 📋 Sub-tipos de Evidência Incompleta ─────────────────────────────┐
│                                                                      │
│ Foto desfocada / ilegível            ████████░░░░  4 ▼              │
│ ▼ expandido:                                                         │
│   "foto está totalmente desfocada"                                   │
│   "não dá pra identificar o produto"                                 │
│                                                                      │
│ Sem assinatura / ilegível             ████░░░░░░░░  2 ▶             │
│ Outro motivo                          ██░░░░░░░░░░  1 ▶             │
└──────────────────────────────────────────────────────────────────────┘
```

Mapeamento de `sub_tipo` → label legível:

```ts
const SUB_TIPO_LABELS: Record<string, string> = {
  FOTO_DESFOCADA_OU_ILEGIVEL: "Foto desfocada / ilegível",
  FOTO_NAO_MOSTRA_OCORRENCIA: "Foto não evidencia a ocorrência",
  FOTO_DE_OUTRA_NF_OU_PEDIDO: "Foto de outra NF / pedido",
  SEM_ASSINATURA_OU_ASSINATURA_ILEGIVEL: "Sem assinatura / ilegível",
  ENDERECO_INCORRETO_VISIVEL: "Endereço errado na evidência",
  INFORMACAO_INCOMPLETA_NA_OBSERVACAO: "Observação incompleta",
  OUTRO: "Outro motivo",
};
```

Cada linha:
- Label legível (mapping acima)
- Barra horizontal proporcional ao maior `total` da lista
- Contador
- Toggle ▶/▼ pra expandir `exemplos_textuais` (até 5 textos literais, fonte itálica, cor cinza)

Ordenar por `total` DESC.

---

## Resumo do que muda

| Onde | O que muda |
|---|---|
| Modal "Reportar Erro" | Dropdown ganha "⭐ A MESMA" no topo; quando selecionada, mostra bloco com badge + textarea obrigatória mín 10 chars |
| Submit do modal | Envia novo param `p_motivo_categoria` (`EVIDENCIA_INCOMPLETA` ou `OC_DIFERENTE`) |
| Card INDICADORES "Erros de Lançamento" | Nova sub-seção "Sub-tipos de Evidência Incompleta" quando `evidencia_incompleta_sub_tipos.length > 0` |

Nada mais muda no modal antigo ou na aba — todo o resto do fluxo existente continua igual.

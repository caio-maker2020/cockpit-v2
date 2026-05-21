# Lovable — Indicador "Erros de Lançamento da Base" + aba INDICADORES + Agente IA

**Data:** 2026-05-18
**Backend:** 100% pronto e deployado (migration 109, edge functions `analisar-indicador-erros-lancamento` e `enviar-cobranca-base`). Agente IA Sonnet 4.6 validado retornando análise estruturada com sugestões prontas pra enviar.

**Skill ativada:** `frontend-design` — design moderno, funcional, fácil visualização. Cards com sombras suaves, badges semânticos, empty states amigáveis, loading skeleton (não spinner), responsivo.

## Visão geral

Vamos adicionar 3 elementos no Cockpit:

1. **Botão "⚠️ Reportar erro"** em cada linha do histórico SSW dentro do card (aba HISTÓRICO SSW que já existe)
2. **Modal "Reportar erro de lançamento"** que abre quando operador clica no botão
3. **Nova aba INDICADORES** na navegação principal, com 1º card "Erros de Lançamento da Base" — incluindo painel de Análise IA, tabela detalhada, drilldown e botões de cobrança por email

A aba INDICADORES é **extensível** — vamos adicionar mais indicadores no futuro seguindo o mesmo padrão de design. Construa pensando nisso: cada indicador é um componente isolado dentro do grid da aba.

---

## Mudança 1 — Botão "⚠️ Reportar erro" no histórico SSW

### Onde aparece

Dentro da aba **HISTÓRICO SSW** do card (que já existe e renderiza array de ocorrências). Adicionar um pequeno botão no canto direito de **cada linha** de ocorrência.

### Comportamento

- Botão discreto: texto pequeno "⚠️ Reportar erro" ou só ícone "⚠️" com tooltip "Reportar que essa ocorrência foi lançada errada pela base"
- Visível **sempre** (não só on-hover)
- **NÃO aparecer** em ocorrências que o próprio Cockpit lançou (campo `usuario` da OC casa com o login SSW do operador atual — operador não reporta a si mesmo). Use `card.responsavel_relacionamento` (LARISSA, DUILIO) — se o `usuario` da OC SSW = lowercase do `responsavel_relacionamento` com `.d` ou similar, ocultar
- Click abre **modal de reportar erro** (mudança 2)

### Fonte dos dados de cada OC histórica

Cada item de `cards.historico_ssw` (JSONB array) tem:
```json
{
  "codigo": 35,
  "descricao": "RECUSA PARCIAL",
  "instrucao": "Cliente não aceitou pacote",
  "data": "15/05/2026 14:30",
  "filial": "Varginha",
  "usuario": "joao.b",
  "tem_foto": true
}
```

Você vai passar esses campos pro modal quando o operador clicar.

---

## Mudança 2 — Modal "Reportar erro de lançamento"

> **Atualização Caio 2026-05-21:** modal agora cobre 2 tipos de erro:
> - **OC errada lançada** (oc=35 mas era oc=49): operador escolhe oc correta no dropdown.
> - **OC correta mas evidência incompleta/indevida** (oc=13 OK mas foto desfocada): operador escolhe **A MESMA** no dropdown → aparecem campos OBRIGATÓRIOS pra descrever o erro da evidência.

### Layout dinâmico

```
┌──────────────────────────────────────────────────────────────────┐
│ Reportar erro de lançamento de ocorrência                     ✕  │
│                                                                  │
│ ┌─ Ocorrência reportada (readonly) ───────────────────────────┐  │
│ │ Código: 13 — ENTREGA IMPOSSIBILITADA                        │  │
│ │ Data: 20/05/2026 13:50                                      │  │
│ │ Base: SAA                                                   │  │
│ │ Usuário SSW: pimejuli                                       │  │
│ │ Instrução: "Cliente não aceitou pacote"                     │  │
│ └─────────────────────────────────────────────────────────────┘  │
│                                                                  │
│ Qual era a ocorrência correta? *                                 │
│ ┌─────────────────────────────────────────────────────────────┐  │
│ │ ▼                                                           │  │
│ │  ★ A MESMA (oc=13 está correta, problema é na evidência)   │  │  ← TOPO da lista
│ │  ──────────────────────────────────────                    │  │
│ │  10 — RECUSA TOTAL                                          │  │
│ │  11 — PROBLEMAS COM ENDEREÇO                                │  │
│ │  ...                                                        │  │
│ └─────────────────────────────────────────────────────────────┘  │
│                                                                  │
│ ┌─ se "A MESMA" selecionada (NOVO) ───────────────────────────┐  │
│ │ Motivo: EVIDÊNCIA INCOMPLETA OU INDEVIDA  (auto-marcado)   │  │
│ │                                                             │  │
│ │ O que exatamente foi o erro? * (mínimo 10 chars)            │  │
│ │ ┌─────────────────────────────────────────────────────────┐ │  │
│ │ │ Ex: foto está desfocada e não dá pra ler a assinatura   │ │  │
│ │ │     do cliente. Precisa refazer.                        │ │  │
│ │ └─────────────────────────────────────────────────────────┘ │  │
│ └─────────────────────────────────────────────────────────────┘  │
│                                                                  │
│ ┌─ se outra oc selecionada (FLUXO ATUAL) ─────────────────────┐  │
│ │ Motivo (opcional, até 300 chars):                           │  │
│ │ ┌─────────────────────────────────────────────────────────┐ │  │
│ │ │ Ex: era falta de volume, não recusa parcial             │ │  │
│ │ └─────────────────────────────────────────────────────────┘ │  │
│ └─────────────────────────────────────────────────────────────┘  │
│                                                                  │
│                       [ Cancelar ]   [ Reportar erro ]           │
└──────────────────────────────────────────────────────────────────┘
```

### Lista do dropdown "OC correta"

A primeira opção é SEMPRE **"⭐ A MESMA (oc=X está correta, problema é na evidência)"** — destaca visualmente com ícone/cor diferente. Em seguida vem o separador e as 20 ocorrências mais usadas:

```ts
type OcOption =
  | { tipo: "mesma"; codigo: number; label: string }
  | { tipo: "diferente"; codigo: number; label: string };

const buildDropdown = (ocReportada: number): OcOption[] => [
  {
    tipo: "mesma",
    codigo: ocReportada,
    label: `⭐ A MESMA (oc=${ocReportada} está correta, problema é na evidência)`,
  },
  // separador renderizado entre tipos diferentes
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
].filter(o => o.tipo === "mesma" || o.codigo !== ocReportada);
```

A opção "diferente" com mesmo código da reportada é filtrada — operador deve escolher "A MESMA" se a oc está certa.

### Comportamento condicional

```ts
const [ocCorretaSelecionada, setOcCorretaSelecionada] = useState<{ codigo: number; tipo: "mesma" | "diferente" } | null>(null);
const [motivoTexto, setMotivoTexto] = useState("");

const isEvidenciaIncompleta = ocCorretaSelecionada?.tipo === "mesma";
const motivoObrigatorio = isEvidenciaIncompleta;
const motivoMinChars = isEvidenciaIncompleta ? 10 : 0;
const motivoValido = !motivoObrigatorio || motivoTexto.trim().length >= motivoMinChars;

const podeSubmeter = ocCorretaSelecionada !== null && motivoValido;
```

Quando `isEvidenciaIncompleta=true`:
- Mostrar badge `Motivo: EVIDÊNCIA INCOMPLETA OU INDEVIDA` (auto-marcado, não editável)
- Mostrar textarea **OBRIGATÓRIA** com placeholder `"O que exatamente foi o erro? Ex: foto desfocada / sem assinatura / NF errada visível..."`
- Contador de chars `{motivoTexto.length} / 10 (mínimo)` em vermelho até atingir 10
- Botão `Reportar erro` desabilitado até `motivoTexto.trim().length >= 10`

Quando opção diferente selecionada (fluxo atual):
- Textarea opcional como antes, até 300 chars
- Botão `Reportar erro` habilitado assim que selecionar oc no dropdown

### Submit

```ts
const isMesma = ocCorretaSelecionada.tipo === "mesma";
const { data, error } = await supabase.rpc('reportar_erro_lancamento', {
  p_card_id: cardId,
  p_codigo_oc_errada: 13,
  p_codigo_oc_correta: ocCorretaSelecionada.codigo,  // mesma quando isMesma
  p_descricao_oc_errada: "ENTREGA IMPOSSIBILITADA",
  p_data_oc_errada: "20/05/2026 13:50",
  p_base_responsavel: "SAA",
  p_usuario_responsavel: "pimejuli",
  p_motivo: motivoTexto.trim() || null,
  p_motivo_categoria: isMesma ? 'EVIDENCIA_INCOMPLETA' : 'OC_DIFERENTE',
});

if (error) {
  toast.error("Não foi possível reportar: " + error.message);
  return;
}
const tipo = isMesma ? "Erro de evidência" : "Erro de OC";
toast.success(`${tipo} reportado. Acompanhe na aba INDICADORES.`);
fecharModal();
```

**Validações RPC backend (mig 145):**
- `p_motivo_categoria='EVIDENCIA_INCOMPLETA'`: exige `motivo` >= 10 chars (RPC rejeita com `22023` se vazio); oc correta normalizada pra mesma.
- `p_motivo_categoria='OC_DIFERENTE'`: exige oc correta != errada (RPC rejeita com `22023`).
- Idempotente por (card_id, oc_errada, data, usuario) — segundo report ATUALIZA categoria/motivo/oc_correta.

---

## Mudança 3 — Aba INDICADORES (skeleton extensível + 1º card)

### Localização na navegação

Adicionar **nova aba na navegação principal** chamada **"INDICADORES"** (com ícone 📊). Visível pra todos os papéis (gestor e operadores comuns) — info compartilhada.

### Estrutura

Aba é um **grid de cards de indicadores**. No MVP, 1 coluna com o 1º indicador. Futuros indicadores entram como cards adicionais (mesma estrutura) — projete pensando em isolar cada card num componente reutilizável tipo `<IndicadorCard nome="..." dados={...} analiseIa={...} />`.

### Card "📊 Erros de Lançamento da Base"

Layout completo:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ 📊 Erros de Lançamento da Base                                               │
│ Identifica quais bases estão errando mais ao lançar ocorrências no SSW       │
│ ───────────────────────────────────────────────────────────────────────────  │
│                                                                              │
│ Filtros: ⏱️ [Últimos 30 dias ▼]  🏢 [Bases ▼]  👤 [Operador que reportou ▼] │
│                                                                              │
│ ╔══════════════════════════════════════════════════════════════════════════╗ │
│ ║                                                                          ║ │
│ ║    KPI 1            KPI 2                  KPI 3                         ║ │
│ ║    ┌──────┐         ┌────────────────┐    ┌──────────────────────────┐  ║ │
│ ║    │ 47   │         │ Varginha       │    │ oc=35 → oc=49           │  ║ │
│ ║    │      │         │                │    │                          │  ║ │
│ ║    │ Total│         │ Base que mais  │    │ Erro mais comum          │  ║ │
│ ║    │ 30d  │         │ erra (12)      │    │ (8 ocorrências)          │  ║ │
│ ║    └──────┘         └────────────────┘    └──────────────────────────┘  ║ │
│ ║                                                                          ║ │
│ ╚══════════════════════════════════════════════════════════════════════════╝ │
│                                                                              │
│ ┌──── 🤖 Análise IA (atualizada há 2h) ─────────── [🔄 Reanalizar com IA] ┐ │
│ │                                                                          │ │
│ │ Resumo: "Erros estão diminuindo no geral (-12%) mas Varginha piorou      │ │
│ │ 40% em oc=19→26. Sugiro treinamento focado..."                           │ │
│ │                                                                          │ │
│ │ ┌── 📈 Melhorando ──────────┐  ┌── 📉 Piorando ──────────────────────┐  │ │
│ │ │ • BHZ -60% em oc=35→49     │  │ • Varginha +40% oc=19→26 🔴 alta   │  │ │
│ │ │ • Geral -12% no período    │  │ • Novo erro: pedro.c 56→11 (baixa) │  │ │
│ │ └────────────────────────────┘  └─────────────────────────────────────┘  │ │
│ │                                                                          │ │
│ │ 💡 Sugestões de melhoria:                                                │ │
│ │   • 🔴 Treinamento focado oc=19 vs oc=26 na Varginha — [Detalhes]        │ │
│ │   • 🟡 Guia rápido de OCs pra consulta no SSW — [Detalhes]               │ │
│ │                                                                          │ │
│ │ 🤖 Sugestões de automação:                                               │ │
│ │   • Alerta SSW quando lançar oc=35 sem oc anterior (média) — [Detalhes]  │ │
│ │   • Dashboard tempo real de erros por base (média)        — [Detalhes]   │ │
│ │                                                                          │ │
│ │ 📧 Cobranças recomendadas pela IA:                                       │ │
│ │   ┌────────────────────────────────────────────────────────────────┐    │ │
│ │   │ 🔴 alta — Pra: Gerente Base Varginha                           │    │ │
│ │   │ Assunto: "Ação necessária: erros de lançamento OC..."          │    │ │
│ │   │ [📄 Pré-visualizar]  [📤 Enviar como está]  [✏️ Editar antes]  │    │ │
│ │   └────────────────────────────────────────────────────────────────┘    │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│ ┌─ Detalhamento ────────────────────────────────────────────────────────────┐│
│ │ Base       │ Usuário SSW  │ Erro             │ Total    │ Última vez      ││
│ │ ───────────┼──────────────┼──────────────────┼──────────┼──────────────── ││
│ │ Varginha   │ joao.b       │ 35 → 49          │  🔴 12   │ há 2d           ││
│ │ ↓ Expandir                                                                ││
│ │            NF 1234, motivo "era falta volume", DUILIO há 2d              ││
│ │            NF 5678, sem motivo, LARISSA há 5d                            ││
│ │            ...                                                            ││
│ │ ───────────┼──────────────┼──────────────────┼──────────┼──────────────── ││
│ │ BHZ        │ maria.s      │ 19 → 26          │  🟠 8    │ há 5d           ││
│ │ Varginha   │ pedro.c      │ 56 → 11          │  🟡 5    │ há 1d           ││
│ └──────────────────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────────────────┘
```

### Fontes de dados

```ts
// 1. Tabela agregada (1ª seção da view + tabela detalhada)
const { data: linhas } = await supabase
  .from('v_indicador_erros_lancamento_base')
  .select('*')
  .gte('ultimo_erro', dataInicioFiltro.toISOString())
  // Backend já ordena por total_erros DESC

// 2. Análise IA (chama edge function — usa cache 24h)
const { data: iaResult } = await supabase.functions.invoke('analisar-indicador-erros-lancamento', {
  body: {
    filtro_periodo_dias: 30,                  // do filtro do usuário
    filtro_bases: basesSelecionadas,          // opcional
    forcar_refresh: false,                    // true quando clica "🔄 Reanalizar"
  }
});

// iaResult.resultado tem o JSON estruturado (resumo, metricas, melhorias, pioras, sugestoes, cobrancas)
// iaResult.gerado_em = timestamp da análise (renderize "atualizada há Xh")
// iaResult.cache = true | false (true = veio do cache 24h)
```

### Componente Análise IA (renderiza resultado da função)

A IA retorna esse formato (já validado em prod):

```json
{
  "resumo_geral": "string — 2-3 frases sobre saúde geral",
  "metricas_chave": [{ "label": "...", "valor": "...", "delta_pct": -12, "tendencia": "melhorando"|"piorando"|"estavel" }],
  "melhoria_destaques": [{ "base": "...", "descricao": "...", "evidencia": "..." }],
  "piora_destaques": [{ "base": "...", "descricao": "...", "evidencia": "...", "severidade": "alta"|"media"|"baixa" }],
  "sugestoes_melhoria": [{ "titulo": "...", "descricao": "...", "base_alvo": "...", "prioridade": "alta"|"media"|"baixa" }],
  "sugestoes_automacao": [{ "titulo": "...", "descricao": "...", "escopo": "preventivo"|"reativo"|"comunicacao", "dificuldade": "baixa"|"media"|"alta" }],
  "cobrancas_recomendadas": [
    {
      "destinatario_sugerido": "string (nome ou email)",
      "assunto_sugerido": "string ≤80 chars",
      "corpo_sugerido": "<p>HTML com parágrafos...</p>",
      "urgencia": "alta"|"media"|"baixa",
      "canal": "email"
    }
  ],
  "evidencia_incompleta_sub_tipos": [
    {
      "sub_tipo": "FOTO_DESFOCADA_OU_ILEGIVEL" | "FOTO_NAO_MOSTRA_OCORRENCIA" | "FOTO_DE_OUTRA_NF_OU_PEDIDO" | "SEM_ASSINATURA_OU_ASSINATURA_ILEGIVEL" | "ENDERECO_INCORRETO_VISIVEL" | "INFORMACAO_INCOMPLETA_NA_OBSERVACAO" | "OUTRO",
      "total": 4,
      "exemplos_textuais": ["foto está totalmente desfocada", "não dá pra identificar o produto na foto"]
    }
  ]
}
```

**Renderização:**
- KPIs: chips coloridos com seta ↑↓ baseado em `tendencia` (verde melhorando, vermelho piorando, cinza estavel)
- Melhorias/Pioras: 2 colunas lado a lado (verde/vermelho), bullets pequenos
- Sugestões: lista com badge de prioridade colorido (🔴 alta / 🟠 média / 🟡 baixa). Botão `[Detalhes]` expande mostrando `descricao` + `base_alvo` (pra sugestoes_melhoria) ou `escopo` + `dificuldade` (pra sugestoes_automacao)
- Cobranças recomendadas: cards minimalistas com:
  - Badge urgência (🔴 alta / 🟠 média / 🟡 baixa)
  - "Pra: {destinatario_sugerido}"
  - "Assunto: {assunto_sugerido}"
  - 3 botões: `[📄 Pré-visualizar]` (abre modal com corpo HTML renderizado), `[📤 Enviar como está]` (envia direto), `[✏️ Editar antes]` (abre composer pré-preenchido)
- **Sub-tipos de evidência incompleta (NOVO 2026-05-21):** seção dedicada quando `evidencia_incompleta_sub_tipos.length > 0`. Lista de barras horizontais agrupadas por `sub_tipo` (label legível), total à direita, e `[ver exemplos]` expande os textos literais dos operadores. Labels:
  - `FOTO_DESFOCADA_OU_ILEGIVEL` → "Foto desfocada / ilegível"
  - `FOTO_NAO_MOSTRA_OCORRENCIA` → "Foto não evidencia a ocorrência"
  - `FOTO_DE_OUTRA_NF_OU_PEDIDO` → "Foto de outra NF / pedido"
  - `SEM_ASSINATURA_OU_ASSINATURA_ILEGIVEL` → "Sem assinatura / ilegível"
  - `ENDERECO_INCORRETO_VISIVEL` → "Endereço errado na evidência"
  - `INFORMACAO_INCOMPLETA_NA_OBSERVACAO` → "Observação incompleta"
  - `OUTRO` → "Outro motivo"

### Botão "📤 Enviar como está" (cobrança IA direto)

```ts
async function enviarCobrancaIA(cobranca, indicadorTipo) {
  // Primeiro pergunta os destinatários (IA sugere mas operador confirma)
  const destinatariosInput = prompt(
    `Confirme os destinatários (separados por vírgula):`,
    cobranca.destinatario_sugerido.includes("@") ? cobranca.destinatario_sugerido : ""
  );
  if (!destinatariosInput) return;
  const destinatarios = destinatariosInput.split(",").map(e => e.trim()).filter(e => e.includes("@"));
  if (destinatarios.length === 0) {
    toast.error("Informe pelo menos 1 email válido");
    return;
  }

  const { data, error } = await supabase.functions.invoke('enviar-cobranca-base', {
    body: {
      destinatarios,
      assunto: cobranca.assunto_sugerido,
      corpo_html: cobranca.corpo_sugerido,
      canal: 'email',
      indicador_tipo: indicadorTipo,
      sugerido_por_ia: true,
    }
  });

  if (data?.ok) toast.success(data.mensagem);
  else toast.error(data?.error ?? error?.message ?? "Falha ao enviar");
}
```

### Botão "✏️ Editar antes"

Abre composer interno com:
- Campo "Para" (textarea, pré-preenchido com sugestão da IA)
- Campo "Assunto" (input, pré-preenchido)
- Campo "Corpo" (rich text editor — opcional; pode ser textarea HTML simples)
- Submit chama mesma edge function com `sugerido_por_ia: true` (mesmo que editado conta como derivado de IA pra auditoria)

### Botão "🔄 Reanalizar com IA"

Chama edge function com `forcar_refresh: true`. Mostra spinner. Atualiza estado. Não bloqueia interação com tabela.

### Tabela detalhada (abaixo do painel IA)

Renderiza array de `v_indicador_erros_lancamento_base`. Colunas:
- Base (texto)
- Usuário SSW (texto monospace, ex: `joao.b`)
- Erro (formato "oc=X → oc=Y" com seta visual)
- Total (badge colorido: vermelho >10, laranja 5-10, amarelo 1-4)
- Última vez (relativa: "há 2d")

Cada linha tem ícone de expandir (▼). Clique expande mostrando `erros_detalhe` (jsonb array de NFs, motivos, datas, quem reportou).

### Filtros

- **Período** (chip-style, default "Últimos 30 dias"): 7d, 30d, 90d, Todos, Customizado
- **Bases** (multi-select com checkboxes): popular dinamicamente com `SELECT DISTINCT base_responsavel FROM erros_lancamento_ssw`
- **Operador que reportou** (multi-select): popular com `SELECT DISTINCT reportado_por_nome FROM erros_lancamento_ssw`

Mudar filtro re-fetch dados + auto-invoca `analisar-indicador-erros-lancamento` (com cache — se mesmos filtros já analisados em <24h, vem do cache, instantâneo).

### Empty state

Quando não há reports:
- Ícone amigável (📊 cinza claro)
- Texto: "Ainda não há erros reportados. Comece reportando do botão ⚠️ no histórico SSW de qualquer card."
- Não chama IA (edge function detecta vazio e retorna mensagem custom)

### Loading state

Skeleton screens (não spinner). Renderiza placeholders das KPIs + painel IA + tabela enquanto carrega.

---

## Botão "📧 Enviar relatório agora" (independente da IA)

No canto superior direito do card "Erros de Lançamento da Base", além da IA, manter botão clássico **"📧 Enviar relatório agora"** que abre modal:

- Campo "Para (emails separados por vírgula)"
- Campo "Assunto" (default: "Relatório de erros de lançamento — Base [filtro selecionado]")
- Mostra preview da tabela atual em HTML
- Submit chama `enviar-cobranca-base` com `sugerido_por_ia: false` (relatório clássico, não veio de IA)

---

## Garantias do backend (não precisa mexer)

- Tabela `erros_lancamento_ssw` + views agregadas + RPC `reportar_erro_lancamento` deployadas
- Agente IA Sonnet 4.6 em `analisar-indicador-erros-lancamento` retornando JSON estruturado
- Cache automático na tabela `analises_ia_indicadores` (TTL 24h, key = indicador_tipo + filtros)
- Edge function `enviar-cobranca-base` envia via Gmail OAuth do operador autenticado, grava log em `cobrancas_enviadas`
- RLS aberta (todos veem tudo na aba INDICADORES — info compartilhada)
- Auditoria completa: cada report cria card_event `ErroLancamentoReportado`; cada cobrança grava em `cobrancas_enviadas` com flag `sugerido_por_ia`

## Critério de aceite

1. **Botão "Reportar erro"** aparece em cada linha do histórico SSW; modal abre com contexto correto; submit grava na tabela e fecha
2. **Aba INDICADORES** acessível na navegação; card "Erros de Lançamento da Base" renderiza mesmo sem dados (empty state) e com dados
3. **3 KPIs no topo** atualizam com filtros (total, base que mais erra, oc mais comum)
4. **Painel IA**: clicar "🔄 Reanalizar" dispara edge function; resultado popula resumo + melhorias/pioras + sugestões + cobranças
5. **Cobrança IA "Enviar como está"**: solicita destinatário → envia → toast de sucesso → linha gravada em `cobrancas_enviadas`
6. **Cobrança IA "Editar antes"**: abre composer pré-preenchido; pode editar e enviar
7. **Tabela detalhada**: ordena por total_erros DESC; click expande mostrando NFs/motivos/quem reportou
8. **Filtros funcionam**: trocar período/bases re-fetch dados + IA (com cache)
9. **RLS**: Larissa, Duilio, Gestor veem MESMA agregação (não há filtro por operador na aba — info compartilhada)

## Design (skill frontend-design)

- **Tipografia**: hierarquia clara, sans-serif. Títulos com peso 600-700, body 400
- **Cores semânticas**: verde-600 melhorando, vermelho-600 piorando, azul-índigo IA, cinza-500 neutro, laranja-500 alerta
- **Cards**: borda 1px gray-200, sombra-sm, padding 24px, radius-lg (12px)
- **KPIs**: número grande (text-4xl bold) + label menor (text-sm cinza), com chip de tendência ao lado
- **Badges**: pill-style com background tintado da cor semântica (bg-red-50 + text-red-700 + border-red-200 pra alta)
- **Tabela**: zebra striping suave, hover row destacado, ícone expandir animado (rotação 90°)
- **Empty/Loading**: ilustrações simples ou ícones grandes em cinza claro; nunca spinner sozinho
- **Responsivo**: grid colapsa em mobile (KPIs viram coluna única, painel IA empilha melhorias/pioras)
- **Animação**: fade-in nos cards ao carregar (200ms), expand animation suave no drilldown (300ms ease-out)
- **Tooltip**: cada KPI tem tooltip explicando o cálculo

## Notas técnicas

- A IA pode levar 5-15s pra responder (Sonnet 4.6 com prompt + dados). Loading state na seção "Análise IA" durante isso — restante da tela continua interativo
- Cache funciona automaticamente: segundo clique com mesmos filtros em <24h é instantâneo
- Pra debug, se IA retornar erro, mostre toast vermelho com mensagem mas mantenha tabela funcional (KPIs vêm do SQL direto, não dependem da IA)
- O `corpo_sugerido` da IA já vem em HTML — renderize com `dangerouslySetInnerHTML` no preview (após sanitize via DOMPurify se quiser ser extra cuidadoso)

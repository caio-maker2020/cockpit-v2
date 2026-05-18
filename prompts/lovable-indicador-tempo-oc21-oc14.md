# Lovable — 2º Indicador "Tempo médio oc=21 → oc=14 por base" + Alertas SLA

**Data:** 2026-05-18
**Backend:** 100% pronto e deployado (migration 112, 3 edge functions, 2 cron jobs).

**Skill ativada:** `frontend-design`. Reusa o componente `<IndicadorCard>` já criado pro 1º indicador (Erros de Lançamento) com painel IA colapsável compartilhado.

## Contexto operacional

Operador lança oc=21 (REENTREGA SOLICITADA) → base operacional precisa lançar oc=14 (SAÍDA PRA ENTREGA) quando põe carga na rua. SLA = **24 horas**. Quanto mais demora, mais o cliente espera.

Esse indicador mede e expõe esse tempo por base + dispara alerta proativo automático pro gerente da base quando passa 24h sem oc=14.

## 🔧 MUDANÇA GLOBAL — Padrão expand/collapse no nível do indicador

**Decisão Caio 2026-05-18:** com vários indicadores futuros na aba INDICADORES, layout fica gigante se tudo expandido. Aplicar padrão de expand/collapse em **CADA card de indicador** (não só no painel IA dentro dele).

### Comportamento

- **Estado padrão**: TODOS os cards de indicador começam **colapsados** (1ª visita à aba). A partir daí, cada card persiste seu estado individualmente em `localStorage`.
- **Quando colapsado**: card mostra **só o header** (título + ícone + resumo super curto com 2-3 métricas-chave + botão `[▼ Expandir]`). Altura fixa ~60-80px.
- **Quando expandido**: card mostra TUDO (KPIs grandes, painel IA, blocos, tabela detalhada). Botão vira `[▲ Recolher]`.
- **Animação suave** ao expandir/recolher (max-height transition 300ms ease-out).
- **localStorage key por indicador**: `indicador_{nome}_card_expanded` (ex: `indicador_tempo_oc21_oc14_card_expanded`, `indicador_erros_lancamento_card_expanded`).

### Layout do header (sempre visível)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ⏱️ Tempo médio entre oc=21 e oc=14 por base                                 │
│ ⏳ 2 pendentes (1 fora SLA) · Média global 18h · 67% dentro SLA   [▼ Expandir] │
└─────────────────────────────────────────────────────────────────────────────┘
```

O resumo do header é dinâmico — vem dos dados:
- **Pendentes**: `count(*) from v_oc21_aguardando_oc14` + count dos `dentro_sla=false`
- **Média global**: `AVG(media_minutos) WEIGHTED BY total_pares` da view agregada
- **% dentro SLA**: `SUM(dentro_sla) / SUM(total_pares) * 100`

Se algum indicador tem 0 dados ainda → resumo mostra: "Sem dados — clique expandir pra ver empty state".

### Aplicar mesma regra ao 1º card (Erros de Lançamento) e a quaisquer FUTUROS

Garantir que o 1º card "📊 Erros de Lançamento da Base" (já existente) **também** ganhe expand/collapse com mesma lógica e localStorage key `indicador_erros_lancamento_card_expanded`. Resumo do header dele: "X erros nos últimos 30d · Base mais errante: Y · Erro mais comum: oc=A→B".

### Componente reusável `<IndicadorCard>`

Centralizar a lógica num único componente que receba props:
```ts
<IndicadorCard
  nome="tempo_oc21_oc14"
  icone="⏱️"
  titulo="Tempo médio entre oc=21 e oc=14 por base"
  resumoHeader={<ResumoTempo dados={dados} />}
  conteudoExpandido={<ConteudoTempo dados={dados} ia={ia} />}
/>
```

Toda lógica de expand/collapse + localStorage fica no `<IndicadorCard>`. Cada indicador novo (3º, 4º, etc.) reusa.

---

## 3 mudanças no front

### Mudança 1 — Adicionar 2º card "⏱️ Tempo médio oc=21→14" na aba INDICADORES

Mesmo padrão do 1º card (Erros de Lançamento). Posicionar **abaixo** do 1º card no grid da aba INDICADORES.

**Título:** "⏱️ Tempo médio entre oc=21 e oc=14 por base"
**Subtítulo:** "Quanto tempo a base leva pra colocar a carga na rua após a reentrega ser solicitada (SLA: 24h)"

#### Fonte de dados

```ts
// Dados agregados
const { data: linhas } = await supabase
  .from('v_indicador_tempo_oc21_oc14_base')
  .select('*');

// Análise IA (mesmo padrão do 1º indicador — cache 24h)
const { data: iaResult } = await supabase.functions.invoke('analisar-indicador-tempo-oc21-oc14', {
  body: { filtro_periodo_dias: 30, filtro_bases: basesSelecionadas, forcar_refresh: false }
});
```

A view tem colunas: `base`, `total_pares`, `media_minutos`, `p50_minutos`, `p95_minutos`, `min_minutos`, `max_minutos`, `dentro_sla`, `fora_sla`, `pct_dentro_sla`, `primeira_medicao`, `ultima_medicao`.

#### KPIs (3 cards no topo)

1. **Tempo médio global** — formato `Xh Ymin` (ex: "18h 32min"). Calculado client-side: `AVG(media_minutos)` ponderado por `total_pares`. Badge tendência ↑↓ vs período anterior (vem da IA).
2. **% dentro do SLA** — calculado: `SUM(dentro_sla) / SUM(total_pares) * 100`. Cores: verde >80%, amarelo 50-80%, vermelho <50%.
3. **Base mais rápida** vs **Base mais lenta** — mostra nomes + média lado a lado.

#### Tabela detalhada

| Base | Total pares | Média | P50 | P95 | % dentro SLA | Última medição |
|---|---|---|---|---|---|---|
| OVD | 12 | 14h | 13h | 22h | 92% 🟢 | há 2d |
| BHZ | 8 | 28h | 24h | 48h | 50% 🟠 | há 5d |
| ... | | | | | | |

Convert minutos pra h/min legível (`x = floor(min/60); y = min%60; → "Xh Ymin"`).

Badge ⚡ na base mais rápida, 🐢 na mais lenta. Linha tintada pela cor do % SLA.

Click linha → expande mostrando os últimos 10 pares dessa base (NF, data 21, data 14, delta em h, dentro/fora SLA). Query:
```ts
const { data: detalhes } = await supabase
  .from('v_tempo_oc21_oc14_detalhe')
  .select('*')
  .eq('base_oc14', base)
  .order('data_oc14', { ascending: false })
  .limit(10);
```

#### Filtros (chip-style)

- **Período**: 7d / 30d / 90d / Todos
- **Bases**: multi-select (popular dinamicamente com `SELECT DISTINCT base FROM v_indicador_tempo_oc21_oc14_base`)
- **Cliente pagador**: multi-select (popular com `SELECT DISTINCT pagador_nome, cnpj_pagador FROM v_oc21_aguardando_oc14 WHERE pagador_nome IS NOT NULL ORDER BY pagador_nome`). Mostra `pagador_nome` como label, filtra por `cnpj_pagador` no backend (chave única — diferentes filiais do mesmo grupo compartilham CNPJ).
- **Operador responsável**: multi-select (DUILIO, LARISSA, etc — vem de `responsavel_relacionamento` distinct)
- **Status SLA**: Todos / Dentro / Fora

Todos os filtros aplicam tanto na **tabela agregada** quanto no **bloco Pendentes** (mesma fonte de dados é refiltrada).

#### Painel IA colapsável

**Reusa o mesmo componente** do 1º indicador. Schema de resposta da IA é idêntico:

```json
{
  "resumo_geral": "...",
  "metricas_chave": [...],
  "melhoria_destaques": [...],
  "piora_destaques": [...],
  "sugestoes_melhoria": [...],
  "sugestoes_automacao": [...],
  "cobrancas_recomendadas": [...]
}
```

Cobranças usam o mesmo botão "Enviar como está" / "Editar antes" que chama `enviar-cobranca-base` com `indicador_tipo='tempo_oc21_oc14'`, `sugerido_por_ia=true`.

### Mudança 2 — Banner SLA no card individual

Quando o card aberto pelo operador tem oc=21 lançada no SSW (visível em `historico_ssw`) MAS ainda não tem oc=14, exibir banner discreto no topo do card:

```
┌───────────────────────────────────────────────────────────────────┐
│ ⏰ SLA — base aguardando lançar oc=14 há 18h (dentro do SLA 24h)  │
│    [Ver alerta enviado em DD/MM HH:MM]                            │
└───────────────────────────────────────────────────────────────────┘
```

#### Lógica

```ts
// No card, ao carregar historico_ssw:
const eventos21 = historico.filter(e => e.codigo === 21);
const eventos14 = historico.filter(e => e.codigo === 14);
const ultima21 = eventos21.length > 0 ? eventos21[eventos21.length - 1] : null;
if (!ultima21) return; // não renderiza banner

const data21 = parseDataSsw(ultima21.data); // dd/mm/yy HH:MM → Date
const tem14Depois = eventos14.some(e => parseDataSsw(e.data) > data21);
if (tem14Depois) return; // SLA cumprido, sem banner

const horasParadas = (Date.now() - data21.getTime()) / 3.6e6;

// Cores baseadas no tempo:
//   ≤ 12h → cinza (informativo)
//   12-24h → amarelo (atenção)
//   > 24h → vermelho (fora SLA)

// Busca alerta enviado pra esse par (cron pode ter rodado)
const { data: alerta } = await supabase
  .from('alertas_sla_oc21_oc14')
  .select('*')
  .eq('card_id', cardId)
  .eq('data_oc21', data21.toISOString())
  .maybeSingle();

// Render banner com texto + (se houver alerta) link "Ver mensagem enviada"
// Click no link abre modal mostrando alerta.mensagem_assunto + alerta.mensagem_html
```

### Mudança 3 — Bloco "⏳ Pendentes — aguardando oc=14" (CENTRAL no card do indicador)

**Decisão Caio 2026-05-18:** esse é o bloco mais importante do indicador. Lista cards com oc=21 lançada SEM oc=14 ainda — ou seja, casos em andamento que precisam ser tratados antes de virarem estatística. Cobrança e sugestão IA partem **daqui**.

Posicionar **acima da tabela agregada** (logo abaixo do painel IA do indicador). Esse bloco é mais acionável do que a média histórica.

#### Layout

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│ ⏳ Pendentes — aguardando oc=14 da base (13 cards · 12 fora SLA)                    │
│                                                                                    │
│ ┌────────┬────────────────┬──────┬──────┬─────────┬─────────────────┬───────────┐ │
│ │ NF     │ Cliente        │ Base │ Op.  │ Paradas │ Status alerta   │ Ações     │ │
│ ├────────┼────────────────┼──────┼──────┼─────────┼─────────────────┼───────────┤ │
│ │1235323 │F E F DISTRI A1 │ BHZ  │ LAR  │ 🔴 457h │ ⚠️ Sem contato  │[📤][👁️]  │ │
│ │ 757623 │ALTHAIA S.A. B. │ SAA  │ LAR  │ 🔴 74h  │ ⚠️ Sem contato  │[📤][👁️]  │ │
│ │ 177627 │PRATI DON. B1   │ COR  │ LAR  │ 🔴 71h  │ ✅ Enviado há 2h│[🔄][👁️]  │ │
│ │1490882 │SAMEH SOL. B.   │ OUR  │ DUI  │ 🟡 8h   │ Dentro SLA      │[📤]       │ │
│ └────────┴────────────────┴──────┴──────┴─────────┴─────────────────┴───────────┘ │
└────────────────────────────────────────────────────────────────────────────────────┘
```

Coluna **Cliente** usa `pagador_nome` (label curto, ~18 chars). Tooltip ao passar o mouse mostra `cnpj_pagador` formatado (`XX.XXX.XXX/XXXX-XX`) + `empresa_cliente` (nome longo se diferente).

#### Fonte: view `v_oc21_aguardando_oc14`

```ts
const { data: pendentes } = await supabase
  .from('v_oc21_aguardando_oc14')
  .select('*');
// Ordem: horas_paradas DESC (mais críticos no topo)
```

Colunas:
- `card_id`, `nf`, `ctrc`, `responsavel_relacionamento` (operador), `base_destino`, `filial_oc21`
- `pagador_nome` (label curto ex: "ALTHAIA S.A. IN B."), `cnpj_pagador` (CNPJ string só dígitos), `empresa_cliente`, `nome_cliente`
- `data_oc21` (timestamp), `horas_paradas` (number), `dentro_sla` (bool)
- `alerta_id`, `alerta_status`, `alerta_enviado_em`, `alerta_assunto`, `alerta_destinatario` (todos null se nunca foi alertado)
- `status_visual` ∈ `'alerta_enviado' | 'alerta_falhou' | 'aguardando_dentro_sla' | 'fora_sla_sem_alerta'`

#### Renderização por status_visual

| status_visual | Badge "Status alerta" | Botões na linha |
|---|---|---|
| `aguardando_dentro_sla` | 🟡 "Dentro SLA — aguardando" | `[📤 Cobrar agora]` |
| `fora_sla_sem_alerta` | ⚠️ "Sem contato cadastrado" (se base sem email) OU "Cron vai enviar próxima hora" | `[📤 Cobrar agora]` |
| `alerta_enviado` | ✅ "Enviado há {tempo} pra {alerta_destinatario}" | `[🔄 Reenviar]` `[👁️ Ver mensagem]` |
| `alerta_falhou` | 🔴 "Falhou: {alerta_motivo_falha}" | `[📤 Tentar novamente]` |

Horas paradas com badge colorido:
- ≤ 12h → cinza
- 12-24h → amarelo
- > 24h → vermelho

#### Botão "📤 Cobrar agora" — modal de cobrança IA

Clique chama edge function `gerar-cobranca-oc14-individual`:

```ts
async function abrirModalCobranca(cardId: string) {
  setLoading(true);
  const { data, error } = await supabase.functions.invoke('gerar-cobranca-oc14-individual', {
    body: { card_id: cardId }
  });
  setLoading(false);
  if (error || !data?.ok) {
    toast.error("IA falhou: " + (error?.message ?? data?.error));
    return;
  }
  // Abre modal com:
  //   - data.contexto (NF, CTRC, horas, dentro/fora SLA)
  //   - Campo "Para" pré-preenchido com data.destinatario_sugerido (ou vazio se !contato_cadastrado)
  //     Quando vazio, mostra aviso amarelo "Base {data.base_esperada} sem contato cadastrado.
  //     Adicione email manualmente ou cadastre via aba CADASTROS."
  //   - Campo "Assunto" pré-preenchido (editável)
  //   - Campo "Corpo" (HTML, editável — preview ao vivo)
  //   - Botões: [Cancelar]  [📤 Enviar agora]
  abrirModal({
    contexto: data.contexto,
    destinatario: data.destinatario_sugerido,
    assunto: data.assunto,
    corpo_html: data.corpo_html,
    base_esperada: data.base_esperada,
  });
}

async function enviarCobranca(payload) {
  const { data } = await supabase.functions.invoke('enviar-cobranca-base', {
    body: {
      destinatarios: payload.destinatarios,
      assunto: payload.assunto,
      corpo_html: payload.corpo_html,
      canal: 'email',
      indicador_tipo: 'cobranca_oc14_individual',
      sugerido_por_ia: true,
    }
  });
  if (data?.ok) {
    toast.success(data.mensagem);
    // Re-fetch view pendentes pra atualizar linha
  } else {
    toast.error(data?.error ?? "Falha");
  }
}
```

#### Botão "👁️ Ver mensagem"

Abre modal mostrando `alerta_assunto` + `alerta_mensagem_html` que foi enviada pelo cron. Read-only.

#### Botão "🔄 Reenviar"

Mesma coisa que "📤 Cobrar agora" mas pré-preenche com a mensagem do alerta anterior pra operador editar/forçar reenvio.

## Garantias do backend (não precisa mexer)

- **Tabela `tempo_oc21_para_oc14`** + view agregada + view detalhe deployadas
- **Tabela `contatos_bases_ssw`** pra cadastro de gerente (RLS escopo gestor pra escrever) — MVP cadastra via SQL direto
- **Tabela `alertas_sla_oc21_oc14`** com UNIQUE `(card_id, data_oc21)` pra idempotência
- **Cron daily** `processar-tempos-oc21-oc14-daily` (13h UTC) processa pares e UPSERT
- **Cron horário** `processar-alertas-sla-oc21-oc14-horario` (minuto 15) dispara alertas
- **Edge function IA** `analisar-indicador-tempo-oc21-oc14` (Sonnet 4.6, cache 24h via `analises_ia_indicadores`)
- **Edge function envio** `enviar-cobranca-base` envia via Gmail OAuth do `responsavel_relacionamento` do card (cron) ou do operador autenticado (Lovable)
- **Roda pra todos os operadores** automaticamente

## Critério de aceite

1. **2º card aparece na aba INDICADORES** abaixo do 1º
2. **KPIs** calculados corretamente em h/min (não em min cru)
3. **% dentro SLA** muda cor conforme percentual
4. **Tabela** ordenada por média DESC; drilldown expande mostrando pares
5. **Painel IA** colapsável compartilhado (estado persiste em localStorage com chave `indicador_tempo_oc21_oc14_ia_expanded`)
6. **Banner SLA** aparece no card individual quando tem oc=21 sem oc=14; some quando oc=14 chega
7. **Modal "Ver mensagem enviada"** renderiza o HTML do alerta
8. **Bloco "Alertas ativos"** lista pares pendentes ordenado por horas paradas DESC

## Notas técnicas

- **Sem dados ainda?** Quando indicador está vazio (zero pares capturados), mostra empty state com texto "Quando operadores lançarem oc=21 e bases lançarem oc=14 em seguida, o indicador vai popular." Backend já retorna mensagem custom nesse caso.
- **Parse data SSW**: formato `dd/mm/yy HH:MM`. Brasília (BRT, UTC-3). Já implementado no backend.
- **Cadastro inicial de contatos**: pra os alertas funcionarem, precisa INSERT em `contatos_bases_ssw`. Eu (Caio) cadastro via SQL no banco. Lista mínima sugerida: OVD, AMB, BHZ, TKS, SEP — emails dos gerentes.
- **Alerta usa Gmail OAuth do operador do card** (`responsavel_relacionamento`). Se o operador não tem Gmail conectado, alerta vai falhar — logado em `alertas_sla_oc21_oc14.status='falhou' + motivo_falha`.

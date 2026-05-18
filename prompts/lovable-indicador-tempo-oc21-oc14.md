# Lovable — 2º Indicador "Tempo médio oc=21 → oc=14 por base" + Alertas SLA

**Data:** 2026-05-18
**Backend:** 100% pronto e deployado (migration 112, 3 edge functions, 2 cron jobs).

**Skill ativada:** `frontend-design`. Reusa o componente `<IndicadorCard>` já criado pro 1º indicador (Erros de Lançamento) com painel IA colapsável compartilhado.

## Contexto operacional

Operador lança oc=21 (REENTREGA SOLICITADA) → base operacional precisa lançar oc=14 (SAÍDA PRA ENTREGA) quando põe carga na rua. SLA = **24 horas**. Quanto mais demora, mais o cliente espera.

Esse indicador mede e expõe esse tempo por base + dispara alerta proativo automático pro gerente da base quando passa 24h sem oc=14.

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

- Período: 7d / 30d / 90d / Todos
- Bases: multi-select (popular dinamicamente com `DISTINCT base` da view)
- Status SLA: Todos / Dentro / Fora

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

### Mudança 3 — Bloco "🚨 Alertas ativos" no card do indicador

Acima da tabela detalhada do indicador (mas abaixo do painel IA), adicionar bloco "Alertas ativos" listando cards com oc=21 sem oc=14:

```ts
// Lista alertas com status='enviado' E ainda não cancelados (oc=14 não chegou)
const { data: alertas } = await supabase
  .from('alertas_sla_oc21_oc14')
  .select('*, cards!inner(nf, ctrc, responsavel_relacionamento)')
  .eq('status', 'enviado')
  .order('enviado_em', { ascending: false })
  .limit(50);
```

Renderiza tabela:

| NF | Base esperada | Operador | Horas paradas | Status | Ação |
|---|---|---|---|---|---|
| 12345 | BHZ | Larissa | **38h** 🔴 | Alerta enviado há 14h | [👁️ Ver mensagem] [📤 Reenviar] |
| ... | | | | | |

Botão "👁️ Ver mensagem" abre modal renderizando o HTML que foi enviado.
Botão "📤 Reenviar agora" pode chamar uma edge function nova `reenviar-alerta-sla` (não implementada — placeholder por enquanto, mostra toast "Em breve").

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

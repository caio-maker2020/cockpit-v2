# Lovable — 2º Indicador "Tempo médio oc=21 → oc=14 por base" + Alertas SLA

**Data:** 2026-05-18
**Backend:** 100% pronto e deployado (migrations 112/116/117, 3 edge functions, 2 cron jobs).

**Skill ativada:** `frontend-design`. Reusa o componente `<IndicadorCard>` já criado pro 1º indicador (Erros de Lançamento) com painel IA colapsável compartilhado.

---

## 🚨 LEIA ANTES DE COMEÇAR — Mudanças críticas desde a versão anterior

Se você já implementou esse card antes, **REGERAR estas partes**:

1. **Tempo em DIAS ÚTEIS, não em horas.** Coluna nova `dias_uteis_parados` (pendentes) e `dias_uteis_para_fechar` (finalizadas). SLA = 1 dia útil. Remover qualquer formatação "Xh Ymin".
2. **Bloco central agora tem 2 TABS: PENDENTES + FINALIZADAS.** Não é mais 1 tabela só. View nova `v_oc21_finalizadas` é a fonte da segunda tab. Botão "Cobrar agora" só existe na tab PENDENTES.
3. **Botão "🔄 Atualizar última oc" por linha** + **🔄 ATUALIZAR TUDO** no header das tabs. Chama `puxar-historico-ssw-card`.
4. **Filtro de cliente pagador REQUER troca de fonte.** A view `v_indicador_tempo_oc21_oc14_base` não tem cliente. Quando o filtro de cliente está ativo, o front precisa buscar da `v_oc21_finalizadas` (que tem cnpj_pagador) e **agregar client-side** (código completo na seção "Filtros"). Sem essa troca, o filtro não move os KPIs nem a tabela agregada — bug observado em 2026-05-18.
5. **Card colapsa/expande** com `localStorage` por indicador.
6. **PENDENTE é só card em state ATIVO** (NÃO TRANSFERIDO/RESOLVIDO/CANCELADO). Cards que saíram da carteira via state vão pra FINALIZADAS com `fonte_fechamento='state_<X>'` e `tipo_fechamento='<state>_sem_evidencia'`. Renderizar badge amarelo "sem evidência" + botão `[🔄 Puxar histórico]` opcional pra forçar refresh.
7. **Análise IA agora escopa por operador automaticamente** (via JWT). Gestor vê global, operador vê só os próprios. O front não precisa mandar filtro extra — só passar o auth padrão do supabase client.

---

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
**Subtítulo:** "Quanto tempo a base leva pra colocar a carga na rua após a reentrega ser solicitada (**SLA: 1 dia útil** — seg-sex)"

> ⚠️ **Atenção: tempos são em DIAS ÚTEIS (segunda-sexta).** A view e a IA já retornam o valor calculado. Não recalcule em horas.

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

A view tem colunas: `base`, `total_pares`, `media_dias_uteis`, `p50_dias_uteis`, `p95_dias_uteis`, `min_dias_uteis`, `max_dias_uteis`, `media_minutos` (legado), `dentro_sla`, `fora_sla`, `pct_dentro_sla`, `primeira_medicao`, `ultima_medicao`.

#### KPIs (3 cards no topo)

1. **Tempo médio global** — formato `X.XX dias úteis` (ex: "2.45 dias úteis"). Calculado client-side: `AVG(media_dias_uteis)` ponderado por `total_pares`. Badge tendência ↑↓ vs período anterior (vem da IA).
2. **% dentro do SLA (1 dia útil)** — calculado: `SUM(dentro_sla) / SUM(total_pares) * 100`. Cores: verde >80%, amarelo 50-80%, vermelho <50%.
3. **Base mais rápida** vs **Base mais lenta** — mostra nomes + média lado a lado.

#### Tabela detalhada

| Base | Total pares | Média (d.u.) | P50 | P95 | % dentro SLA | Última medição |
|---|---|---|---|---|---|---|
| OVD | 12 | 0.85 | 1.0 | 1.5 | 92% 🟢 | há 2d |
| BHZ | 8 | 2.40 | 2.0 | 4.5 | 50% 🟠 | há 5d |
| ... | | | | | | |

Use sempre `media_dias_uteis` direto da view, formate com 2 casas decimais.

Badge ⚡ na base mais rápida, 🐢 na mais lenta. Linha tintada pela cor do % SLA.

Click linha → expande mostrando os últimos 10 pares dessa base (NF, data 21, data 14, **dias úteis**, dentro/fora SLA). Query:
```ts
const { data: detalhes } = await supabase
  .from('v_tempo_oc21_oc14_detalhe')
  .select('id, nf, ctrc, data_oc21, data_oc14, dias_uteis, dentro_sla_dias_uteis, base_oc14, usuario_oc14')
  .eq('base_oc14', base)
  .order('data_oc14', { ascending: false })
  .limit(10);
```

#### Filtros (chip-style)

- **Período**: 7d / 30d / 90d / Todos
- **Bases**: multi-select (popular dinamicamente com `SELECT DISTINCT base FROM v_indicador_tempo_oc21_oc14_base`)
- **Cliente pagador**: multi-select (popular juntando `pagador_nome`+`cnpj_pagador` distinct das 3 views: `v_oc21_aguardando_oc14`, `v_oc21_finalizadas`, `v_tempo_oc21_oc14_detalhe`). Mostra `pagador_nome` como label, filtra por `cnpj_pagador` (chave única — diferentes filiais do mesmo grupo compartilham CNPJ).
- **Operador responsável**: multi-select (DUILIO, LARISSA, etc — vem de `responsavel_relacionamento` distinct)
- **Status SLA**: Todos / Dentro / Fora

##### ⚠️ Importante: como aplicar filtros de cliente/operador na tabela agregada

A view `v_indicador_tempo_oc21_oc14_base` **NÃO tem coluna de cliente nem de operador** — ela é agregada apenas por base. Quando o usuário aplica filtro de cliente OU operador, **trocar a fonte de dados pra `v_tempo_oc21_oc14_detalhe`** (que tem `cnpj_pagador`, `pagador_nome`, `responsavel_relacionamento`) e agregar client-side:

```ts
async function carregarAgregado(filtros) {
  const temFiltroCliente = filtros.cnpjs?.length > 0;
  const temFiltroOperador = filtros.operadores?.length > 0;

  if (!temFiltroCliente && !temFiltroOperador) {
    // Caminho rápido: usa view agregada já pronta
    let q = supabase.from('v_indicador_tempo_oc21_oc14_base').select('*');
    if (filtros.bases?.length) q = q.in('base', filtros.bases);
    return (await q).data;
  }

  // Caminho com filtro de cliente/operador: agrega no cliente
  let q = supabase
    .from('v_tempo_oc21_oc14_detalhe')
    .select('base_oc14, dias_uteis, dentro_sla_dias_uteis, cnpj_pagador, responsavel_relacionamento, data_oc14');
  if (filtros.bases?.length) q = q.in('base_oc14', filtros.bases);
  if (temFiltroCliente) q = q.in('cnpj_pagador', filtros.cnpjs);
  if (temFiltroOperador) q = q.in('responsavel_relacionamento', filtros.operadores);
  const { data: detalhes } = await q;

  // Agrega client-side no mesmo shape da view agregada
  const map = new Map();
  for (const r of detalhes ?? []) {
    const b = r.base_oc14;
    const ex = map.get(b) ?? { base: b, total_pares: 0, soma_du: 0, dentro: 0, valores: [] };
    ex.total_pares++;
    ex.soma_du += Number(r.dias_uteis ?? 0);
    if (r.dentro_sla_dias_uteis) ex.dentro++;
    ex.valores.push(Number(r.dias_uteis ?? 0));
    map.set(b, ex);
  }
  return [...map.values()].map(v => ({
    base: v.base,
    total_pares: v.total_pares,
    media_dias_uteis: Math.round((v.soma_du / v.total_pares) * 100) / 100,
    p50_dias_uteis: percentil(v.valores, 0.5),
    p95_dias_uteis: percentil(v.valores, 0.95),
    dentro_sla: v.dentro,
    fora_sla: v.total_pares - v.dentro,
    pct_dentro_sla: Math.round(100 * v.dentro / v.total_pares),
  })).sort((a, b) => b.media_dias_uteis - a.media_dias_uteis);
}
```

Tabs PENDENTES e FINALIZADAS aplicam todos os filtros via `.in()` direto nas views (que já têm essas colunas).

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

### Mudança 3 — Bloco central com 2 tabs: PENDENTES / FINALIZADAS

**Decisão Caio 2026-05-18:** o bloco principal do indicador tem **2 tabs lado a lado**, posicionado **acima** da tabela agregada (logo abaixo do painel IA). O usuário alterna entre:

- **⏳ PENDENTES** — cards com oc=21 lançada SEM oc=14 e SEM finalizadora (01/30/32). É o gargalo em curso. "Cobrar agora" só faz sentido aqui.
- **✅ FINALIZADAS** — ciclos fechados (oc=14 chegou OU oc=01/30/32). Mostra quantos dias úteis demorou. Sem botão de cobrança.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ [⏳ Pendentes (9)]  [✅ Finalizadas (4)]          [🔄 ATUALIZAR TUDO]            │
└─────────────────────────────────────────────────────────────────────────────────┘
```

Contadores nas tabs vêm direto de `count()` de cada view.

---

#### Tab "⏳ PENDENTES" — Fonte: view `v_oc21_aguardando_oc14`

```ts
const { data: pendentes } = await supabase
  .from('v_oc21_aguardando_oc14')
  .select('*');
// Ordem: minutos_paradas DESC (mais críticos no topo)
```

Colunas da view:
- `card_id`, `nf`, `ctrc`, `responsavel_relacionamento` (operador), `base_destino`
- `pagador_nome`, `cnpj_pagador`, `empresa_cliente`, `nome_cliente`
- `data_oc21` (timestamp), `dias_uteis_parados` (numeric — **usar sempre essa coluna, não horas**), `horas_paradas` (legado), `dentro_sla` (bool — true se ≤1 dia útil)
- `alerta_id`, `alerta_status`, `alerta_enviado_em`, `alerta_assunto`, `alerta_destinatario`
- `status_visual` ∈ `'alerta_enviado' | 'alerta_falhou' | 'aguardando_dentro_sla' | 'fora_sla_sem_alerta'`

##### Layout

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ ⏳ Pendentes — aguardando oc=14 (9 cards · 8 fora SLA)                                   │
│                                                                                         │
│ ┌────────┬────────────────┬──────┬──────┬─────────────┬─────────────────┬─────────────┐ │
│ │ NF     │ Cliente        │ Base │ Op.  │ Dias úteis  │ Status alerta   │ Ações       │ │
│ ├────────┼────────────────┼──────┼──────┼─────────────┼─────────────────┼─────────────┤ │
│ │1235323 │F E F DISTRI A1 │ BHZ  │ LAR  │ 🔴 19.0 d.u.│ ⚠️ Sem contato  │[📤][🔄][👁️]│ │
│ │ 757623 │ALTHAIA S.A. B. │ SAA  │ LAR  │ 🔴 3.1 d.u. │ ⚠️ Sem contato  │[📤][🔄][👁️]│ │
│ │ 177627 │PRATI DON. B1   │ COR  │ LAR  │ 🔴 2.9 d.u. │ ✅ Enviado há 2h│[🔄][🔄][👁️]│ │
│ │1490882 │SAMEH SOL. B.   │ OUR  │ DUI  │ 🟡 0.3 d.u. │ Dentro SLA      │[📤][🔄]    │ │
│ └────────┴────────────────┴──────┴──────┴─────────────┴─────────────────┴─────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

Coluna **Cliente** usa `pagador_nome`. Tooltip mostra `cnpj_pagador` formatado + `empresa_cliente`.

Coluna **Dias úteis** usa `dias_uteis_parados` formatado com 1 casa decimal + sufixo `d.u.`. Badge colorido:
- ≤ 0.5 d.u. → cinza (atividade recente)
- 0.5 – 1.0 d.u. → amarelo (atenção, perto do SLA)
- \> 1.0 d.u. → vermelho (fora SLA)

##### Renderização por status_visual

| status_visual | Badge "Status alerta" | Botões na linha |
|---|---|---|
| `aguardando_dentro_sla` | 🟡 "Dentro SLA — aguardando" | `[📤 Cobrar agora]` `[🔄 Atualizar última oc]` |
| `fora_sla_sem_alerta` | ⚠️ "Sem contato cadastrado" OU "Cron vai enviar próxima hora" | `[📤 Cobrar agora]` `[🔄 Atualizar última oc]` |
| `alerta_enviado` | ✅ "Enviado há {tempo} pra {alerta_destinatario}" | `[🔄 Reenviar]` `[🔄 Atualizar última oc]` `[👁️ Ver mensagem]` |
| `alerta_falhou` | 🔴 "Falhou: {alerta_motivo_falha}" | `[📤 Tentar novamente]` `[🔄 Atualizar última oc]` |

##### Botão "🔄 Atualizar última oc" (por linha)

Força puxar histórico SSW desse card específico — útil quando operador suspeita que a oc=14 já foi lançada mas o cron de 6h ainda não puxou. Após sucesso, refaz a query da view (`v_oc21_aguardando_oc14`) — se a oc=14 ou finalizadora foi capturada, a linha some automaticamente (vai pra tab Finalizadas).

```ts
async function atualizarUltimaOc(cardId: string) {
  setLinhaLoading(cardId, true);
  const { data, error } = await supabase.functions.invoke('puxar-historico-ssw-card', {
    body: { card_id: cardId }
  });
  setLinhaLoading(cardId, false);
  if (error || !data?.ok) {
    toast.error("Falha ao atualizar: " + (error?.message ?? data?.error));
    return;
  }
  toast.success(`Atualizado — ${data.total} ocorrências. Última: oc=${data.ultima_oc?.codigo}`);
  // Re-fetch das duas views (pendentes pode ter perdido essa linha pra finalizadas)
  await refetchPendentes();
  await refetchFinalizadas();
}
```

##### Botão "🔄 ATUALIZAR TUDO" (no header das tabs)

Dispara em paralelo o cron de refresh em lote. Útil quando operador quer revalidar todas as pendentes de uma vez:

```ts
async function atualizarTodas() {
  const ids = pendentes.map(p => p.card_id);
  toast.info(`Atualizando ${ids.length} cards…`);
  await Promise.all(ids.map(id =>
    supabase.functions.invoke('puxar-historico-ssw-card', { body: { card_id: id } })
  ));
  await refetchPendentes();
  await refetchFinalizadas();
  toast.success("Pendências revalidadas");
}
```

> Confirmar com modal "Vai atualizar N cards. Pode levar até 30s. Continuar?" se N > 5.

---

#### Tab "✅ FINALIZADAS" — Fonte: view `v_oc21_finalizadas`

```ts
const { data: finalizadas } = await supabase
  .from('v_oc21_finalizadas')
  .select('*')
  .order('data_fechamento', { ascending: false });
```

Colunas:
- `card_id`, `nf`, `ctrc`, `responsavel_relacionamento`, `base_destino`
- `pagador_nome`, `cnpj_pagador`, `empresa_cliente`, `nome_cliente`
- `state_card` ∈ `'TRANSFERIDO' | 'RESOLVIDO' | 'CANCELADO' | ...` (state do card no Cockpit)
- `data_oc21`, `data_fechamento`, `codigo_fechamento` (int: 14/1/30/32 ou NULL se via state)
- `fonte_fechamento` ∈ `'historico_ssw' | 'state_TRANSFERIDO' | 'state_RESOLVIDO' | 'state_CANCELADO'`
- `tipo_fechamento` ∈ um dos 8 valores:
  - via histórico: `'oc14_saida'`, `'oc01_entrega_realizada'`, `'oc30_devolucao_comprovada'`, `'oc32_entrega_nao_realizada'`
  - via state (histórico ainda não puxado): `'transferido_sem_evidencia'`, `'resolvido_sem_evidencia'`, `'cancelado_sem_evidencia'`
  - `'outro'`
- `base_fechamento` (filial que lançou o evento de fechamento), `usuario_fechamento`
- `dias_uteis_para_fechar` (numeric), `horas_para_fechar` (legado), `dentro_sla_dias_uteis` (bool)

##### Layout

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ ✅ Finalizadas — ciclo fechado (4 cards · 4 fora SLA)                                   │
│                                                                                        │
│ ┌────────┬───────────────┬──────┬───────────────────┬─────────────┬──────────────────┐ │
│ │ NF     │ Cliente       │ Base │ Fechou via        │ Dias úteis  │ Data fechamento  │ │
│ ├────────┼───────────────┼──────┼───────────────────┼─────────────┼──────────────────┤ │
│ │ 422938 │PRATI DON.     │ VIT  │ 🚚 oc=14 SAÍDA    │ 🔴 6.08 d.u.│ 18/05 09:12      │ │
│ │1004188 │SAMEH SOL.     │ BHE  │ 🚚 oc=14 SAÍDA    │ 🔴 3.89 d.u.│ 14/05 14:30      │ │
│ │ 761816 │ALTHAIA S.A.   │ MTC  │ 🚚 oc=14 SAÍDA    │ 🔴 2.82 d.u.│ 12/05 11:45      │ │
│ │ 755618 │FEF DISTRI.    │ IPE  │ 🚚 oc=14 SAÍDA    │ 🔴 2.67 d.u.│ 12/05 16:10      │ │
│ └────────┴───────────────┴──────┴───────────────────┴─────────────┴──────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

##### Coluna "Fechou via" — mapeamento por `tipo_fechamento`

Confirmado no histórico SSW (caminho ideal):

| tipo_fechamento | Label exibido | Cor / ícone |
|---|---|---|
| `oc14_saida` | 🚚 oc=14 SAÍDA | azul (caminho esperado) |
| `oc01_entrega_realizada` | 📦 oc=01 ENTREGUE | verde (ciclo positivo) |
| `oc30_devolucao_comprovada` | ↩️ oc=30 DEVOLUÇÃO | cinza |
| `oc32_entrega_nao_realizada` | ❌ oc=32 NÃO REALIZADA | vermelho |

Fechado via state do Cockpit (histórico_ssw ainda não puxado — sync confirmou saída mesmo assim):

| tipo_fechamento | Label exibido | Cor / ícone |
|---|---|---|
| `transferido_sem_evidencia` | 🟦 Transferido (aguardando histórico) | azul claro, badge "sem evidência" |
| `resolvido_sem_evidencia` | ✅ Resolvido (aguardando histórico) | verde claro, badge "sem evidência" |
| `cancelado_sem_evidencia` | ⛔ Cancelado (aguardando histórico) | cinza, badge "sem evidência" |

**Badge "sem evidência":** discreto, cor amarela. Tooltip explica: *"Card saiu da carteira via Cockpit/sync, mas o histórico SSW ainda não foi atualizado pra confirmar qual oc fechou o ciclo. O cron de 6h vai puxar — depois disso a linha passa a mostrar a oc real (14/01/30/32)."*

Pode-se renderizar um botão pequeno **`[🔄 Puxar histórico]`** ao lado do badge (chama `puxar-historico-ssw-card` no card_id) pra forçar o operador a resolver na hora, se quiser.

##### Coluna "Dias úteis" — `dias_uteis_para_fechar` com 2 casas decimais

Badge colorido pelo `dentro_sla_dias_uteis`:
- `true` → verde
- `false` → vermelho

##### Filtro extra na tab FINALIZADAS

Adicionar chip-filter **"Tipo de fechamento"** com 3 valores:
- **Todos** (default)
- **Confirmado no SSW** (filtra `fonte_fechamento = 'historico_ssw'`)
- **Pendente de evidência** (filtra `fonte_fechamento <> 'historico_ssw'`)

Útil pro operador focar em quais finalizadas ainda precisam ser conferidas no SSW.

##### Sem outras ações por linha

Finalizadas são **apenas leitura** — sem botões salvo o "🔄 Puxar histórico" quando `*_sem_evidencia`. Click na linha pode expandir mostrando timeline completa do card (opcional, não obrigatório no MVP).

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
2. **KPIs** em **dias úteis** (2 casas decimais), não em horas/minutos
3. **% dentro SLA (1 dia útil)** muda cor conforme percentual
4. **Tabela** ordenada por `media_dias_uteis` DESC; drilldown expande mostrando pares
5. **Painel IA** colapsável compartilhado (estado persiste em localStorage com chave `indicador_tempo_oc21_oc14_ia_expanded`)
6. **Bloco central com 2 tabs PENDENTES / FINALIZADAS** com contadores no header
7. Tab PENDENTES tem botão **🔄 Atualizar última oc** por linha + **🔄 ATUALIZAR TUDO** no header
8. Tab FINALIZADAS mostra `tipo_fechamento` (oc=14, oc=01, oc=30 ou oc=32) com ícone/cor distintos
9. **Banner SLA** aparece no card individual quando tem oc=21 sem oc=14; some quando oc=14 OU finalizadora chega
10. **Modal "Ver mensagem enviada"** renderiza o HTML do alerta
11. **"Cobrar agora"** só aparece em PENDENTES (nunca em FINALIZADAS)

## Notas técnicas

- **Sem dados ainda?** Quando indicador está vazio (zero pares capturados), mostra empty state com texto "Quando operadores lançarem oc=21 e bases lançarem oc=14 em seguida, o indicador vai popular." Backend já retorna mensagem custom nesse caso.
- **Parse data SSW**: formato `dd/mm/yy HH:MM`. Brasília (BRT, UTC-3). Já implementado no backend.
- **Cadastro inicial de contatos**: pra os alertas funcionarem, precisa INSERT em `contatos_bases_ssw`. Eu (Caio) cadastro via SQL no banco. Lista mínima sugerida: OVD, AMB, BHZ, TKS, SEP — emails dos gerentes.
- **Alerta usa Gmail OAuth do operador do card** (`responsavel_relacionamento`). Se o operador não tem Gmail conectado, alerta vai falhar — logado em `alertas_sla_oc21_oc14.status='falhou' + motivo_falha`.

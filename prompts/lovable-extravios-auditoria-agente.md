# Lovable — AUDITORIA: seção "Agente de extravio (oc 49 automática)" + Reportar erro

## Contexto
O agente autônomo de extravios lança a oc 49 sozinho (ou recomenda / não roda). Toda
ação dele precisa aparecer na aba AUDITORIA, **separada por operador** — cada operador
vê só as ações dos cards dele (o RLS já garante isso; as views são `security_invoker`).

## O que adicionar

### 0. FILTRO "EXTRAVIOS LANÇADOS AUTÔNOMOS" na aba AUDITORIA (cards_auditoria)

A aba AUDITORIA já lê `cards_auditoria` (snapshots de ações autônomas — hoje oc13/oc56).
Os lançamentos da oc 49 pelo agente de extravio agora também entram lá, com
`motivo = 'extravio_oc49_autonomo'`. **Adicionar um filtro/aba "EXTRAVIOS LANÇADOS
AUTÔNOMOS"** que mostra SÓ esses:

```
SELECT * FROM cards_auditoria WHERE motivo = 'extravio_oc49_autonomo' ORDER BY added_at DESC
```

Isso isola os extravios autônomos dos outros casos (oc13 = `motivo LIKE 'oc13_%'`,
oc56 = `'oc56_%'`). O RLS de `cards_auditoria` já foi corrigido pra isolar por operador.
Cada snapshot tem `nf`, `ctrc`, `empresa_cliente`, `state_no_snapshot`, e o
`card_snapshot`/`todos_snapshot`/`events_snapshot` (timeline congelada do lançamento).

### 1. Seção "🤖 Agente de extravio (oc 49 automática)" na aba AUDITORIA

**Track-record (contador) — fonte: view `v_agente_extravio_metricas`**
Colunas: `operador`, `lancadas`, `nao_rodou`, `reportadas_erradas`, `ultima_acao`.
Mostrar como um cartão/resumo por operador (o operador logado vê a linha dele; Caio/gestor
vê todas). Ex: *"Larissa — 12 lançadas · 1 não rodou · 0 reportadas erradas"*.

**Lista de ações — fonte: view `v_agente_extravio_auditoria`**
Colunas: `card_id`, `nf`, `operador`, `event_type`, `descricao` (texto pronto em PT-BR),
`oc_achada`, `created_at`. Listar em timeline (mais recente primeiro), com a `descricao`
já formatada. Tipos de `event_type`:
- `AgenteExtravioLancou49` — agente lançou a 49 (verde/sucesso).
- `AgenteExtravioRecomendou` — recomendou, aguardando (azul/info).
- `AgenteExtravioNaoRodou` — não rodou + motivo (amarelo/atenção).
- `AgenteExtravioReportadoErrado` — alguém reportou erro (vermelho).

### 2. Botão "Reportar erro do agente"

Em cada ação do agente (na auditoria) **e** nos cards da coluna "AUTÔNOMO NÃO RODOU"
(do kanban EXTRAVIOS), adicionar um botão **"Reportar erro"**. Ao clicar, abre um campo
de texto (motivo, opcional) e chama:

```js
const { data, error } = await supabase.rpc('reportar_erro_agente_extravio', {
  p_card_id: card_id,
  p_motivo: motivoDigitado || null
});
```

A RPC registra o report (vira `AgenteExtravioReportadoErrado`) e entra na contagem de
`reportadas_erradas`. Isso é a rede de segurança: se o agente errar, o operador/Caio
sinaliza e o Caio pode pausar o autônomo.

## Importante
- Usar `supabase.rpc(...)`, não fetch direto (sua convenção).
- Não filtrar por operador no front — o RLS das views já isola.
- As views são read-only; a única escrita é via a RPC `reportar_erro_agente_extravio`.

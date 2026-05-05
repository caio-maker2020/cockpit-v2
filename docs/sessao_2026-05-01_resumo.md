# Resumo da sessão — 2026-05-01

Sessão focada em (1) reforço de infraestrutura, (2) automação de cobrança
end-to-end, (3) UX dos cards com múltiplas opções de ação.

---

## 1. Infraestrutura e saúde do sistema

### Análise de fragilidades

Mapeei 5 fragilidades reais antes da escala. Atacamos as 3 prioritárias.

### Migrations versionadas

- **Tabela `public.schema_migrations`** rastreia toda migration aplicada (filename + sha256 + applied_at + applied_by + duration_ms)
- **Script [`scripts/apply_migrations.py`](../scripts/apply_migrations.py)**: lê `migration/*.sql` em ordem, aplica só pendentes, detecta drift via sha256, é idempotente
- Baseline registrou as 30 migrations existentes
- Daqui pra frente: toda mudança no banco passa por arquivo + `python3 scripts/apply_migrations.py`

### Alerting básico

- **Edge Function `health-check`** rodando a cada 5min via cron
- 6 verificações: cron com falhas, sync parado, pgmq acumulada, cards travados, executor erro, vinculador erro
- **Email via Postmark** pra `caio@salexpress.com.br` quando algo está errado
- **Cooldown de 1h** por (tipo, chave) — evita inundar caixa
- **Resumo diário** às 8h BRT confirmando "tudo verde nas últimas 24h"
- Headers anti-spam (`Auto-Submitted`, `Precedence`, HtmlBody) — pendente DKIM no DNS pra resolver definitivo

### Sync-bastao mais rápido

- Cron antes: `*/5 * * * *` (5min)
- Cron agora: `*/2 * * * *` (2min)
- Latência média entre Bastão atualizar e Cockpit refletir caiu de ~150s pra ~60s
- RPC `minutos_desde_ultimo_sync_bastao` agora usa `LIKE 'sync-bastao-every-%'` (tolera renames futuros)

---

## 2. Automação de cobrança

### Brainstorm e decisões

| Pergunta | Decisão MVP | Decisão futura |
|---|---|---|
| Texto do email | Templates fixos | IA com voz da Larissa |
| "Cliente respondeu?" | Qualquer msg = respondeu | IA interpreta conteúdo (Opção B) |
| Janela | 4 dias corridos | — |
| Contatos | Lista variável (1+ emails, 1+ wpp) | — |
| Resposta inconclusiva | Larissa marca manual | IA detecta + re-cobra |
| Auto-reply de férias | Sistema tenta secundário; sem 2º → volta Larissa | — |

### Schema novo (migration 035)

- **`contatos_cliente`**: emails/whatsapp/dominio por cliente, com `ordem` (preferência) e `tipo_uso` (geral/cobranca/logistico/financeiro/comercial)
- **`templates_email`**: templates reutilizáveis com placeholders `{chaves}` (stubs FALTA_DE_VOLUME, COBRANCA_LEMBRETE, RECUSA_TOTAL inativos até Larissa preencher)
- **`acoes_agendadas`**: relógio das ações futuras (cobrança_email)

3 RPCs: `cancelar_acoes_agendadas_do_card`, `agendar_cobranca_email`, `resolver_email_cobranca_cliente`.

### Edge Functions atualizadas/criadas

- **`processar-acoes-agendadas`** (nova): cron diário 9h BRT cria propostas de re-cobrança quando passa 4 dias sem resposta
- **`vinculador`**: cliente responde em card `AGUARDANDO_CLIENTE` → move pra `AGUARDANDO_VALIDACAO_HUMANA` com lock + cancela cobranças agendadas
- **`enviar-resposta`**: ao enviar email com sucesso, agenda cobrança em D+4
- **`sync-bastao`**: nova lógica `state_pelo_bastao()` (responsavel_atual primário, dicionário fallback) + regras múltiplas (oc=10/20/49/54)
- **`executor`**: tool composto `lancar_oc_e_enviar_email` (lança oc + renderiza template + enfileira email)

### 3 documentos pra Larissa preencher (.docx prontos)

| Documento | Pra que serve |
|---|---|
| [Templates-Email-Larissa.docx](exports/Templates-Email-Larissa.docx) | 4 templates fixos (FALTA_DE_VOLUME, ENDEREÇO_INCORRETO, PROBLEMA_DOCUMENTAÇÃO, COBRANÇA_SEM_RETORNO) |
| [Contexto-Pergunta-Original-IA.docx](exports/Contexto-Pergunta-Original-IA.docx) | Pra construir Opção B futuro (IA interpreta resposta) |
| Planilha existente (`Contatos-Clientes-Larissa.xlsx`) | Larissa adiciona 2 colunas: `ordem` + `tipo_uso` |

### Script de import

- **[`scripts/import_contatos_cliente.py`](../scripts/import_contatos_cliente.py)** lê a planilha e popula `contatos_cliente`. Roda quando Larissa entregar.

---

## 3. UX dos cards — múltiplas opções de ação

### Catálogo de regras `REGRAS_AUTO_ACAO`

| Oc atual | Propostas criadas | State pós-proposta |
|---|---|---|
| **20** (Extravio localizado) | 1: lançar 55 | AGUARDANDO_VALIDACAO_HUMANA + lock |
| **10** (Recusa total) | 1: lançar 54 + email RECUSA_TOTAL | AGUARDANDO_VALIDACAO_HUMANA + lock |
| **49** (Tratativa relacionamento) | 1: lançar 54 + email FALTA_DE_VOLUME | AGUARDANDO_VALIDACAO_HUMANA + lock |
| **54** (Aguardando cliente) | **2**: lançar 21 + lançar 55 | continua AGUARDANDO_CLIENTE (sem lock) |

### RPCs ajustadas (migration 038)

- **`aprovar_e_executar`**: ao aprovar 1 todo, **cancela outros pendentes** do mesmo card (evita executar 2 ações)
- **`voltar_para_to_do`**: cancela **todos** os pendentes do card
- **`marcar_retorno_inconclusivo`**: cancela todos pendentes + reagenda cobrança D+4 (botão "Voltar p/ Aguardando Cliente")

### Decisão UX importante: Rejeitar removido

- Botão **Rejeitar foi descontinuado** de toda a plataforma
- Saída de emergência única: **"Voltar p/ To-Do"** (destrava lock, vai pra PARA FAZER, mantém propostas pra aprovação posterior)
- Função `rejeitar_acao` continua no banco, só não é mais chamada pelo frontend

### Prompt do Lovable

[prompts/lovable-cards-acoes.md](../prompts/lovable-cards-acoes.md) — 3 mudanças apenas:

1. Remover botão Rejeitar
2. Card **AGUARDANDO VALIDAÇÃO HUMANA**: N botões dinâmicos + universais (Voltar p/ To-Do, Voltar p/ Aguardando Cliente quando aplicável)
3. Card **AGUARDANDO CLIENTE**: N botões dinâmicos (sem universais) + indicador "Cobrança automática em N dias"

---

## Estado atual do banco (validado em produção)

| Coluna Kanban | Cards | Detalhe |
|---|---|---|
| AGUARDANDO_CLIENTE | 34 | Cada um com **2 todos pendentes** (lançar 21 + lançar 55) |
| AGUARDANDO_VALIDACAO_HUMANA | 1 | oc=20 com 1 todo (lançar 55) |
| AGUARDANDO_AGENTE (PARA FAZER) | 7 | Cards oc=8/10/11/23/43/49 (alguns sem proposta porque template inativo) |
| TRANSFERIDO | 20 | Saíram do escopo |
| EXECUTANDO_ACAO | 4 | IA executando |

---

## Migrations criadas hoje

| # | Arquivo | Resumo |
|---|---|---|
| 032 | schema_migrations | Tabela de versionamento |
| 033 | alertas_e_health | health-check + cron |
| 034 | sync_bastao_2min | reduz cron pra 2min |
| 035 | automacao_cobranca | contatos_cliente + templates_email + acoes_agendadas + RPCs |
| 036 | cron_processar_acoes | cron diário 9h BRT |
| 037 | marcar_retorno_inconclusivo | RPC pra "Voltar p/ Aguardando Cliente" |
| 038 | multi_propostas_e_rpcs | aprovar_e_executar / voltar_para_to_do / marcar_retorno cancelam todos pendentes |

---

## Edge Functions deployadas hoje

| Function | Mudanças |
|---|---|
| **health-check** (nova) | 6 checks + email Postmark |
| **processar-acoes-agendadas** (nova) | Cron diário processa cobranças vencidas |
| **sync-bastao** | REGRAS_AUTO_ACAO multi-proposta + manter_state + state_pelo_bastao + normalizeNf |
| **vinculador** | Resposta cliente em AGUARDANDO_CLIENTE → VALIDACAO_HUMANA + lock |
| **enviar-resposta** | Agenda cobrança D+4 |
| **executor** | Tool composto `lancar_oc_e_enviar_email` |

---

## O que falta pra ativar 100% (ordem)

1. **Caio cola [prompts/lovable-cards-acoes.md](../prompts/lovable-cards-acoes.md)** no Lovable e valida UI
2. **Caio adiciona 2 colunas** na planilha de Larissa (`ordem`, `tipo_uso`)
3. **Larissa entrega:**
   - Planilha de contatos completa → eu rodo `import_contatos_cliente.py`
   - `Templates-Email-Larissa.docx` preenchido → eu rodo `UPDATE templates_email SET ativo=true`
   - `Voz-Larissa-Questionario.docx` → calibro redator (não bloqueante)
4. **Caio configura DKIM/Return-Path** do `salexpress.com.br` no Postmark (resolve spam dos alertas)
5. **Caio passa senha temporária da Larissa** via canal seguro (`Cockpit-GSDkSLU0DppH`)
6. **Segunda 2026-05-04 — go-live**:
   - Larissa configura forward Gmail → Postmark inbound
   - Flag `ENVIO_DESABILITADO=false`
   - Teste E2E
   - Larissa começa a operar

---

## Decisões importantes salvas em memória

- **Não presumir escopo**: antes de consolidar/refazer artefato, sempre listar bullets do escopo e pedir confirmação
- **Eu faço deploys**: rodo `supabase functions deploy` direto, não dou instrução
- **Postmark escala multi-operador**: 1 server único + N Sender Signatures (não criar Postmark novo por operador)
- **Playbook onboarding operador**: passo-a-passo padrão pra adicionar operador novo (clientes, processo, voz, auth, infra)

---

## Cronograma de jobs do Cockpit

| Job | Intervalo | Horários |
|---|---|---|
| triador / vinculador / executor | 1 min | a cada minuto |
| **sync-bastao** | **2 min** | `:00, :02, :04...` |
| health-check | 5 min | a cada 5min |
| **processar-acoes-agendadas** | diário | 12h UTC = 9h BRT |

End-to-end (lançamento SSW → Cockpit refletir): pior caso ~35min (Bastão + sync).

# AI_AUDIT_CONTEXT.md — Contexto para Auditoria Técnica Independente

> **Propósito deste documento.** Foi escrito para ser lido por outro modelo de IA (ChatGPT) que fará uma auditoria técnica profunda do sistema **Cockpit v2** da Sal Express **antes da entrada em produção**. O leitor nunca viu este projeto. O documento é deliberadamente **honesto, técnico e exaustivo**: não defende decisões passadas, não omite problemas, não simplifica. Onde há dúvida, a dúvida está explícita.
>
> **Como foi produzido.** Levantado por leitura direta do código-fonte (76 Edge Functions, 287 migrations, ~70 módulos compartilhados, 25 invariantes documentados, 9 ADRs) + 5 auditorias paralelas independentes (banco, fluxos críticos, integrações externas, autenticação/segurança, testes/regras/agentes). Todas as afirmações citam `arquivo:linha` quando possível.
>
> **Aviso sobre o caminho do projeto.** A raiz do repositório tem espaço e dois-pontos no nome: `/Users/caiodevasconcelos/Documents/:code:cockpit-v2 /cockpit-v2-starter`. Todos os caminhos abaixo são relativos a essa raiz.
>
> **Aviso sobre divergência docs × código.** Vários documentos do repositório (`docs/ARCHITECTURE.md`, `docs/STATE_MACHINE.md`, `docs/AGENTS.md`, `docs/DATA_MODEL.md`, `evals/baseline.md`, partes do `CLAUDE.md`) **descrevem um sistema idealizado que divergiu da realidade**. O sistema real evoluiu por dezenas de incidentes de produção. **Audite pelo código, não pelos docs.** As divergências concretas estão listadas na Seção 12 (Hipóteses Frágeis) e na Seção 11 (Bugs/Inconsistências).

---

## 1. Resumo Executivo

### 1.1 Objetivo do projeto

Sistema de **agentes de IA autônomos** que tratam ocorrências de carga (Notas Fiscais) na **Sal Express**, uma transportadora B2B rodoviária que opera em Minas Gerais e Espírito Santo. O paradigma é: **o agente decide e age, o operador valida** (em vez de o operador executar manualmente). Meta de produto declarada (PRD §6): chegar a **70% das ocorrências SSW lançadas sem operador** em 12 meses, mantendo ou reduzindo o time de ~10 operadores.

É a evolução do "Cockpit v1" (Lovable + Supabase), que só ajudava a ler/classificar e não agia.

### 1.2 Problema que resolve

O time de Relacionamento recebe **centenas de mensagens/dia** (WhatsApp + e-mail) sobre cargas em andamento (atraso, reentrega, devolução, avaria, extravio, inversão, recusa). Hoje cada operador: (1) lê a mensagem e identifica NF + problema; (2) consulta o TMS (SSW) para entender o estado da carga; (3) lança a ocorrência no SSW e responde o cliente. É trabalho repetitivo, governável por regras + contexto. O Cockpit v2 automatiza a decisão e a execução, deixando o humano como validador.

### 1.3 Público-alvo

**Uso interno, single-tenant, da Sal Express.** Não é multi-tenant, não há ambição de venda (ADR 0003). Usuários: ~10 operadores de Relacionamento (validam ações), 1–2 gestores (Caio + Isadora — configuram regras, calibram, auditam). O frontend ("Cockpit") é construído em **Lovable** e **não está neste repositório** — este repo é o **backend** (Supabase + Edge Functions). Sem equipe de dev dedicada: o sistema é construído por **Caio + Claude Code** (PRD §7).

### 1.4 Estado atual do desenvolvimento

**Ambíguo e contraditório entre fontes.** O `README.md:52` ainda diz "Fase 0 — fundação". A realidade do código contradiz frontalmente: o sistema está **rodando em produção, processando NFs reais, com agentes autônomos lançando ocorrências no SSW**, e dezenas de incidentes de produção já foram corrigidos (NFs reais citadas em ~25 invariantes e dezenas de memórias). Ou seja: **o sistema já está em produção de fato** e esta auditoria é, na prática, um *hardening* retroativo, não um gate pré-lançamento.

Sinais concretos de que está em produção: cron jobs ativos (`pg_cron`), cards reais sendo movidos, e-mails reais sendo enviados via Gmail OAuth de operadoras reais (Larissa, Duilio, Julia, Camila, Victor), onboarding de operadoras datado (2026-06-24/25), incidentes com timestamp e NF.

### 1.5 O que já funciona

- **Pipeline de ingestão** (WhatsApp/e-mail → card): `ingestor` → `triador` (LLM) → `vinculador` → card.
- **Sync do Bastão** (espelho de pendências SSW → cards): `sync-bastao` (cron), com máquina de estados rica.
- **Lançamento de ocorrência no SSW** via portal interno (opção 101) com **idempotência forte** (`acoes_executadas_ssw` UNIQUE) e **guard "tripé"** (valida CTRC+NF+localização antes do submit).
- **Resposta de cliente → propostas determinísticas** (sem depender de LLM, INV-016).
- **3 agentes autônomos** que lançam ocorrência sem humano (extravio D+4, ressarcimento relançar-54, oc13), atrás de feature flags (2 deles).
- **Aba EXTRAVIOS** (kanban D1–D5), **auditoria por operador**, **cobrança escalonada** (WhatsApp/e-mail), **painel admin** de credenciais.
- **RLS por carteira/segmento** para isolar visibilidade entre operadores.
- **~169 testes unitários** de funções puras (guards de regressão de bugs recentes).

### 1.6 O que ainda falta (lacunas estruturais)

- **Zero CI/CD.** Nenhum `.github/workflows`, nenhum pre-commit, nenhum runner configurado. Testes rodam à mão (`deno test`).
- **Zero eval de IA.** `evals/` contém só um spec (`baseline.md`); `bun run evals` (citado no CLAUDE.md) não existe.
- **Zero teste nos 2 módulos mais críticos e irreversíveis** (`sync-bastao` 4081 linhas; `executor` 2902 linhas; envelope SSW; guard tripé).
- **Sem retry/timeout em várias integrações críticas** (Anthropic sem retry e sem timeout; Gmail sem timeout; Bastão sem timeout).
- **Furos de autorização** (escalação de privilégio a gestor; endpoints sensíveis sem auth).
- **Sem cost tracking em dólar** da API Anthropic.
- **Sem ambiente de staging** evidente — migrations aplicadas direto em produção.

### 1.7 Principais riscos atuais (resumo — detalhe nas Seções 13/20)

1. **Lançamento de ocorrência no SSW depende de scraping de HTML** com detecção de sucesso por *ausência de palavra de erro* (frágil; já gerou falso-positivo — NF 424475).
2. **Guard "tripé" é fail-OPEN no componente de localização** — se o SSW mudar o markup da localização, a checagem mais importante (não lançar em CTRC entregue/baixado) é silenciosamente pulada.
3. **`sync-bastao` (4081 linhas) sem mutex de execução** + deadline cooperativo que pode pular as passes que liberam cards travados.
4. **Escalação de privilégio**: operador comum pode se tornar `gestor` via UPDATE direto (RLS sem `WITH CHECK`).
5. **Anthropic sem retry/timeout**: um 529 da Anthropic já derrubou o triador e perdeu 13 respostas de cliente no dead_letter (INV-016).
6. **Refresh tokens Gmail em texto plano**, legíveis por qualquer operador via RLS frouxa.
7. **Documentação divergente do código** — parte das garantias existe só "na cabeça"/em commits antigos.

---

## 2. Arquitetura Geral

### 2.1 Stack

| Camada | Tecnologia | Observação |
|---|---|---|
| Frontend (Cockpit do operador) | **Lovable** | **Fora deste repositório.** Expõe a anon key do Supabase no browser. |
| Banco / Auth / Realtime / Filas / Cron | **Supabase** (Postgres + pgmq + pg_cron + Edge Functions) | 1 provedor só (ADR 0001). |
| Runtime das funções | **Deno / TypeScript** (Edge Functions) | 76 funções em `supabase/functions/`. |
| LLM | **Anthropic Claude** via SDK direto (sem LangChain) | Modelos: Haiku 4.5, Sonnet 4.6, Opus 4.7 (declarados). |
| WhatsApp | **Evolution API** (Railway/VPS) | 1 instância por operador. |
| E-mail saída | **Gmail API** (OAuth por operadora) — `Resend` está na stack mas **não é o caminho ativo** | Atômico com o lançamento de oc=54. |
| E-mail entrada | **Gmail poll** (cron 5min) + Postmark inbound (na stack, **inbound não verificado**) | `gmail-poll-inbox`. |
| TMS | **SSW** (sistema legado) via **scraping do portal web interno** (opção 101) | Não há API REST estável; o cliente faz navegação HTTP forms. |
| Pendências | **Bastão** (Supabase **externo** da Sal Express) | Espelho do relatório SSW de NFs vencidas. Read-only via PostgREST + anon key. |

### 2.2 Organização de camadas e pastas

```
cockpit-v2-starter/
├── supabase/functions/          # 76 Edge Functions (backend de produção)
│   ├── _shared/                 # ~70 módulos compartilhados (clients, regras, parsers)
│   └── <fn>/index.ts            # cada função
├── lib/                         # clients/regras "puras" — PARCIALMENTE ÓRFÃO / fork stale (ver 14.4)
├── migration/                   # 287 arquivos SQL versionados por data (sem ferramenta nativa)
├── prompts/                     # 121 .md — 117 são prompts pro Lovable (front), 4 são de IA
├── evals/                       # só baseline.md (spec) — runner NÃO existe
├── docs/                        # PRD, ARCHITECTURE, INVARIANTES (vivo), AGENTS/STATE_MACHINE (stale)
│   └── decisions/               # 9 ADRs
├── scripts/                     # apply_migrations.py (runner próprio) + imports Python
├── data/, deploy/, vercel-*/    # datasets, deploy Evolution, apps Vercel (OAuth callback, evidência)
├── CLAUDE.md                    # contexto/convenções (parcialmente divergente do código)
└── .env.local / .env.example    # segredos (local, gitignored) / template (desatualizado)
```

**Responsabilidades dos módulos `_shared/` mais importantes** (ver Seção 9 para a lista completa):
- `ssw-internal-client.ts` (2171 L) — todo o scraping do portal SSW (login, busca NF, fotos, lançamento).
- `lancar-ssw-portal.ts` (349 L) — "envelope" de lançamento: idempotência + tripé + conta de serviço.
- `validar-tripe-ssw.ts` (230 L) — guard que valida CTRC+NF+localização antes do submit.
- `regras-auto-acao.ts` (1311 L) — motor de regras de negócio (oc → ação proposta).
- `bastao-rules.ts` — mapa oc → state final (carregado do dicionário em cold start).
- `bastao-client.ts` — leitura do Bastão (pendências + frescor).
- `anthropic-client.ts`, `gmail-sender.ts`, `gmail-reader.ts`, `evolution-outbound.ts` — adapters.
- `propostas-pos-resposta-cliente.ts` — fonte única determinística de propostas pós-resposta.

### 2.3 Comunicação entre componentes

- **Filas duráveis (pgmq):** `agent_intake`, `agent_specialist`, `agent_executor`, `scan_email_pre_card`, e uma fila `dead_letter` (DLQ). Cada etapa consome de uma fila e publica na próxima.
- **Chaining edge-to-edge:** `_shared/invoke-next.ts` faz *fire-and-forget* HTTP de uma função para a próxima (baixa latência), com **cron como rede de segurança** (não há retry no invoke em si).
- **Crons (pg_cron):** disparam triador, vinculador, sync-bastao, gmail-poll, agentes autônomos, reconciliadores, health-check.
- **Event sourcing:** toda mudança de estado de card é um evento em `card_events` (append-only, imutável por trigger); `cards` é a **projeção**.

### 2.4 Diagrama da arquitetura (fluxo REAL, baseado no código)

```
ENTRADA A: WhatsApp/Postmark/manual      ENTRADA B: E-mail resposta cliente       ENTRADA C: Bastão (espelho TMS)
   │ webhook HTTP (sem auth)                │ Gmail API poll (cron 5min)              │ pg_cron (30min? 5min? — INCERTO)
   ▼                                        ▼                                         ▼
ingestor                                 gmail-poll-inbox                          sync-bastao (4081 L)
  INSERT messages_inbox (sem UNIQUE)       lookup card por thread→NF+domínio          deadline cooperativo ~110s
  enqueue pgmq agent_intake                INSERT messages_inbox + enqueue            SEM mutex de run (overlap possível)
  invokeNext(triador)                      surfar→scan_email (dedup mig 276)          Passes seriais A→B→C→D→(E/F dead)→G→H
   │                                        │                                          A: importa pendência→cria/reabre card
   ▼                                        ▼                                          B: solta card fora-de-escopo (confirma SSW)
  pgmq agent_intake ◄─────────────────────-┘                                          C: confirma/timeout todos executando
   │                                                                                   D: aviso_alteracao_oc (visual)
   ▼                                       pgmq scan_email_pre_card (cron 2min)         G/H: liberam ACAO_EXECUTADA ★
  triador (cron 1min, Sonnet) ★LLM gate★   scan-email-pre-card                          │
   classifica + extrai NF/CTRC              cria propostas DETERMINÍSTICAS (sem LLM)    ▼
   529 → retry; >=3 → dead_letter ☠         (INV-016 garantido aqui)                 cards (projeção) + card_events
   │                                                                                  agentes autônomos varrem cards:
   ▼                                                                                   • agente-extravio-d4 (flag, oc 49)
  pgmq agent_specialist                                                                • ressarcimento-relancar-54 (flag, oc 54)
   │                                                                                   • oc13-autonomo (SEM flag boolean! oc 21)
   ▼                                                                                   • sugere-ocs-padrao (só propõe)
  vinculador (cron 1min)
   6 prioridades de dedup → anexa/cria card
   cria todos/propostas
   │
   ▼
  cards.state = AGUARDANDO_VALIDACAO_HUMANA (+ lock)   ──aparece no Lovable──►  OPERADOR aprova
   │                                                                                  │
   │                          auto_aprovar_e_executar (RPC SECURITY DEFINER) ◄────────┘
   │                          (agentes autônomos chamam ESTE MESMO RPC sem humano)
   ▼
  pgmq agent_executor
   │
   ▼
  executor (2902 L) — god-function processOne (~1200 L)
   email PRIMEIRO (idempotente por todo_id) → oc DEPOIS
   │
   ▼
  ENVELOPE lancar-ssw-portal.ts
   1. INSERT acoes_executadas_ssw sucesso=null  (idempotência ANTES do SSW)
   2. login conta de serviço ai.salex + buscarNFInterno(ctrc do card)
   3. lancarOcorrenciaPortal → callback validarTripeCtrcNfPagador (HTML do act=O)
      (a) CTRC == card.ctrc   [fail-CLOSED]
      (b) NF == card.nf        [fail-CLOSED]
      (c) localização ∉ {ENTREGUE,BAIXADO,...}  [★fail-OPEN se a label sumir★]
   4. submit act=II3 em latin-1 (iso-8859-1)   [★sem try/catch — AbortError vaza★]
   5. UPDATE sucesso=true
   │
   ▼
  card → AGUARDANDO_CLIENTE | ACAO_EXECUTADA | RESOLVIDO
   └─ confirmar-acao-executada-ssw (best-effort) + Pass G/H confirmam depois

DLQ: pgmq "dead_letter". reprocessar-dlq ressuscita só msgs <60min e <4 tentativas;
     SEM cron próprio (invokeNext via cron-ia-resposta-pendentes).
```

---

## 3. Fluxos Críticos

Para cada fluxo: objetivo · entrada · processamento · saída · dependências · arquivos · possíveis falhas.

### Fluxo 1 — Ingestão de mensagem → card
- **Objetivo:** transformar mensagem de cliente (WhatsApp/e-mail) em card ou anexá-la a um card existente.
- **Entrada:** webhook `ingestor` (WhatsApp/Postmark/manual) **ou** `gmail-poll-inbox` (cron 5min lendo as caixas das operadoras).
- **Processamento:** `ingestor` insere em `messages_inbox` e enfileira `agent_intake`; `triador` (LLM Sonnet, cron 1min) classifica tipo + risco e extrai NF/CTRC; `vinculador` aplica 6 prioridades de dedup e anexa/cria card.
- **Saída:** card em `AGUARDANDO_VALIDACAO_HUMANA` com propostas, ou `cliente_respondeu_em` setado.
- **Dependências:** Anthropic (triador), pgmq, Gmail API.
- **Arquivos:** `ingestor/index.ts`, `triador/index.ts`, `vinculador/index.ts` (1229 L), `gmail-poll-inbox/index.ts` (898 L), `scan-email-pre-card/index.ts` (796 L), `_shared/scan-email-enqueue.ts`.
- **Possíveis falhas:** **(1)** o triador (LLM) é gate obrigatório de TODA mensagem — um 529 da Anthropic 3x manda a mensagem ao `dead_letter` e quebra a visibilidade da resposta do cliente (INV-016, NF 761583). **(2)** `messages_inbox` **não tem UNIQUE** em `message_id_header` (`migration/2026-04-29_001_initial_schema.sql:167`; índice não-único em mig 046:22) → webhook reentregue duplica a linha → fluxo "cliente respondeu"/IA roda 2x. **(3)** dedup do gmail-poll é check-then-insert sem lock (`gmail-poll-inbox/index.ts:545-556`).

### Fluxo 2 — Sync do Bastão → cards (o coração e o maior risco)
- **Objetivo:** espelhar as pendências do SSW (via Bastão) em cards, criando/reabrindo/movendo/resolvendo.
- **Entrada:** Bastão (Supabase externo) via cron.
- **Processamento:** `sync-bastao` roda **Passes seriais A→H** com deadline cooperativo (~110s). `upsertCardFromPendencia` (`sync-bastao/index.ts:1411-2641`, **~1237 linhas numa função**) é uma árvore de ~9 ramos mutuamente exclusivos, cada um carregando patches de incidentes (cada bloco cita uma NF-âncora).
- **Saída:** cards criados/movidos + `card_events`.
- **Dependências:** Bastão (sem timeout), SSW interno (em alguns ramos), `bastao-rules.ts`, `escopo-relacionamento.ts`, `lag-lancamento-54.ts`.
- **Arquivos:** `sync-bastao/index.ts` (4081 L).
- **Possíveis falhas:** **(1)** Pass A não tem deadline-check no main-loop (`:876-914`) → se o pull for grande, A come o orçamento e **B–H não rodam**; como **G/H são as únicas passes que liberam `ACAO_EXECUTADA`**, cards podem ficar presos com latência indefinida (sem TTL). **(2)** **ZERO mutex de run-level** (nenhum advisory lock) → duas runs do cron podem se sobrepor e fazer double-write read-modify-write não-transacional + eventos duplicados. **(3)** Bastão sem timeout pendura o sync (já regrediu por timeout de 150s). **(4)** Passes E/F são **código morto** (NO-OP desde 2026-06/08).

### Fluxo 3 — Proposta de ação → validação humana → execução no SSW
- **Objetivo:** lançar a ocorrência correta no SSW com segurança (regra-mãe: nunca lançar em CTRC errado/encerrado).
- **Entrada:** aprovação do operador (1 clique no Lovable) **ou** agente autônomo.
- **Processamento:** `auto_aprovar_e_executar` (RPC `SECURITY DEFINER`) marca o todo aprovado e enfileira `agent_executor`; `executor` (god-function) envia e-mail primeiro (idempotente por `todo_id`) e lança a oc depois via **envelope** `lancarSswPortal`; o envelope insere `acoes_executadas_ssw` (idempotência) **antes** do submit, faz login na conta de serviço `ai.salex`, valida o tripé com o HTML do `act=O` e só então submete (em latin-1).
- **Saída:** oc lançada + card movido (AGUARDANDO_CLIENTE / ACAO_EXECUTADA / RESOLVIDO).
- **Dependências:** SSW interno, Gmail (e-mail), Postgres.
- **Arquivos:** `executor/index.ts` (2902 L), `_shared/lancar-ssw-portal.ts`, `_shared/validar-tripe-ssw.ts`, `_shared/ssw-internal-client.ts`, `_shared/confirmar-acao-executada-ssw.ts`.
- **Possíveis falhas:** **(1)** tripé (c) localização é **fail-OPEN** (`validar-tripe-ssw.ts:122` — `if (localizacao)`); se só o regex da localização quebrar, a função retorna `ok:true` e lança em CTRC possivelmente ENTREGUE/CANCELADO. **(2)** o submit `act=II3` **não tem try/catch** (`ssw-internal-client.ts:1346-1359` + `lancar-ssw-portal.ts:268`) → timeout vira AbortError que vaza, deixando a linha `acoes_executadas_ssw` com `sucesso=null` órfã (que **trava todo relançamento daquele todo**, sem TTL); e a oc **pode ter entrado no SSW** mesmo assim. **(3)** detecção de sucesso é **heurística por ausência de keyword de erro** no HTML (`ssw-internal-client.ts:1408-1430`) → mensagem de erro nova do SSW → falso "sucesso". **(4)** a UNIQUE real é `(card_id, codigo_oc, ctrc, todo_id)` (mig 202), **não** `(card_id, codigo_oc, ctrc)` como o CLAUDE.md afirma → reaprovação manual gera todo novo → mesma oc/ctrc relançável.

### Fluxo 4 — Resposta do cliente → propostas
- **Objetivo:** garantir que, quando o cliente responde, o card pula para a aba certa **com os botões de ação** — sem depender de LLM (INV-016, regra inviolável).
- **Entrada:** e-mail de cliente.
- **Processamento:** propostas criadas **deterministicamente** (sem LLM) por 3 produtores independentes (`vinculador`, `scan-email-pre-card` direto, e a rede de segurança `cron-ia-resposta-pendentes`); o `interpretador-resposta-cliente` (LLM Sonnet) só **sugere** o destaque, com allowlist de ocs `{21,33,44,54,55,56}`.
- **Saída:** `cards.ia_sugestao_oc_resposta` + `todos` pendentes.
- **Arquivos:** `_shared/propostas-pos-resposta-cliente.ts` (fonte única), `interpretador-resposta-cliente/index.ts`, `responder-email-cliente/index.ts`, `cron-ia-resposta-pendentes/index.ts`, `reprocessar-dlq/index.ts`.
- **Possíveis falhas:** INV-016 é bem garantido estruturalmente (3 produtores determinísticos + DLQ + rede de segurança + watchdog). **Porém** a entrada via `gmail-poll→agent_intake` ainda depende do triador (LLM) para setar `cliente_respondeu_em` — resíduo do gate de LLM.

### Fluxo 5 — Agentes autônomos (agem sem humano)
- **Objetivo:** executar ações seguras sem validação por-card.
- **Os 3 que lançam ocorrência real no SSW sem aprovação por-card** (todos via `auto_aprovar_e_executar → executor → envelope`):
  1. **`agente-extravio-d4`** → oc 49 ("prazo de perdas expirado") em extravios ≥4 dias úteis. **Bem protegido:** 2 flags (`extravios_cockpit_enabled` + `extravios_agente_autonomo_enabled`), pré-checagem SSW (`podeAgenteLancar49` exige última oc ∈ {6,9,16}) re-validada no scan e no execute, gate de horário comercial. Off por padrão.
  2. **`agente-ressarcimento-relancar-54`** → oc 54. **Bem protegido:** 2 flags, só Tier A determinístico auto-lança (Haiku do Tier B só vira proposta), re-valida histórico SSW fresco. Off por padrão (shadow).
  3. **`agente-oc13-autonomo`** → oc 21 + cancela reentrega. **GAP: NÃO tem flag boolean de kill-switch** — depende só do allowlist `cliente_config_oc13` (vazio = off). Desligar exige editar dados, não virar uma flag.
- **Arquivos:** `agente-extravio-d4/index.ts` (343 L), `agente-ressarcimento-relancar-54/index.ts` (555 L), `agente-oc13-autonomo/index.ts` (814 L), `agente-sugere-ocs-padrao/index.ts` (1307 L, só propõe).
- **Possíveis falhas:** assimetria temporal entre a pré-checagem SSW (síncrona) e o submit (assíncrono, depois) → estado pode mudar entre a checagem e o lançamento; `oc13-autonomo` sem kill-switch rápido; classificação de foto errada pode cancelar reentrega legítima.

### Fluxo 6 — Chaining edge-to-edge e DLQ
- **Objetivo:** baixa latência entre etapas + auto-cura de mensagens presas.
- **Processamento:** `invoke-next.ts` faz fire-and-forget para a próxima função; cron é a rede de segurança. `reprocessar-dlq` ressuscita mensagens do `dead_letter` (só <60min e <4 tentativas), **sem cron próprio** (disparado por `invokeNext` dentro de `cron-ia-resposta-pendentes`, decisão tomada para evitar thundering herd de cron — causa #2 do apagão de 2026-06-23).
- **Possíveis falhas:** invoke sem retry (só cron fallback 1–5min); mensagem que ficar >60min ou >4 tentativas no DLQ **não é mais reprocessada** — perda silenciosa.

---

## 4. Regras de Negócio

O sistema é fortemente orientado a regras. Há **duas camadas** de regras: (A) o **catálogo de invariantes** (`docs/INVARIANTES_COCKPIT.md`, 25 INVs — cada um é uma regra durável nascida de um post-mortem, com comando de verificação executável); (B) o **motor de propostas** (`regras-auto-acao.ts`, mapa oc→ação).

### 4.1 Glossário mínimo (ocorrências SSW)
"Oc" = código de ocorrência do SSW. Os mais relevantes: **54** = cliente (AGUARDANDO_CLIENTE); **21** = reentrega; **33** = reversa/devolução; **44** = devolução; **49** = prazo de perdas expirado; **6/9/16** = extravio monitorado; **20** = localizado; **1/30/32** = finalizadoras; **10/19/35** = recusa; **13** = limitação do cliente. "CTRC" = conhecimento de transporte; **é a identidade do card** (não a NF — a mesma NF pode ter vários CTRCs). "Bastão" = espelho do relatório SSW de NFs vencidas.

### 4.2 Catálogo de invariantes (resumo — fonte: `docs/INVARIANTES_COCKPIT.md`)

Cada INV tem: regra · arquivos · comando de verificação · memória/ADR · cenário real (NF).

| INV | Regra (resumo) | Arquivos-chave | Impacto se violado / risco de regressão |
|---|---|---|---|
| **001** | Bastão é INPUT; SSW interno é SAÍDA. Tracking público deprecado. | todos os que decidem destino de card | Decisão de saída por fonte errada (latência RPA). |
| **002** | `confirmar-acao-executada-ssw` preserva snapshot Bastão pré-lançamento. | `confirmar-acao-executada-ssw.ts` | Reabertura indevida (NF 1075381). |
| **003** | Pass A `voltouParaRelacionamento` usa guard por oc do lançamento + safeguard 24h. | `sync-bastao` :706-718 | Loop de reabertura (5 NFs em loop, 2026-05-14). |
| **004** | Pass A preserva `chave_cte`, `propostas_recusadas_*`, `bastao_updated_at` no agent_state. | `sync-bastao` | Perda de cooldown/chave (NFs 422476/64409). |
| **005** | `voltar-para-to-do-com-rastreio` consulta SSW interno. | `voltar-para-to-do-com-rastreio` | Loop voltar_para_to_do (NFs 64409/422589). |
| **006** | oc=54 ⟺ AGUARDANDO_CLIENTE (salvo `cliente_respondeu_em`). | `sync-bastao`, `transicao-aguardando-cliente.ts` | 49 cards movidos errado (2026-05-12). |
| **007** | `ACAO_EXECUTADA` blindado contra Pass B. | `sync-bastao` runPassB | Card movido durante latência RPA (NFs 692021/20761). |
| **008** | `stateFinalAposBastao` é fonte única oc→state. | `bastao-rules.ts` | Transições inconsistentes entre passes. |
| **009** | Funções internas têm `verify_jwt=false` no config.toml. | `config.toml` | 401 silencioso (NFs 62870/351954). |
| **010** | `54` está em `OCORRENCIAS_DE_RELACIONAMENTO`. | `lib/bastao-rules.ts`, `_shared/bastao-rules.ts` | **49 cards AGUARDANDO_CLIENTE → TRANSFERIDO em horas** (2026-05-12). |
| **011** | Callers de evidência passam `ctrcEsperado` quando há ctrc. | `executor`, `verificar-evidencia.ts`, `sync-bastao`, `vinculador` | Evidência falso-ausente (NF 20761). |
| **012** | Consumo de evidência usa `obterTodasFotosDaOc`, nunca `obterFotoDaOc`. | `ssw-internal-client.ts` | Decisão sobre evidência incompleta (NFs 357645/355283). |
| **013** | Lançamento SSW SEMPRE pela conta `ai.salex` (`readSswLancamentoEnv`). | `ssw-internal-client.ts`, `lancar-ssw-portal.ts`, `executor` | Lançamento atribuído ao operador errado (NF 651244). |
| **014** | Card NUNCA em CONFLITOS se a oc foi lançada pelo Cockpit (2 sinais, sem gate de ciclo). | `escopo-relacionamento.ts`, `sync-bastao` | Re-flag em massa de cards confirmados (4 NFs, 2026-06-23). |
| **015** | Limite de anexos conta só `origem='outbound'`. | `limite-anexos.ts`, `upload-anexo-email` | 18 cards bloqueados para upload (NF 719250). |
| **016** | Cliente respondeu → SEMPRE visível com ações (determinístico, 3 camadas). | `propostas-pos-resposta-cliente.ts` + 5 fns | Card sem botões (NF 761583, Anthropic 529). |
| **017** | EXTRAVIO_MONITORADO ⟺ oc ∈ {6,9,16}; saída pela verdade do Bastão por NF + gate de frescor. | `extravio-routing.ts`, `reconciliar-extravios-bastao.ts`, `sync-extravios-bastao` | Cards travados na aba (NF 43973 121h). |
| **019** | AGUARDANDO_CLIENTE com oc relac ≠54 → AGUARDANDO VOCÊ (3 camadas: Pass A + sweep + watchdog). | `sync-bastao`, `health-check` | 52 cards invisíveis 5 dias (NF 175621). |
| **021** | Recusa (10/19/35) originada de extravio (6/9/16) → e-mail combinado + banner conflito. | `recusa-por-extravio.ts` | Cliente não notificado de extravio anterior. |
| **022** | Agente extravio só lança oc 49 após pré-checagem SSW (última oc ∈ {6,9,16}). | `agente-extravio-regras.ts`, `agente-extravio-d4` | Oc 49 duplicada/errada sobre carga já localizada. |
| **023** | "Oc nova vs lag do RPA" decide pela VERDADE DO SSW POR HORA, não pela data. | `lag-lancamento-54.ts`, `ssw-data-hora.ts`, `sync-bastao` | Oc nova escondida OU oc tratada re-mostrada (NF 346778). |
| **024** | Round-trip oc 54→46→49 → relança SÓ a 54 sem e-mail. | `ressarcimento-relancar-54.ts` | Cliente não notificado. |
| **025** | Assinatura/logo inline nunca é salva como anexo quando há anexo real. | `gmail-reader.ts`, `gmail-poll-inbox`, `reprocessar-anexos-mensagem` | Anexo errado para o SSW (NF 1486931). |
| **028** | Enqueue de scan_email com dedup (1 pendente/card, advisory lock) + throttle. | `scan-email-enqueue.ts`, mig 276 | Fila inflada (2.235 msgs / 88 cards, NF 721938). |

> Observação: a numeração tem lacunas (não há INV-018/020/026/027 no doc lido — algumas estão só em memórias). INV-026/027/028 aparecem nas memórias do projeto.

### 4.3 Motor de propostas — `regras-auto-acao.ts` (1311 L)
- **`REGRAS_AUTO_ACAO`** (`:63`): mapa `oc → {propostas[], rationale, manter_state?}`. Cobre **12 ocs**: `8,10,11,13,19,20,23,26,35,43,49,54`. Cada proposta carrega `codigo_ssw_proposto`, `descricao_todo`, `descricao_acao`, `enviar_email_template?`, `tool_override?`.
- **Templates de e-mail** referenciados por ID (`FALTA_DE_VOLUME`, `RECUSA_TOTAL`, `RECUSA_PARCIAL`, `PROBLEMAS_COM_ENDERECO`, `LIMITACAO_CLIENTE`) — corpos no DB (migs 169/170/173/210), não no código.
- **`proporAutoAcaoSeAplicavel`** (`:544`, ~600 L) é o **deus-função** do sistema, consumido por **16 módulos**. Acumula inline: exceção oc=13 por CNPJ, cooldown de 10min pós-recusa, `manter_state` vs adição incremental vs AVH, dedup por código com a exceção "sem_email_explicito não suprime +email". **Alto acoplamento, ~8 incidentes empilhados na mesma função, só 8 testes cobrindo 2 caminhos.**

### 4.4 Regras espalhadas / hardcoded (risco de divergência — ver Seção 14)
- **`{6,9,16}` (extravio)** duplicado em **6 lugares** com nomes diferentes (`agente-extravio-regras.ts:7`, `extravio-routing.ts:23`, `extravio-enrichment.ts:14`, `regras-auto-acao.ts:1190`, `atualizar-card-via-portal-ssw/index.ts:75`, `agente-sugere-ocs-padrao/index.ts:953`).
- **`{1,30,32}` (finalizadoras)** duplicado em **6 lugares** (`bastao-rules.ts:131`, `sync-bastao:687`, `agente-monitor-efetividade-ai:34`, `transicao-aguardando-cliente.ts:30`, `email-threading.ts:132`).
- **"ocs de relacionamento" tem 3 definições DIVERGENTES** (risco concreto): `lib/bastao-rules.ts:17` (estático `{3,8,10,11,17,19,20,23,26,28,35,43,49,54,57}`), `_shared/bastao-rules.ts` (runtime do DB), e `webhook-ssw-ocorrencias/index.ts:43` (`{10,11,13,19,20,21,26,33,35,41,44,49,54,55,56}` — **lista totalmente diferente**).

---

## 5. Banco de Dados

> Fonte: auditoria de 287 migrations + `docs/DATA_MODEL.md` (que está **gravemente desatualizado** — documenta ~12 de ~62 tabelas). Critérios da skill `supabase-postgres-best-practices` aplicados.

### 5.1 Tabelas principais (~62 em `public` + 8 em `legacy.*` read-only)

| Tabela | Propósito | Colunas-chave |
|---|---|---|
| `card_events` (mig 001:103) | **Fonte da verdade** — append-only, imutável por trigger | `card_id`, `event_type`, `payload jsonb`, `actor_type`, `created_at` |
| `cards` (mig 001:44) | Projeção do agregado | `nf`, `ctrc`, `state` (CHECK 14 estados), `agent_state jsonb`, `assigned_operator_id`, `pagador`, `segmento_codigo`, `cod_ultima_ocorrencia`, `bastao_oc_no_lancamento` |
| `audit_log` (mig 001:212) | Efeitos externos (SSW/Evolution/Gmail) | `idempotency_key text NOT NULL UNIQUE`, `external_system`, `status` |
| `acoes_executadas_ssw` (mig 194) | **Idempotência de lançamento SSW** | `UNIQUE(card_id, codigo_oc, ctrc, todo_id)` (mig 202), `sucesso bool` |
| `operadores` (mig 001:13) | Papel + carteira + **`gmail_oauth_credentials jsonb`** | `user_id UNIQUE`, `papel CHECK(operador/gestor)`, `carteira text[]`, `segmentos` |
| `tracking_credentials` (mig 011) | Senhas SSW em **plaintext** (deprecada mig 093) | `documento PK`, `senha text` |
| `clientes` / `contatos_cliente` | PII de clientes (CNPJ, e-mail, telefone) | RLS por carteira (mig 100) |
| `email_anexos` (mig 063) | Metadados de anexo (storage privado) | `card_id`, `storage_path`, `origem`, `deletado_em` |
| `todos` (mig 001:249) | Ações propostas aguardando validação | `card_id`, `status`, `proposta_payload jsonb` |
| `agent_runs` (mig 001:186) | Telemetria de agente (tokens) | `model`, `tokens_in/out`, `status`, `duration_ms` |
| `messages_inbox`, `pendencias`, `feature_flags`, `ocorrencias_dicionario`, `cards_auditoria`, `dead_letter`, `schema_migrations` | infra | — |

### 5.2 Relações / FKs
- `card_events.card_id → cards.id ON DELETE RESTRICT` (protege a fonte da verdade).
- `cards.last_event_id → card_events.id DEFERRABLE INITIALLY DEFERRED` (ciclo card↔evento — bem feito).
- Cascatas: `pendencias`, `todos`, `agent_runs`, `email_anexos`, `acoes_executadas_ssw` → `cards.id ON DELETE CASCADE`. `cards.assigned_operator_id → operadores.id ON DELETE SET NULL`.
- **Imutabilidade de eventos** garantida por triggers `card_events_no_update`/`no_delete` (mig 001:127-133) — vale até contra service_role.

### 5.3 Índices
- **Bem feito:** `cards` tem ~30 índices, a maioria **parciais** (`WHERE ... pendente/IS NOT NULL`); mig 223:33 usa `CREATE INDEX CONCURRENTLY`.
- **AUSENTE CRÍTICO:** **`cards.pagador` não tem índice**, mas a RLS `cards_select_visibilidade` (mig 242:46) filtra `pagador = ANY(SELECT unnest(current_operador_carteira()))` para todo operador não-gestor — comparação por-linha sem índice. **É o próximo apagão sob volume.** Recomenda-se `CREATE INDEX CONCURRENTLY idx_cards_pagador ON cards(pagador) WHERE pagador IS NOT NULL`.

### 5.4 Constraints de idempotência (ponto mais forte do schema)
- `audit_log.idempotency_key UNIQUE` (efeitos externos).
- `acoes_executadas_ssw UNIQUE(card_id, codigo_oc, ctrc, todo_id)` (INSERT-antes-do-submit).
- `uniq_cards_nf_active` (parcial, exclui RESOLVIDO/CANCELADO — 1 card ativo por NF).
- CHECKs ricos: `cards.state` (14 valores), `canal_origem`, `actor_type`, `documento ~ '^\d+$'`.

### 5.5 RLS e SECURITY DEFINER (problemas concretos)
- RLS habilitada em ~58 tabelas, **mas nenhuma usa `FORCE ROW LEVEL SECURITY`** → o owner do schema bypassa RLS.
- **`operadores_select_all USING(true)`** (mig 001:318) — qualquer operador autenticado lê `gmail_oauth_credentials` (refresh token Gmail em plaintext) de **todos** (ver 5.6). **CRÍTICO.**
- **`email_anexos_select_auth USING(true)`** (mig 063:89) — metadados de anexos de todos vazam cross-carteira. **ALTO.**
- **Apagão "corrigido" só em 2 tabelas** (mig 242 envolveu o predicado em `(SELECT ...)` apenas em `cards` e `todos`); **~17 outras tabelas** ainda chamam os helpers RLS sem o wrapper (`clientes` mig 100:29, `tracking_credentials` mig 011:48, `learning_log` mig 197, etc.) — mesma classe do incidente que derrubou produção.
- **`cleanup_email_anexos_orfaos()`** (mig 063:103) é `SECURITY DEFINER` **sem `SET search_path`** e faz `DELETE FROM storage.objects`.
- **`run_managed_agent_query`** (mig 200:30) executa SQL de LLM via `EXECUTE format('... %s ...')` com validador só de **regex blacklist** (mig 199:126) — pode `SELECT` segredos (`auth.users`, `vault`, `tracking_credentials`) dentro dos limites read-only.

### 5.6 Dados sensíveis

| Dado | Onde | Proteção | Veredito |
|---|---|---|---|
| Refresh token Gmail | `operadores.gmail_oauth_credentials` (plaintext) | RLS `USING(true)` → **lê todo mundo** | **VAZAMENTO cross-operador** |
| Senha tracking SSW | `tracking_credentials.senha` (plaintext) | gestor-only + deprecada | Tolerável (legado) |
| Senha de login operador | — | **Nunca no DB** (só audit sem senha) | **Correto** |
| PII cliente | `clientes`, `contatos_cliente` | RLS por carteira | OK (com risco 5.5 unwrapped) |
| SQL livre do agente | `run_managed_agent_query` | read-only + timeout | Pode exfiltrar segredos |

Nenhuma coluna sensível usa Vault/pgsodium/criptografia em repouso.

### 5.7 Migrations / drift / versionamento
- **Não usa `supabase migration` nativo.** Usa `scripts/apply_migrations.py` (Management API) + tabela `schema_migrations` com **sha256 para drift** (bom).
- **277/287 migrations sem `BEGIN/COMMIT`** → falha no meio deixa **estado parcial sem rollback automático**.
- **Zero down-migrations.** `DROP TABLE ... CASCADE` (ex.: mig 195) são irreversíveis sem backup.
- **Colisões de número de prefixo** (dois `_254_`, `_257_`, `_005_`, `_220_`) — funciona por ordenação alfabética, mas o número não é mais identificador único.
- **Sem staging evidente** — migrations aplicadas direto em produção via Management API.

### 5.8 Possíveis inconsistências
- `cards.pagador` guarda **CNPJ ou nome?** A RLS compara `pagador = ANY(carteira CNPJ)`, mas memória do time diz "pagador = NOME truncado, não CNPJ" — se for nome, a policy **pode não casar** e a visibilidade depender só de `segmento_codigo`. **Dúvida em aberto (5/19).**
- `DATA_MODEL.md` documenta ~12 de ~62 tabelas e descreve RLS/índices que não batem com o real.

---

## 6. APIs e Integrações

> Veredito de uma linha: o caminho de produção do SSW é robusto em idempotência e guard, mas **detecta sucesso por scraping de HTML**; as demais integrações têm **lacunas sistemáticas: zero retry em 429/5xx, zero timeout no Gmail/Anthropic/Bastão, zero circuit breaker/rate-limit em todas**.

### 6.1 SSW (TMS) — `ssw-internal-client.ts` (2171 L)
- **Finalidade:** lançar ocorrência (portal opção 101), ler histórico/fotos, cancelar reentrega, alterar espécie.
- **Auth:** form POST `act=L`; coleta cookie `token` (JWT); cache de sessão em memória respeitando `exp`. **Lançamento SEMPRE pela conta de serviço única `ai.salex`** (`readSswLancamentoEnv`), throw sem fallback se faltar credencial (INV-013). Leitura usa credencial por-operador.
- **Timeout:** **SIM** — `fetchTimeout` com AbortController, default 15s (override 60s upload, 30s submit). **Única integração com timeout consistente.**
- **Retry:** **NÃO** no client; estratégia é re-execução via cron + idempotência.
- **Detecção de sucesso (MAIOR RISCO):** por **negação** — scraping do HTML pós-submit + regex de palavras de erro; **se nada casa → assume `ok:true`** (`:1408-1430`). Já gerou falso-positivo (NF 424475: SSW devolveu erro com entities HTML que o regex não casou → card avançou sem a oc existir).
- **Fragilidade de scraping:** depende de hidden fields, classes CSS (`baselnk`/`data`), entities HTML cruas. Mudança de markup do SSW → `parse_falhou` → **bloqueio fail-closed de 100% dos lançamentos** (seguro, mas single-point-of-failure operacional).
- **Achado de tooling:** o arquivo contém **1 byte NUL na linha 62** → `file` o reporta como binário e **`grep`/`rg` retornam vazio silenciosamente** sobre o arquivo mais crítico do sistema.

### 6.2 Anthropic (Claude) — `anthropic-client.ts`
- **Finalidade:** triagem, agentes, interpretadores. Importado por 9 funções.
- **Auth:** `x-api-key` (secret único, sem rotação). Modelos: 11× sonnet-4-6, 2× haiku-4-5, 1× opus-4-7.
- **Retry:** **NENHUM em rede.** Só re-parse de JSON 1×. **Sem retry em 429/529/503/timeout** — qualquer não-2xx lança imediatamente. (Um 529 já derrubou o triador — INV-016.)
- **Timeout:** **NENHUM** (sem AbortController) → chamada pendurada consome o runtime inteiro.
- **Cost tracking:** grava tokens em `agent_runs`, mas **não calcula custo em dólar** — gasto cego.

### 6.3 Evolution API (WhatsApp) — `evolution-outbound.ts`
- **Auth:** apikey global estática; instance por operador (do DB).
- **Timeout:** **SIM** (15–45s por chamada).
- **Retry:** **NENHUM.**
- **Idempotência:** UNIQUE no DB, mas **SELECT-antes-de-INSERT (TOCTOU), sem `ON CONFLICT`** → corrida pode enviar WhatsApp duplicado.
- **Código morto:** `lib/evolution-client.ts` é órfão (0 imports), com env vars de nomes diferentes e sem timeout.

### 6.4 E-mail saída — Gmail (não Resend) — `gmail-sender.ts`
- **Finalidade:** envio via Gmail API com **OAuth do operador**, atômico com o lançamento de oc=54. **Resend está na stack mas não é o caminho ativo.**
- **Auth/OAuth:** refresh token em `operadores.gmail_oauth_credentials` (**plaintext**, mig 044); callback OAuth roda **fora do repo** (Vercel `cockpit-r-evidencia.vercel.app/api/oauth-gmail-callback`).
- **Timeout:** **NENHUM** em nenhum fetch (send/refresh/modify). Ponto perigoso: o send é **síncrono e atômico com o lançamento SSW**.
- **Retry:** quase nenhum (só 1 retry em 404/400 de threadId).
- **Idempotência:** no caller (`verificarEmailJaEnviado(todoId)` + UNIQUE parcial), **mas fluxos sem `todo_id`** (`cobrar-cliente-aguardando`, `enviar-retificacao-evidencia`, `responder-email-cliente`) ficam **fora da constraint** → podem reenviar duplicado.

### 6.5 E-mail entrada — Gmail poll — `gmail-reader.ts` + `gmail-poll-inbox`
- **Timeout:** **NENHUM**; `maxResults=500` + `format=full` sem throttle → caixa cheia consome quota/runtime.
- **Retry:** nenhum; em vez disso, isolamento por operador (`Promise.allSettled`).
- **Idempotência:** dedup por `message_id_header` + dedup de anexos por `filename|size` (INV-025).
- **Postmark inbound:** está na stack mas **o token não é verificado** no `ingestor` — dúvida se é canal ativo.

### 6.6 Bastão (Supabase externo) — `bastao-client.ts`
- **Auth:** **anon key** (read-only — aceitável se a RLS do Bastão permitir só SELECT).
- **Timeout:** **NENHUM** → PostgREST externo lento pendura o sync (já regrediu por timeout 150s).
- **Retry:** **NENHUM.**
- **Tratamento de erro — fail-OPEN parcial:** a query principal é fail-closed, mas as queries **secundárias (exceção oc=13, fullPull) têm `catch` que faz `console.warn` e segue com resultado parcial** (`:254-256`, `:290-293`) → cards "somem" do conjunto → decisões de fechamento/movimentação erradas, silenciosamente.
- **Gate de frescor:** `fetchBastaoMaxUpdatedAt()` permite só inferir "NF sumiu → finalizada" se o Bastão estiver fresco (≤45min) — bom padrão, mas só aplicado ao caminho de extravios.

### 6.7 Tabela resumo

| Integração | retry | timeout | scraping HTML | fail-open/closed | risco principal |
|---|---|---|---|---|---|
| SSW interno (portal 101) | Não | **Sim** | **Sim, pesado** | fail-closed (guard) mas **sucesso por negação** | falso-positivo de sucesso |
| Anthropic | **Não** | **Não** | Não | fail-closed | sem retry 429/529 + sem timeout |
| Evolution (WhatsApp) | **Não** | Sim | Não | fail-closed | TOCTOU na idempotência |
| Gmail saída | quase não | **Não** | Não | fail-closed | sem timeout num send atômico c/ SSW |
| Gmail entrada | Não | **Não** | Não | fail-soft (swallows) | sem timeout + sem throttle quota |
| Bastão | **Não** | **Não** | Não | **fail-open** nas exceções | staleness + fail-open silencioso |

### 6.8 Top riscos transversais de integração
Zero circuit breaker / rate limiting em **todas**; sem cost tracking em $; código morto importável (WebAPI `ssw-client`, tracking-clients); NUL byte invisibilizando o arquivo SSW para grep; rotação de segredos inexistente (chaves estáticas de longa duração).

---

## 7. Autenticação e Autorização

### 7.1 Login / sessão / tokens
- **Operadores** logam via **Supabase Auth** (e-mail+senha, JWT). `operadores.user_id → auth.users`. `current_operador_id()/papel()/carteira()/segmentos()` resolvem `auth.uid()`.
- **`enable_signup = true`** no `config.toml` (`[auth]`) — **signup aberto está ligado** (qualquer um cria conta Auth).
- **"Esqueci a senha"** (`recuperar-senha-operador`): gera senha aleatória e **envia em claro por e-mail** (cooldown 5min, resposta genérica). Furo: se a caixa for comprometida, a senha vaza.
- **Login SSW** é separado: conta de serviço única `ai.salex` (env), usada por todos os lançamentos.

### 7.2 Autorização (papéis, carteira, RLS)
- Papéis: `operador` / `gestor` (gestor = RLS total). Visibilidade de card: gestor OR `assigned_operator_id = me` OR `pagador ∈ carteira` OR `segmento_codigo ∈ segmentos`. A leitura é **performática (InitPlan, mig 242) e correta na lógica**.
- **FURO CRÍTICO — escalação de privilégio:** `operadores_update_self` (mig 001:322-323) é `FOR UPDATE USING (auth.uid()=user_id)` **sem `WITH CHECK` e sem column-guard**. Nenhuma migration posterior adiciona proteção. Um operador autenticado pode `UPDATE operadores SET papel='gestor' WHERE user_id=auth.uid()` via PostgREST (a anon key está no front) e ganhar RLS total. Também reescreve sua própria `carteira`/`segmentos`.
- **FURO — UPDATE de card sem column-guard:** `cards_update_visibilidade` (mig 242:60-73) só valida visibilidade no `WITH CHECK`. Operador que enxerga um card por carteira pode mudar `assigned_operator_id` (roubar/repassar), `state`, `agent_state` **sem passar por evento** — furando o event-sourcing.

### 7.3 `verify_jwt = false` — endpoints expostos
**43 funções têm `verify_jwt=false`** no `config.toml`. Isso desliga a validação de JWT de usuário; o gateway ainda exige a **anon key**, mas a anon key é **pública** (embutida no front Lovable). A maioria **não valida o chamador** — confia em "só o cron sabe a URL". Endpoints sensíveis expostos sem auto-autenticação:

| Função | Risco | Ação sensível |
|---|---|---|
| `ingestor` | 🔴 | injeta mensagem → card → LLM (custo); Postmark token **não verificado** |
| `executor` | 🔴 | lança oc no SSW + envia e-mail (consome só pgmq, mas o endpoint HTTP é disparável) |
| `send-whatsapp-message` | 🔴 | envia WhatsApp arbitrário |
| `disparar-cobranca-escalonada` | 🔴 | dispara cobrança a cliente |
| `processar-acoes-agendadas` | 🔴 | dispara ações agendadas |
| `agente-extravio-d4` / `agente-ressarcimento-relancar-54` | 🔴 | lançam oc autônoma |
| `criar-instancia-whatsapp` | 🔴 | cria instância (custo/abuso Evolution) |
| `listar-contatos-cobranca` | 🟠 | vaza contatos/PII de clientes |
| `sync-bastao`, `reprocessar-dlq`, `scan-email-pre-card`, ~25 outras | 🟠 | mutam dados/chamam LLM |
| `r-evidencia` | 🟢 | capability URL com token validado + expiração (OK) |

### 7.4 Webhooks
- **`ingestor`:** **nenhuma autenticação.** Qualquer um POSTa `{canal,remetente,conteudo}` e injeta mensagem. Postmark inbound token (existe no `.env.example`) **não é verificado**.
- **`webhook-ssw-ocorrencias`:** auth condicional (Basic Auth OU `X-SSW-Secret`); **furo:** se nenhuma env estiver configurada, **aceita anônimo**; comparação de secret não é constant-time. Mitigado por estar em isolamento (não toca cards hoje).

### 7.5 Gate de admin
- `admin-operadores` (`verify_jwt=true`): reconfirma `auth.getUser()` e exige `callerEmail ∈ SUPER_ADMINS` (hardcoded: `["caio@salexpress.com.br","isadora.baldoni@salexpress.com.br"]`, `:28`). **Frágil:** e-mail hardcoded exige deploy para mudar, e combina mal com o furo de escalação (7.2). Melhor seria flag `is_super_admin` imutável no DB.

### 7.6 Managed Agent SQL runner
`run_managed_agent_query`: defesas em camadas (read-only, statement_timeout 10s, LIMIT 500, service_role-only, auth `X-Tool-Secret` + whitelist de 2 `agent_id`). **Risco residual:** o validador é denylist regex; `read_only` impede escrita mas **não impede leitura de qualquer tabela** sob `SECURITY DEFINER` (auth.users, vault, tracking_credentials) → **confidencialidade não garantida**. Os `agent_id` estão no código-fonte (não são segredos).

---

## 8. Variáveis de Ambiente

> Coletadas de `Deno.env.get(` em `supabase/functions/`. **NÃO se expõe nenhum valor.** Os segredos reais ficam em `.env.local` (gitignored, 18 segredos, **nunca commitado** — confirmado por `git log --all`).

| Variável | Função |
|---|---|
| `SUPABASE_URL` | URL do projeto |
| `SUPABASE_ANON_KEY` | Anon key (cliente "como usuário") |
| `SUPABASE_SERVICE_ROLE_KEY` | **Service role — bypassa RLS. Segredo de maior valor.** |
| `ANTHROPIC_API_KEY` | Claude SDK |
| `POSTMARK_SERVER_TOKEN` | Envio de e-mail (reset senha, digests) |
| `EVOLUTION_BASE_URL` / `EVOLUTION_APIKEY` / `EVOLUTION_GLOBAL_APIKEY` / `EVOLUTION_INSTANCE` | WhatsApp |
| `SSW_DOMAIN` / `SSW_USERNAME` / `SSW_PASSWORD` / `SSW_CNPJ_EDI` | Conta de serviço SSW |
| `SSW_LANCAMENTO_USUARIO` / `_SENHA` / `_CPF` | Conta `ai.salex` de lançamento (INV-013) |
| `SSW_INTERNAL_<NOME>_*` | Credenciais SSW por-operador (leitura) |
| `SSW_TRACKING_CNPJ_DEFAULT` / `_SENHA_DEFAULT` | Tracking SSW (legado) |
| `BASTAO_SUPABASE_URL` / `BASTAO_SUPABASE_ANON_KEY` | Supabase externo do Bastão |
| `GOOGLE_OAUTH_CLIENT_ID` / `_CLIENT_SECRET` | OAuth Gmail das caixas de operador |
| `MANAGED_AGENT_TOOLS_SECRET` | Segredo dos Managed Agents |
| `SAL_ROMANEIO_BASE_URL` / `_LOGIN` / `_SENHA` | Portal romaneio interno |
| `EVIDENCIA_BASE_URL` | App de evidência (Vercel) |
| `WEBHOOK_SSW_KILL_SWITCH` / `_USER` / `_PASS` / `_SECRET` | Auth/kill do webhook SSW |
| `ENVIO_DESABILITADO` | Flag global de bloqueio de envio |
| `EXTRAVIOS_BASTAO_FRESH_MIN` / `OC11_GPS_THRESHOLD_METROS` / `OC13_MOTIVOS_GENERICOS` | Tuning de regras |

**`.env.example` está desatualizado:** lista `RESEND_API_KEY` e `POSTMARK_INBOUND_TOKEN` (**não usados** no código real) e **omite** `POSTMARK_SERVER_TOKEN`, `MANAGED_AGENT_TOOLS_SECRET`, `GOOGLE_OAUTH_*`, `SAL_ROMANEIO_*`, `SSW_LANCAMENTO_*`, `SSW_INTERNAL_*`, `EVOLUTION_GLOBAL_APIKEY` → **risco de deploy com env faltando** (ex.: webhook fica anônimo, envio quebra).

---

## 9. Estrutura dos Arquivos Mais Importantes

| Arquivo | LOC | Por que importa |
|---|---|---|
| `supabase/functions/sync-bastao/index.ts` | 4081 | **Máquina de estados do card.** O maior risco do sistema. Sem teste. ~10 regressões históricas. |
| `supabase/functions/executor/index.ts` | 2902 | God-function que lança oc no SSW + envia e-mail. Ação irreversível. Sem teste. |
| `supabase/functions/_shared/ssw-internal-client.ts` | 2171 | Todo o scraping do portal SSW. Fragilidade de integração concentrada. NUL byte na linha 62. |
| `supabase/functions/_shared/regras-auto-acao.ts` | 1311 | Motor de propostas (oc→ação). `proporAutoAcaoSeAplicavel` é deus-função consumida por 16 módulos. |
| `supabase/functions/agente-sugere-ocs-padrao/index.ts` | 1307 | Agente que propõe ocs a partir de evidência/foto. |
| `supabase/functions/vinculador/index.ts` | 1229 | 6 prioridades de dedup; cria/anexa card. |
| `supabase/functions/gmail-poll-inbox/index.ts` | 898 | Captura de respostas de cliente (cron 5min). |
| `supabase/functions/agente-oc13-autonomo/index.ts` | 814 | Autônomo SEM flag boolean (lança oc 21). |
| `supabase/functions/scan-email-pre-card/index.ts` | 796 | Adoção de thread pré-existente + propostas determinísticas. |
| `supabase/functions/health-check/index.ts` | 771 | Watchdog (alertas para o Caio; camada 3 de INV-016/019). |
| `supabase/functions/_shared/lancar-ssw-portal.ts` | 349 | Envelope de lançamento (idempotência + tripé + conta ai.salex). Sem teste. |
| `supabase/functions/_shared/validar-tripe-ssw.ts` | 230 | Guard "inviolável" CTRC+NF+localização. **Fail-open na localização.** Sem teste. |
| `supabase/functions/_shared/propostas-pos-resposta-cliente.ts` | 284 | Fonte única determinística de propostas (INV-016). |
| `supabase/functions/_shared/bastao-rules.ts` | 145 | `stateFinalAposBastao` (oc→state). Carrega dicionário em cold start. |
| `migration/2026-04-29_001_initial_schema.sql` | — | Schema base (cards, card_events, operadores, RLS inicial). |
| `migration/2026-06-23_242_rls_perf_initplan_cards_todos.sql` | — | Fix do apagão de RLS (incompleto — só 2 tabelas). |
| `docs/INVARIANTES_COCKPIT.md` | 575 | **Único doc vivo e confiável.** 25 invariantes com verificação executável. |
| `.claude/commands/verify-cockpit.md` | — | "Suíte" de verificação — manual, roda ~7/20 testes. |
| `scripts/apply_migrations.py` | — | Runner de migrations próprio (sha256 drift-check, sem transação). |

---

## 10. Dívidas Técnicas (classificadas)

### Críticas
1. **`sync-bastao` (4081 L) e `executor` (2902 L) sem nenhum teste** + máquina de estados inline não extraída para `lib/`. Cada edição é uma aposta cega.
2. **Guard tripé fail-open na localização** (`validar-tripe-ssw.ts:122`) — viola a regra-mãe do sistema.
3. **Escalação de privilégio a gestor** (RLS sem `WITH CHECK` em `operadores`).
4. **Detecção de sucesso de lançamento SSW por scraping/negação** — falso-positivo já ocorreu.
5. **Refresh tokens Gmail em plaintext + RLS `USING(true)`** → vazamento cross-operador.
6. **Zero CI / zero eval de IA.**

### Altas
7. **`cards.pagador` sem índice** num filtro RLS per-row (próximo apagão).
8. **Anthropic sem retry/timeout**; **Gmail/Bastão sem timeout**.
9. **277/287 migrations sem transação + sem rollback**; sem staging.
10. **Apagão de RLS resolvido só em 2 de ~19 tabelas** da mesma classe.
11. **`proporAutoAcaoSeAplicavel` deus-função** (~600 L, 16 consumidores, 8 testes).
12. **3 definições divergentes de "ocs de relacionamento"** + `{6,9,16}`/`{1,30,32}` duplicados em 6 lugares cada.
13. **Linha `acoes_executadas_ssw sucesso=null` órfã trava relançamento** (sem TTL/limpeza).
14. **`agente-oc13-autonomo` sem kill-switch de flag.**

### Médias
15. **Convenção "prompts em arquivos" violada** — system prompts de IA estão inline em TS; `prompts/triador.md` é mirror que pode driftar.
16. **`run_managed_agent_query` pode ler segredos** (validador denylist regex).
17. **`messages_inbox` sem UNIQUE** em `message_id_header` (duplicação de mensagem).
18. **TOCTOU na idempotência do WhatsApp**; **idempotência de e-mail não cobre fluxos sem `todo_id`**.
19. **`endpoints sensíveis verify_jwt=false sem auto-auth`** (confiança na anon key pública).
20. **NUL byte em `ssw-internal-client.ts:62`** invisibiliza o arquivo para grep/rg.

### Baixas
21. **Código morto importável:** `lib/evolution-client.ts`, `lib/dedup-rules.ts` (órfão), WebAPI `ssw-client`, tracking-clients, Passes E/F do sync.
22. **`lib/` vs `_shared/` fork stale:** testes de `lib/bastao-client.ts`/`lib/bastao-rules.ts` validam arquivos que **não rodam em produção**.
23. **Docs obsoletos** (`AGENTS.md`, `STATE_MACHINE.md`, `DATA_MODEL.md`, `README.md` "Fase 0", `evals/baseline.md`).
24. **`.env.example` desatualizado.**
25. **CORS `*`** em quase todas as funções.

---

## 11. Bugs Conhecidos / Inconsistências Ativas

> Distinção: a maioria dos "bugs históricos" virou invariante e já foi corrigida. Aqui estão **inconsistências e fragilidades ativas hoje**, não os incidentes já fechados.

1. **Tripé fail-open na localização** — `validar-tripe-ssw.ts:122`. Se o SSW mudar o markup da localização, o guard mais importante é pulado **sem alerta nem `card_event`**.
2. **AbortError no submit não tratado** — `ssw-internal-client.ts:1346-1359` + `lancar-ssw-portal.ts:268`. Timeout = estado desconhecido (oc pode ter sido lançada); linha `sucesso=null` órfã.
3. **Detecção de sucesso heurística** — `ssw-internal-client.ts:1408-1430`. Mensagem de erro nova do SSW → falso "sucesso" → card afirma oc que não foi lançada.
4. **Bastão fail-open nas queries de exceção** — `bastao-client.ts:254-256, 290-293`. Falha vira `console.warn` + resultado parcial → cards "somem".
5. **Escalação de privilégio** — `operadores_update_self` sem `WITH CHECK` (mig 001:322).
6. **`messages_inbox` sem UNIQUE** → webhook reentregue duplica processamento.
7. **TOCTOU WhatsApp** — `send-whatsapp-message/index.ts:130-205` (SELECT-then-INSERT sem `ON CONFLICT`).
8. **Idempotência de e-mail não cobre fluxos sem `todo_id`** (cobrança/retificação/resposta).
9. **Divergência de cron do sync-bastao** — código/mig 097 diz 30min, comentário da mig 255 diz "5/5min" → **incerteza sobre a cadência real** e o risco de overlap.
10. **3 listas divergentes de "ocs de relacionamento"** → o `webhook-ssw-ocorrencias` roteia card por uma noção inconsistente com o `sync-bastao`.
11. **Mensagem no DLQ >60min ou >4 tentativas não é reprocessada** — perda silenciosa.
12. **`BLOQUEADO_POR_ERRO` e `ACAO_EXECUTADA` sem TTL** — nada no sync os tira automaticamente em alguns caminhos.
13. **`prompts/triador.md` (188 L) diverge de `_shared/prompts/triador.ts` (134 L)** — o código carrega o `.ts`; o `.md` é doc desatualizado.
14. **NUL byte em `ssw-internal-client.ts:62`** — bug de manutenção (buscas de texto falham).

---

## 12. Hipóteses Frágeis (decisões que dependem de premissas que podem não ser verdadeiras)

1. **"O SSW não muda o HTML do portal."** Todo o lançamento e o guard tripé dependem de scraping de markup específico (classes CSS, entities, hidden fields). Uma mudança de UI do SSW quebra lançamento (fail-closed, melhor caso) ou o guard de localização (fail-open, pior caso).
2. **"A ausência de palavra de erro no HTML = sucesso."** Premissa do `:1408`. Qualquer redação nova de erro do SSW a viola.
3. **"O Bastão é fresco e confiável."** O gate de frescor só protege extravios; os outros consumidores assumem que o Bastão reflete o SSW. RPA atrasado/parado → decisões erradas.
4. **"`cards.pagador` casa com a carteira (CNPJ)."** A RLS depende disso, mas há indício de que `pagador` guarda nome truncado.
5. **"A Anthropic responde."** Sem retry/timeout, qualquer 529/latência da Anthropic quebra o gate de triagem (já aconteceu).
6. **"Validação humana é estado explícito."** Na prática, `auto_aprovar_e_executar` valida só `todo.status='pendente'`, não que o card estava em AGUARDANDO_VALIDACAO_HUMANA — a disciplina é dos callers, não imposta pelo RPC. Qualquer agente com service_role executa no SSW.
7. **"A idempotência é por (card, oc, ctrc)."** O CLAUDE.md afirma isso, mas a UNIQUE real inclui `todo_id` (mig 202) → reaprovação manual permite relançar a mesma oc.
8. **"O cron não se sobrepõe."** O sync-bastao não tem mutex; assume que uma run termina antes da próxima começar.
9. **"A anon key protege os endpoints."** A anon key está no front Lovable (pública) → `verify_jwt=false` sem auto-auth ≈ endpoint público.
10. **"Os testes em `lib/` cobrem o que roda."** Falso: `lib/bastao-rules.ts`/`lib/bastao-client.ts` são forks stale; produção roda as cópias `_shared/`.
11. **"O e-mail entrante vem do Postmark/Gmail legítimo."** O `ingestor` não verifica o token Postmark.

---

## 13. Auditoria de Riscos

Para cada risco: descrição · probabilidade · impacto · como detectar · como evitar.

### 13.1 Riscos técnicos
- **R-T1: SSW muda o HTML do portal.** Prob: **média** (sistema legado, mas pode atualizar). Impacto: **crítico** (lançamento quebra ou guard fail-open). Detectar: monitorar taxa de `parse_falhou` e de `tripe_rejeitado`; alertar quando `localizacao` vier vazia. Evitar: confirmar SEMPRE via `listarOcorrenciasNF` pós-submit; teste-guard de HTML fixture; tornar a localização fail-closed.
- **R-T2: Falso-positivo de sucesso de lançamento.** Prob: **média**. Impacto: **alto** (card afirma oc inexistente, anexos deletados). Detectar: reconciliação pós-submit comparando com o histórico SSW. Evitar: trocar "ausência de erro" por "presença de confirmação positiva".
- **R-T3: Anthropic 529/latência.** Prob: **alta**. Impacto: **médio-alto** (gate de triagem quebra). Detectar: alertar DLQ de cliente; contar 529. Evitar: retry com backoff + timeout + AbortController.

### 13.2 Riscos de arquitetura
- **R-A1: `sync-bastao` monolítico (4081 L) com lógica inline não testada.** Prob: **alta** de regressão a cada edição. Impacto: **crítico** (já moveu 49 cards errado, travou 52). Detectar: `/verify-cockpit` + SQL probes. Evitar: extrair a máquina de estados para `lib/` puro com testes.
- **R-A2: Deadline pula G/H → cards `ACAO_EXECUTADA` presos sem TTL.** Prob: **média**. Impacto: **alto**. Detectar: `SELECT count(*) FROM cards WHERE state='ACAO_EXECUTADA' AND ... > 1h`. Evitar: deadline-check no main-loop do Pass A; TTL com auto-cura.

### 13.3 Riscos de manutenção
- **R-M1: Regras duplicadas (3 listas de "relacionamento", `{6,9,16}` ×6).** Prob: **alta** de divergência. Impacto: **alto** (roteamento inconsistente). Detectar: teste que compara as listas. Evitar: fonte única (dicionário) + remover hardcodes.
- **R-M2: Docs divergentes do código.** Prob: **certa** (já é). Impacto: **médio** (onboarding parte de premissa falsa). Evitar: marcar docs stale como obsoletos; manter só INVARIANTES como vivo.

### 13.4 Riscos de segurança
- **R-S1: Escalação operador→gestor.** Prob: **alta** se explorada. Impacto: **crítico** (RLS total). Detectar: trigger de auditoria em `operadores.papel`. Evitar: `WITH CHECK` + congelar `papel`/`carteira` via trigger.
- **R-S2: Endpoints sensíveis sem auth.** Prob: **média** (precisa da anon key, que é pública). Impacto: **alto** (lançar oc/enviar WhatsApp/cobrar). Detectar: logs de invocação anômala. Evitar: segredo interno compartilhado validado em cada função; WAF/rate-limit.
- **R-S3: Vazamento de refresh token Gmail.** Prob: **média**. Impacto: **alto** (controle da caixa de qualquer operadora). Evitar: mover para Vault; RLS restrita.

### 13.5 Riscos de escalabilidade
- **R-E1: RLS per-row sem índice (`cards.pagador`).** Prob: **alta** com crescimento. Impacto: **crítico** (apagão repetido). Detectar: `pg_stat_statements` + EXPLAIN do board. Evitar: índice + completar o fix InitPlan nas ~17 tabelas restantes.
- **R-E2: Gmail poll `maxResults=500` sem throttle.** Prob: média. Impacto: médio (quota/runtime). Evitar: paginação incremental + histórico.

### 13.6 Riscos de concorrência
- **R-C1: Sync-bastao sem mutex → overlap de runs.** Prob: **média** (depende do cron real). Impacto: **alto** (double-write, eventos duplicados). Detectar: eventos duplicados em `card_events`. Evitar: advisory lock por run.
- **R-C2: vt do pgmq < trabalho síncrono** (vinculador vt=120 vs IA 60s+Bastão; executor vt=180 vs upload+submit). Prob: média. Impacto: médio (re-leitura concorrente, oscilação de state). Evitar: ajustar vt > pior caso.

### 13.7 Riscos de perda de dados
- **R-D1: Migrations sem transação/rollback + `DROP CASCADE`.** Prob: baixa-média. Impacto: **crítico** (perda irreversível). Evitar: envolver em `BEGIN/COMMIT`; backup antes de DROP; down-migrations.
- **R-D2: Anexos deletados após falso-positivo de sucesso (R-T2).** Prob: média. Impacto: alto. Evitar: soft-delete + confirmação real antes de deletar.

### 13.8 Riscos financeiros
- **R-F1: Gasto Anthropic cego (sem cost tracking em $).** Prob: alta. Impacto: médio (custo descontrolado; loop de fila pode multiplicar — INV-028 já inflou fila a 2.235 msgs). Detectar: somar tokens×preço por dia. Evitar: orçamento + alerta.
- **R-F2: Banimento do WhatsApp (Evolution).** Prob: média (PRD §7 reconhece). Impacto: alto (canal principal). Evitar: throttle, opt-in, instância dedicada.

### 13.9 Riscos operacionais
- **R-O1: Sem CI → merge de código quebrado.** Prob: alta. Impacto: alto. Evitar: pipeline mínimo (`deno check` + `deno test` + `/verify-cockpit` automatizado).
- **R-O2: Sem staging → migrations direto em produção.** Prob: certa. Impacto: alto. Evitar: ambiente de staging.
- **R-O3: Bus factor = 1 (Caio + Claude Code, sem time de dev).** Prob: certa. Impacto: crítico para continuidade. Evitar: documentação viva + runbooks.

---

## 14. Auditoria de Regressão

> O sistema regrediu repetidamente (o próprio CLAUDE.md e ~10 memórias documentam isso). Esta seção mapeia **por que** mudanças pequenas quebram várias coisas.

### 14.1 Funções reutilizadas em muitos lugares (mudança = onda)
- **`proporAutoAcaoSeAplicavel`** (`regras-auto-acao.ts:544`) — **16 consumidores.** Uma mudança de cooldown/dedup/manter_state propaga por todo o sistema. Só 8 testes.
- **`stateFinalAposBastao`** (`bastao-rules.ts`) — fonte única oc→state, lida por todas as passes do sync. Sem teste.
- **`lancarSswPortal`** (envelope) — todos os lançamentos passam aqui. Sem teste.
- **`upsertCardFromPendencia`** (`sync-bastao:1411`, 1237 L) — todos os cards criados/reabertos passam por essa árvore de 9 ramos interdependentes via `effState`/`effLock`/precedência de `if/else if`.

### 14.2 Estados inconsistentes / condições de corrida
- **Pass E desligado deixou ramo órfão** → 52 cards invisíveis (INV-019). Padrão: **enforcement acoplado a UM código some em silêncio.**
- **Sync sem mutex** (14.6) → double-write.
- **vt pgmq < trabalho síncrono** → re-leitura re-seta `cliente_respondeu_em`, re-dispara IA, oscila state.
- **`forcaAguardandoClienteOc54` + Bastão atrasado** arrastou card 33/TRANSFERIDO de volta para 54/AGUARDANDO_CLIENTE (INV-014).

### 14.3 Código duplicado / regras espalhadas
- `{6,9,16}` ×6, `{1,30,32}` ×6, "relacionamento" ×3 (divergentes), allowlists de oc soltas. **Qualquer mudança de regra exige N edições manuais sincronizadas.**

### 14.4 Dependências ocultas / forks stale
- **`lib/` vs `_shared/`:** `bastao-rules.ts` e `bastao-client.ts` têm cópias **declaradamente divergentes**; os testes validam a cópia que **não roda**. `anthropic-client.ts` duplicado. `lib/dedup-rules.ts` é **órfão total** (0 referências), mas o `AGENTS.md` o cita como ativo.
- **Acoplamento textual:** `categorizar-erro-ssw.ts` classifica erros por string que o próprio `ssw-internal-client` gera (`"sem cookie 'token'"`) — refatorar a mensagem quebra a classificação silenciosamente.

### 14.5 Efeitos colaterais / cache
- **Cache de sessão SSW em memória** — invalidado se a pessoa logar manualmente no portal (login compartilhado).
- **Cache de dicionário de ocs em cold start** (`bastao-rules.ts`) — mudança na planilha só pega em cold start; INV-010 força `set.add(54)` independente da planilha.
- **Cache de access token Gmail** por operador.

### 14.6 Sincronização / transações / concorrência
- **`upsertCardFromPendencia` é read-modify-write sem transação.** Duas runs concorrentes do sync (sem mutex) ou um cron + um botão manual podem corromper o estado.
- **`auto_aprovar_e_executar` (SECURITY DEFINER)** não exige que o card estivesse em AGUARDANDO_VALIDACAO_HUMANA.

### 14.7 Mudanças que parecem pequenas mas quebram tudo
- **Remover `54` do set de relacionamento** → 49 cards AGUARDANDO_CLIENTE→TRANSFERIDO em horas (INV-010, já aconteceu).
- **Desligar um Pass do sync** → ramo órfão, cards invisíveis (INV-019, já aconteceu).
- **Trocar a redação de uma mensagem de erro do SSW** → classificação de erro quebra (14.4).
- **Mudar `URLSearchParams.toString()` no submit** → `observ` vazio silencioso (latin-1, já aconteceu em 4 NFs).
- **Editar `proporAutoAcaoSeAplicavel`** → propaga por 16 consumidores.

---

## 15. Validação de Regras de Negócio (onde podem ser quebradas)

- **Validações ausentes:** `auto_aprovar_e_executar` não valida o state de origem do card; `ingestor` não valida origem do webhook; idempotência de e-mail não cobre fluxos sem `todo_id`; `messages_inbox` sem UNIQUE.
- **Ifs incompletos / fail-open:** tripé (c) localização (`if (localizacao)`); Bastão exceções (`catch → console.warn → segue`); detecção de sucesso por negação.
- **Estados impossíveis tornados possíveis:** card em CONFLITOS com oc lançada pelo Cockpit (INV-014, corrigido mas a classe persiste); card AGUARDANDO_CLIENTE com oc relac≠54 (INV-019); linha `acoes_executadas_ssw sucesso=null` órfã.
- **Edge cases:** mesmo-dia no discriminador de reabertura (INV-023); múltiplos CTRCs por NF (INV-011); múltiplas fotos por oc (INV-012); assinatura inline vs anexo real (INV-025); NF com nome no `pagador` vs CNPJ na carteira.
- **Fluxos alternativos:** reaprovação manual gera todo novo (fura a UNIQUE por incluir `todo_id`); agente autônomo executa via o mesmo RPC do humano sem o gate de state.
- **Erros silenciosos:** `console.warn` nas exceções do Bastão; `catch {}` em `marcarComoLida`; `decodeBase64Url` engole erro e devolve string crua; tripé fail-open sem `card_event`.
- **Retornos inconsistentes:** `protocolo || "N/A"` na WebAPI morta; detecção de sucesso retorna `ok:true` por default.

---

## 16. Testes

### 16.1 O que existe
- **~169 casos em 20 arquivos `*.test.ts`**, 100% **unitários de função pura** rodando in-process (mocks in-memory). Runner: `deno test` (à mão). Forte viés para **guards de regressão de bugs recentes** (cada teste ancora um INV).
- **Cobertos:** `lag-lancamento-54` (29), `recusa-por-extravio` (13), `escopo-relacionamento` (13), `escolher-ctrc-manual` (12), `ressarcimento-relancar-54` (12), `criar-card-via-ssw` (9), `scan-email-scoring` (9), `descricao-ssw` (8), `extravio-routing` (8), `parser-email-ssw-rastreamento` (8), `gmail-anexos-classificacao` (7), `agente-extravio-regras` (6), `regras-interpretador-resposta` (6), `reconciliar-extravios-bastao` (5), `email-format` (4), `limite-anexos` (3), `ssw-lancamento-env` (4), `regras-auto-acao` sem-email/romaneio (8).

### 16.2 O que NÃO existe (e deveria — priorizado)
1. **`executor` + `lancar-ssw-portal` + `validar-tripe-ssw`** — o caminho irreversível, sem 1 teste.
2. **Máquina de estados do `sync-bastao`** — validada só por grep + SQL em produção.
3. **`bastao-rules.ts` (_shared)** — `stateFinalAposBastao` sem teste.
4. **Evals dos agentes de IA** (triador/interpretadores/redator) — nenhuma medição de qualidade.
5. **Testes de integração** (real contra SSW staging/Gmail/DB), **E2E**, **carga** (o sync foi otimizado para escala mas validado só em produção), **segurança** (nenhum).

### 16.3 CI / automação
- **INEXISTENTE.** Sem `.github/workflows`, sem `package.json`/`deno.json`, sem pre-commit. `bun run evals` e `bun test lib/` (CLAUDE.md) **não existem**.
- **`/verify-cockpit`** é um slash-command **manual** (grep + SQL probes contra produção) que roda **só ~7 dos 20** arquivos de teste; 13 nunca são invocados.

### 16.4 Cenários mais críticos para testar antes de produção
- Lançamento SSW: tripé rejeita CTRC errado/NF errada/localização ENTREGUE; idempotência (relançar 2x); latin-1 (`observ` não vazio); AbortError no submit; falso-positivo de sucesso (HTML de erro com entities).
- Sync: deadline pula G/H; overlap de runs; reabertura mesmo-dia (INV-023); `54` no set (INV-010).
- Auth: operador não consegue virar gestor; endpoint sensível recusa caller sem auth.
- INV-016: cliente respondeu sempre tem botões mesmo com Anthropic fora.

---

## 17. Checklist para Produção (específico deste projeto)

### Bloqueadores (não subir sem)
- [ ] **Fechar escalação de privilégio:** `WITH CHECK` em `operadores_update_self` + trigger que congela `papel`/`carteira`/`segmentos` (mig 001:322).
- [ ] **Autenticar endpoints sensíveis `verify_jwt=false`** (executor, ingestor, send-whatsapp-message, disparar-cobranca, processar-acoes-agendadas, criar-instancia-whatsapp, agentes) com segredo interno compartilhado; ou pôr atrás de WAF/rate-limit.
- [ ] **Tornar o tripé (c) localização fail-CLOSED** + emitir `card_event` + alerta quando a label sumir (`validar-tripe-ssw.ts:122`).
- [ ] **Tratar AbortError no submit** (`ssw-internal-client.ts:1346`, `lancar-ssw-portal.ts:268`) + limpar/expirar linha `sucesso=null` órfã.
- [ ] **Confirmação positiva de lançamento** (reconciliar com `listarOcorrenciasNF` pós-submit) em vez de "ausência de erro".
- [ ] **Mover refresh token Gmail para Vault** + restringir RLS de `operadores` (não `USING(true)` em colunas sensíveis).
- [ ] **Verificar o token Postmark no `ingestor`** (ou desativar a entrada não autenticada).
- [ ] **Desligar `enable_signup`** no `config.toml` (signup aberto).

### Alta prioridade (antes de aumentar volume)
- [ ] **Índice `cards.pagador`** + completar o fix InitPlan de RLS nas ~17 tabelas restantes.
- [ ] **Retry+timeout na Anthropic** (backoff em 429/529 + AbortController) e **timeout no Gmail e no Bastão**.
- [ ] **Mutex (advisory lock) no `sync-bastao`** + confirmar o cron real (30min vs 5min).
- [ ] **Deadline-check no main-loop do Pass A** + TTL/auto-cura para `ACAO_EXECUTADA` e `BLOQUEADO_POR_ERRO`.
- [ ] **CI mínimo:** `deno check` + `deno test` em todos os 20 arquivos + `/verify-cockpit` automatizado, bloqueando merge.
- [ ] **Kill-switch de flag para `agente-oc13-autonomo`.**
- [ ] **Cost tracking em $** (tokens×preço) + alerta de orçamento.
- [ ] **Fonte única para `{6,9,16}`, `{1,30,32}` e "relacionamento"** (reconciliar as 3 listas divergentes).

### Média prioridade
- [ ] Testes para `executor`/envelope/tripé e para a máquina de estados do sync (extraída para `lib/`).
- [ ] Eval harness real para os agentes de IA (rodando em CI).
- [ ] `UNIQUE` em `messages_inbox.message_id_header`; `ON CONFLICT` na idempotência do WhatsApp; cobrir fluxos de e-mail sem `todo_id`.
- [ ] Migrations com `BEGIN/COMMIT` + ambiente de staging + estratégia de rollback/backup antes de `DROP`.
- [ ] Remover código morto (`lib/dedup-rules.ts`, `lib/evolution-client.ts`, WebAPI/tracking SSW, Passes E/F) e forks stale.
- [ ] Corrigir o NUL byte em `ssw-internal-client.ts:62`.
- [ ] Atualizar/aposentar docs stale (`AGENTS.md`, `STATE_MACHINE.md`, `DATA_MODEL.md`, `README.md`, `.env.example`).

---

## 18. Monitoramento

### 18.1 O que já existe
- Logs nativos Supabase (Edge Functions + Postgres); `agent_runs` (tokens/duração); `audit_log` (efeitos externos); `card_events` (auditoria de estado); `health-check` (771 L, watchdog que alerta o Caio por e-mail — camada 3 de INV-016/019); `monitor-capacidade.html` (monitor visual de 2 eixos: pessoas/robôs); `/verify-cockpit` (probes manuais).

### 18.2 Métricas que faltam monitorar (específicas)
- **Taxa de `parse_falhou` e `tripe_rejeitado` do SSW** (detector de "SSW mudou o HTML").
- **`localizacao` vazia no tripé** (detector do fail-open R-T1).
- **Falso-positivo de sucesso** (divergência entre `acoes_executadas_ssw.sucesso=true` e o histórico SSW).
- **Cards presos:** `ACAO_EXECUTADA > 1h`, `BLOQUEADO_POR_ERRO`, `AGUARDANDO_CLIENTE` com oc relac≠54, linhas `sucesso=null` órfãs.
- **DLQ de cliente** (mensagens presas / perdidas >60min).
- **Anthropic:** taxa de 429/529, latência, **custo em $/dia**.
- **Sync-bastao:** duração por run, overlap de runs, passes pulados por deadline.
- **Fila pgmq:** profundidade por fila (detector de loop — INV-028).
- **Auth:** mudanças em `operadores.papel`; invocações anômalas de endpoints `verify_jwt=false`.

### 18.3 Alertas que precisam existir
- Bastão parado (max(updated_at) > 45min) — já parcialmente usado.
- SSW retornando HTML inesperado (parse_falhou crescente).
- Card preso > SLA por estado.
- Gasto Anthropic acima do orçamento.
- Qualquer `UPDATE` de `operadores.papel`.

---

## 19. Perguntas em Aberto

> Estas exigem acesso ao **ambiente de produção** (banco/cron/SSW), não só ao código. São lacunas que esta auditoria não pôde fechar.

1. **Qual o cron REAL do `sync-bastao`?** Código/mig 097 = 30min; comentário mig 255 = "5/5min". `SELECT jobname, schedule FROM cron.job`. Define o risco de overlap.
2. **Quantas linhas `acoes_executadas_ssw` com `sucesso IS NULL` existem hoje?** Cada uma é um todo travado para relançar.
3. **Quantos cards estão `ACAO_EXECUTADA` há >1h?** E `BLOQUEADO_POR_ERRO`? Mede se o risco de G/H pulados se materializa.
4. **`cards.pagador` guarda CNPJ ou nome?** Define se a RLS por carteira está furada/dependendo de `segmento_codigo`.
5. **O Supabase mata a edge em ~150s?** O deadline de 110s assume isso; se for menor, passes tardios morrem.
6. **A label "Localização atual" do SSW já mudou alguma vez?** Determina se o fail-open do tripé já disparou silenciosamente.
7. **Frequência real de 529 da Anthropic** e quantas mensagens já morreram no DLQ por >60min.
8. **A escalação operador→gestor é explorável de fato?** Testar `PATCH /rest/v1/operadores?user_id=eq.<uid>` com `{"papel":"gestor"}` autenticado como operador comum.
9. **Há WAF/rate-limit/Cloudflare** na frente das Edge Functions em produção? (a anon key é pública).
10. **Postmark inbound e Resend** ainda são canais ativos, ou foram totalmente substituídos pelo Gmail?
11. **O callback OAuth no Vercel** (fora do repo) — como valida o `state` e grava o refresh token? É onde a segurança do token Gmail de todas as operadoras é decidida.
12. **`agente-oc13-autonomo` precisa de flag boolean antes de produção**, ou o allowlist de CNPJ é aceito como kill-switch?
13. **Existe staging/réplica**, ou tudo é aplicado direto em produção via Management API?
14. **Qual o plano de rotação** das credenciais SSW/service-role/Anthropic/Evolution (todas estáticas)?
15. **O auditor Opus** (descrito em AGENTS.md) existe ou foi descontinuado? (nenhuma função usa Opus hoje).

---

## 20. Avaliação Final (auditoria brutal, sem defender nada)

> Premissa do exercício: fui contratado **hoje** como Staff Engineer para **aprovar ou reprovar** este sistema antes de produção. Esqueço que ajudei a construí-lo. Sou rigoroso, não gentil.

### Veredito geral
**Reprovo o deploy "como está" para qualquer expansão de escopo/volume, e aprovo apenas a continuidade do uso interno atual condicionada a corrigir os 8 bloqueadores da Seção 17.** O sistema é **surpreendentemente competente** em alguns eixos (idempotência de lançamento, event sourcing, 25 invariantes com verificação executável, redes de segurança em 3 camadas, INV-016 estrutural) — é um nível de disciplina raro para um projeto sem time de dev. **Mas a robustez é frágil exatamente onde mais importa**, e há furos de segurança que um pentest acharia em minutos.

A contradição central: o projeto trata os sintomas com excelência (cada bug vira um INV + teste-guard + memória), mas **não trata as classes de causa-raiz** (monólito não testado, scraping frágil, auth furada, regras duplicadas). Está sempre apagando incêndio com extintor caro, sem trocar a fiação.

### O que impediria o deploy (bloqueadores)
1. **Escalação de privilégio operador→gestor** (RLS sem `WITH CHECK`). É trivial de explorar e dá RLS total. Inaceitável.
2. **Endpoints sensíveis sem autenticação** (`executor`, `ingestor`, `send-whatsapp-message`, agentes que lançam oc) confiando numa anon key pública.
3. **Guard tripé fail-open na localização** — a única proteção contra "lançar em CTRC entregue/cancelado" tem um buraco silencioso. Viola a regra-mãe do próprio sistema (CLAUDE.md).
4. **Detecção de sucesso de lançamento por scraping/negação** + **AbortError não tratado** — o sistema pode afirmar que lançou uma oc que não existe (ou o contrário), e deletar anexos com base nisso.
5. **Refresh token Gmail em plaintext legível cross-operador.**

### O que mais me preocupa
- **O `sync-bastao` (4081 linhas) é um monólito de decisão sem teste**, com uma função de 1237 linhas e 9 ramos interdependentes, validado só por grep e SQL em produção. É o arquivo que mais mexe em estado e o que mais regrediu. **Toda edição aqui é uma aposta.**
- **A dependência total de scraping de HTML do SSW.** O negócio inteiro (lançar ocorrência) depende de o SSW não mudar a UI. Não há contrato, não há fixture de teste, não há alerta de "o HTML mudou".
- **Bus factor 1** (Caio + Claude Code). Sem o autor, ninguém entende a árvore de `upsertCardFromPendencia`.

### Onde há maior chance de bugs
- `upsertCardFromPendencia` (sync-bastao) — interação entre 9 ramos + `effState`/`effLock`.
- `proporAutoAcaoSeAplicavel` (deus-função, 16 consumidores, 8 testes).
- O envelope/tripé/submit do SSW (scraping + estados de erro).
- As 3 listas divergentes de "ocs de relacionamento".

### Onde há maior chance de regressão
- Qualquer edição em `sync-bastao` ou `regras-auto-acao.ts` (alto fan-in, baixo teste).
- Tocar nas regras hardcoded duplicadas (`{6,9,16}`/`{1,30,32}`).
- Desligar/religar um Pass do sync ou um item de set (histórico: INV-010, INV-019).
- Refatorar mensagens de erro do SSW (acoplamento textual com `categorizar-erro-ssw`).

### O que eu refatoraria imediatamente
1. Extrair a máquina de estados do `sync-bastao` para `lib/` puro **com testes** (a maior dívida).
2. Substituir a detecção de sucesso do SSW por **confirmação positiva** (consultar o histórico pós-submit).
3. Tornar o tripé **inteiramente fail-closed** e instrumentado.
4. Fechar a RLS de `operadores` (escalação) e autenticar os endpoints internos.
5. Unificar as regras de oc numa fonte única (dicionário).
6. Quebrar `proporAutoAcaoSeAplicavel` e `processOne` (executor) em unidades testáveis.

### O que eu monitoraria nas primeiras 24 horas
- Cards presos (`ACAO_EXECUTADA>1h`, `BLOQUEADO_POR_ERRO`, `sucesso=null` órfãs).
- Taxa de `parse_falhou`/`tripe_rejeitado` + `localizacao` vazia (SSW mudou?).
- Divergência lançamento×histórico SSW (falso-positivo).
- DLQ de cliente + 529 da Anthropic.
- Overlap de runs do sync + passes pulados por deadline.

### O que eu monitoraria na primeira semana
- Custo Anthropic em $/dia (tendência).
- Profundidade das filas pgmq (loop — INV-028).
- Latência do board por operador não-gestor (RLS/índice — próximo apagão).
- Taxa de aprovação das ações dos agentes autônomos (shadow → produção).
- Qualquer `UPDATE` em `operadores.papel`.
- Cards que oscilam de aba (corrida vt/sync).

### O que pode gerar incidentes em produção
- SSW muda o HTML → lançamento quebra (fail-closed) ou guard fura (fail-open).
- Anthropic 529 prolongado → fila/triador travam.
- Bastão atrasa/cai → decisões de fechamento erradas (fail-open).
- Overlap do sync → estado corrompido.
- Crescimento de `cards` → apagão de RLS de novo.
- Loop de fila → custo e afogamento (INV-028 já mostrou o padrão).

### Os 20 maiores riscos deste projeto (ranqueados)
1. Escalação de privilégio operador→gestor (segurança, crítico).
2. Endpoints sensíveis sem auth confiando na anon key pública (segurança, crítico).
3. Tripé fail-open na localização (lança em CTRC encerrado) (correção, crítico).
4. Detecção de sucesso de lançamento por scraping/negação (correção, crítico).
5. AbortError no submit não tratado + linha `sucesso=null` órfã (correção/perda, alto).
6. `sync-bastao` monólito sem teste (manutenção/correção, crítico).
7. Refresh token Gmail em plaintext cross-operador (segurança, alto).
8. `cards.pagador` sem índice em filtro RLS per-row (escalabilidade, crítico sob volume).
9. Anthropic sem retry/timeout (resiliência, alto).
10. Deadline pula G/H → cards `ACAO_EXECUTADA` presos sem TTL (correção, alto).
11. Sync sem mutex → overlap/double-write (concorrência, alto).
12. 3 listas divergentes de "ocs de relacionamento" (manutenção/correção, alto).
13. Zero CI / zero eval (qualidade, alto).
14. Migrations sem transação/rollback + sem staging (perda de dados/operacional, alto).
15. Dependência total de scraping de HTML do SSW (arquitetura, alto).
16. `proporAutoAcaoSeAplicavel` deus-função com 16 consumidores (manutenção, alto).
17. Apagão de RLS resolvido só em 2/19 tabelas (escalabilidade, médio-alto).
18. `agente-oc13-autonomo` sem kill-switch de flag (operacional, médio).
19. `run_managed_agent_query` pode ler segredos (segurança, médio).
20. Bus factor 1 + docs divergentes (continuidade, médio-alto).

### Decisões que considero ruins (explícitas)
- **Lançar ocorrência via scraping com sucesso por negação** é a decisão mais arriscada do sistema — entendo que o SSW não dá API, mas a confirmação tinha que ser positiva desde o dia 1.
- **`verify_jwt=false` sem auto-autenticação** em dezenas de funções sensíveis é segurança por obscuridade.
- **Crescer o `sync-bastao` para 4081 linhas sem extrair a lógica para módulos testáveis** transformou o coração do sistema num lugar onde ninguém pode mexer com confiança.
- **Manter docs (`AGENTS.md`, `STATE_MACHINE.md`, `DATA_MODEL.md`) que mentem sobre o sistema** é pior que não ter docs — induz a erro.
- **Confiar a idempotência a uma UNIQUE que inclui `todo_id`** enquanto a documentação afirma `(card,oc,ctrc)` é uma armadilha esperando a próxima reaprovação manual.

### O que é genuinamente bom (para calibrar o veredito)
Idempotência de lançamento (INSERT-antes-do-submit); event sourcing imutável por trigger; os 25 invariantes com verificação executável e cenário-âncora; INV-016 (resposta de cliente sempre visível) com 3 camadas determinísticas; o gate de frescor do Bastão; a disciplina de transformar cada bug em teste-guard + memória + ADR. **Isso é mais maduro que a média do mercado.** O problema não é falta de cuidado — é cuidado aplicado aos sintomas, não às classes de causa-raiz.

---

*Fim do AI_AUDIT_CONTEXT.md — documento de contexto para auditoria técnica independente. Última varredura do código: 2026-06-26.*

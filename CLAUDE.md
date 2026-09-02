# Contexto crítico — Cockpit v2

Sistema de agentes autônomos pra tratativas de NF na Sal Express (transportadora B2B em MG/ES). Evolução do v1 (Lovable + Supabase). Para visão completa de produto, leia `docs/PRD.md` antes de propor mudanças.

## REGRA CRÍTICA — Diagnóstico antes de correção

**Gatilho:** sempre que o Caio disser "temos uma correção", "precisa corrigir", "isso é bug", "não está funcionando", "fix", "regressão", ou apontar QUALQUER problema — esta regra entra em vigor ANTES de qualquer outra coisa. Não saia afirmando causa raiz sem verificar evidência primeiro.

1. **Proibido afirmar causa raiz sem evidência.** É proibido dizer "o bug é X", "existem 2 bugs", "a causa é Y" ou propor fix definitivo ANTES de verificar evidência direta no código, logs, banco, testes ou diff. Sem evidência verificada não há diagnóstico — só palpite.

2. **Relatório obrigatório com rótulos exatos.** Toda correção começa com um relatório usando EXATAMENTE estes rótulos, nesta ordem:
   - **Sintoma observado**
   - **Comportamento esperado**
   - **Evidências verificadas**
   - **Hipóteses consideradas**
   - **Hipóteses descartadas**
   - **Causa raiz confirmada**
   - **Fix proposto**
   - **Riscos / blast radius**
   - **Como validar**

3. **Hipótese não confirmada é hipótese, não fato.** Se a evidência ainda não confirmar a causa, escrever literalmente "hipótese não confirmada" — nunca afirmar como fato.

4. **Dois sintomas ≠ dois bugs.** Só pode dizer que são dois bugs depois de PROVAR que existem duas causas independentes. Até lá, são dois sintomas (que podem compartilhar uma única causa).

5. **Fix ataca a raiz, não o sintoma.** Antes de editar código, explicar por que o fix proposto ataca a causa raiz e não apenas o sintoma. (Reforça a regra "sempre corrigir na RAIZ, não o caso".)

6. **Bug em produção exige checklist de fechamento.** Avaliar EXPLICITAMENTE se precisa: retroativo, teste anti-regressão, migration, evento em `card_events`, ajuste em memória/ADR, e item no `/verify-cockpit`. (Casa com a convenção inegociável nº 8 — toda construção vira memória + guard anti-regressão.)

7. **Questionamento reabre o diagnóstico.** Se o Caio questionar a conclusão, REABRIR o diagnóstico e procurar evidência nova — nunca defender a resposta anterior por inércia.

8. **Separar fato de inferência.** Respostas de correção devem separar claramente:
   - **Fato verificado**
   - **Inferência**
   - **Hipótese**
   - **Decisão de implementação**

## REGRA CRÍTICA — Lançamento de Ocorrência SSW

NUNCA lançar ocorrência usando apenas o número da NF para localizar o CTRC.
O CTRC correto é SEMPRE o que está registrado no card da tratativa.

Motivo: a mesma NF pode ter múltiplos CTRCs no sistema (cancelados, baixados, finalizados).
O SSW rejeita lançamento em CTRC encerrado. Isso não é bug — é dado errado sendo usado.

Fluxo obrigatório:
1. Ler o CTRC diretamente do card
2. Usar esse CTRC + NF para abrir a tela de Ocorrências no portal SSW (opção 101)
3. Validar o tripé (CTRC + NF + Localização atual) ANTES do submit
4. Jamais substituir ou sobrescrever o CTRC do card com qualquer resultado de busca por NF

Exemplo real do erro: NF 142371 tinha CTRCs OVD396328-4 (ativo, correto) e OVD399372-8
(cancelado). O agente usou o cancelado e o SSW retornou DOCUMENTO BAIXADO OU ENTREGUE.

**Implementação obrigatória (Caio 2026-06-08):** TODA chamada a `lancarOcorrenciaPortal`
no executor / agentes deve passar pelo envelope `lancarSswPortal` em
[`_shared/lancar-ssw-portal.ts`]. O envelope:

1. **Idempotência:** INSERT em `acoes_executadas_ssw` com `UNIQUE(card_id, codigo_oc, ctrc)`
   ANTES de chamar SSW. Hit no UNIQUE = ação já executada → skip sem chamar SSW de novo
   (substitui a `idempotency_key` SHA-256 da antiga WebAPI).

2. **Guard tripé inviolável** via `validarTripeCtrcNfPagador()` em
   [`_shared/validar-tripe-ssw.ts`]. Roda DENTRO do `lancarOcorrenciaPortal` (callback
   `validarAntesDoSubmit`), com o HTML do `act=O` em mãos, ANTES do submit.
   Valida 3 condições:
   - (a) CTRC retornado pelo SSW (label `CTRC:`) bate caractere-a-caractere com `card.ctrc`
     (normalização: upper + trim);
   - (b) NF do CTRC no SSW (label `Nota fiscal:`) bate com `card.nf` (normalização:
     zeros à esquerda + prefixo `<série>/`);
   - (c) `Localização atual` NÃO contém keywords proibidas: `ENTREGUE`, `BAIXADO`,
     `FINALIZADO`, `CANCELADO`, `SUBSTITUIDO`.
   Se falhar → abort + reverter via `reverter_acao_falhou` + card_event `TripeRejeitadoPeloGuard`
   + nunca chama submit. Nada de fallback "tenta outro CTRC".

3. **Portal opção 101 SEMPRE** (não usar WebAPI). O texto vai no campo `Instrução`
   (textarea, maxlength=500), não em `Informações complementares` (curto, 70 chars).
   Código semântico direto (sem `ocorrencias_dexpara` / `lookup_codigo_api` — esses
   morrem na mig 195).

4. **Body do submit DEVE ser latin-1** (Caio 2026-06-10). Portal SSW serve
   `charset=iso-8859-1` e descarta `observ` silenciosamente quando recebe bytes
   UTF-8 multi-byte. Helpers `sanitizarParaLatin1` + `urlEncodeLatin1` em
   [`_shared/ssw-internal-client.ts`] aplicados no submit `act=II3`. Content-Type
   deve ter `; charset=iso-8859-1`. NUNCA usar `URLSearchParams.toString()`
   direto pra body do portal. Casos âncora: NF 2161614, 156022, 2282024 — 4 NFs
   confirmadas com `observ` vazio entre 2026-06-08 e 2026-06-10.

5. **Extras que viram texto SSW são whitelist explícita** (Caio 2026-06-10).
   `EXTRAS_PRA_DESCRICAO_SSW = {quantidade_volumes, motivo, filial,
   texto_complementar}` no `processOne`. Iterar com `Object.entries(extras)`
   VAZAVA flags internas (`validar_evidencia: false`, `responder_thread_cliente:
   [object Object]`) pra Instrução SSW. Pra adicionar campo novo, EXTENDA a
   whitelist explicitamente.

REMOVIDO 2026-06-08: `validarChaveCteCorrespondeCtrcDoCard`, dependência de
`nf_chave_cte`, `chave_cte` 44 dígitos, `lookup_codigo_api`,
`lookup_chaves_cte_alternativas`, e o RPA OPC 455 inteiro.

## Diretriz de produto (ler com atenção)

- **Não é mais copiloto humano.** É sistema de agentes autônomos que agem sobre cards de NF.
- **Operador valida, não executa.** To-do = "aprovar ação do agente", não "fazer a ação".
- **Card é o centro.** Mensagem só importa quando vinculada a um card. Chatbot genérico **não é foco**.
- **Não é produto multi-tenant.** Uso interno da Sal Express. Sem escopo de venda. Toda complexidade de SaaS está fora.
- **Cockpit é apenas pro time de Relacionamento.** Outras áreas (Devolução, Ressarcimento, Perdas, Agendamento, Operação) ficam em ferramentas próprias / projetos paralelos. Bastão é a fonte de pendências; Cockpit puxa periodicamente as 16 ocorrências de relacionamento + 54 (cliente). Cards de outras ocorrências entram só via mensagem do cliente. Ver ADR 0004.

## Skills obrigatórias por contexto

- **Toda vez que envolver SQL / migration / schema / RPC / RLS / política / função Postgres / índice / advisor — INVOCAR a skill `supabase-postgres-best-practices` ANTES de propor a solução.** Aplicar quando: criar/editar arquivo em `migration/*.sql`, escrever `ALTER TABLE` / `CREATE TABLE` / `CREATE FUNCTION` / `CREATE POLICY`, mexer em `SECURITY DEFINER`, decidir sobre RLS, otimizar query lenta, ou responder pergunta sobre performance Postgres. Não é opcional. Mesmo que pareça trivial — verificar índices, RLS, security_definer, search_path, e demais regras da skill.
- **Toda vez que envolver regras de negócio de ocorrência SSW** (significado, responsabilidade, fluxo) — invocar `logistics-exception-management` antes de inferir.
- **Antes de cada commit/push significativo** — rodar `/verify-cockpit` (slash command próprio, em `.claude/commands/verify-cockpit.md`).
- **Banco e deploy SÓ pelo trilho** (`docs/RITUAL_DEPLOY.md`): SQL via `python3 scripts/dbq.py` (TIPO B exige `--autorizado-por`), deploy pendente via `python3 scripts/deploy_pendente.py`, edge via `supabase functions deploy` sob o deploy-gate. Vale em qualquer máquina (Windows do Carlos incluído). Se o Claude pedir permissão no meio do ritual, ele saiu do trilho — não inventar script nem colar SQL no painel.

## Convenções inegociáveis

1. **Event sourcing do card.** Toda mudança de estado é evento em `card_events`. `cards` é projeção. Nunca atualize `cards` sem evento correspondente.
2. **Agente nunca chama serviço externo direto.** Sempre via adapter (`lib/ssw-client.ts`, `lib/evolution-client.ts`, etc.) com retry + idempotency key + cache onde aplicável.
3. **Toda ação de agente vira `audit_log`** com agente, payload, resultado, motivo.
4. **Validação humana é estado explícito** (`AGUARDANDO_VALIDACAO_HUMANA`). Aprovação dispara evento, evento dispara executor.
5. **Prompts em arquivos** (`prompts/*.md`), nunca inline no código. Mudança de prompt = commit revisável + rodar `evals/`.
6. **Idempotência no SSW.** Lançar a mesma ocorrência 2x não pode acontecer. Use `idempotency_key` derivada de `(card_id, codigo_ocorrencia)`.
7. **Roteamento de modelo:** Haiku 4.5 pra triagem/classificação, Sonnet 4.6 pra agentes especialistas, Opus 4.7 só pra auditoria/casos complexos.
8. **Toda construção vira memória + guard anti-regressão.** Ao TERMINAR qualquer diretriz / regra de negócio / feature / agente / fluxo / decisão de UX, ANTES de encerrar a tarefa: (a) salvar **memória** (`project` ou `feedback`) com o quê + *why* + *how to apply* + caso-âncora (NF/card) + migração/commit/edge; (b) se for **código**, backar com pelo menos UM **guard de não-regressão** — teste em `lib/`, item no checklist `/verify-cockpit`, ou ADR. Memória sozinha não trava regressão de código. Motivo: já regredimos várias vezes (oc=23 sem regra, extravios travando AVH, dexpara dropada) por regra que existia só "na cabeça"/num commit antigo e ninguém reancorou. Higiene: índice `MEMORY.md` = 1 linha curta por memória (detalhe no arquivo-tópico); não deixar estourar o limite de contexto.

## Convenções de código

- TypeScript estrito (`strict: true`, `noUncheckedIndexedAccess: true`).
- Funções puras em `lib/` testadas com Vitest/Bun test.
- Migrations em `migration/` com prefixo de data: `2026-04-29_001_<descricao>.sql`.
- Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`.
- ADR pra qualquer decisão de arquitetura: novo arquivo em `docs/decisions/NNNN-<slug>.md`.
- **Nunca commitar `.env.local`.** Só `.env.example` no repo.
- **Front tem DOIS trilhos durante a migração (obrigatório confirmar).**
  - **Lovable = produção atual dos operadores.** Se a tarefa for no Lovable, NÃO editar `apps/cockpit-web/`; gerar prompt pronto pra colar no Lovable com detalhes de backend (tabelas/colunas, RLS, RPCs, payload).
  - **Front próprio = `apps/cockpit-web/` / Vercel homologação.** Se a tarefa for no front próprio, NÃO gerar prompt Lovable; editar somente `apps/cockpit-web/` e manter backend/RPC/Edge/payload intactos salvo pedido explícito.
  - Se o pedido envolver front/UI/tela/layout/kanban/card e NÃO disser claramente `MODO LOVABLE` ou `MODO FRONT PRÓPRIO`, PARE e pergunte qual trilho usar antes de planejar, editar ou deployar. Hook automático: `.claude/hooks/cockpit-front-mode-gate.py`.

## Comandos comuns

```bash
# Aplicar migrations
psql "$SUPABASE_DB_URL" -f migration/2026-04-29_001_initial_schema.sql

# Rodar evals
bun run evals

# Testar lib pura
bun test lib/

# Edge Function local
supabase functions serve <nome>
```

## Decisões já tomadas (ler ADRs antes de questionar)

- **0001:** Supabase-only. Sem Inngest/Vercel agora. Reconsiderar quando workflows ficarem complexos.
- **0002:** Event sourcing do card. Não negocia.
- **0003:** Sem multi-tenant. Single-tenant Sal Express.

## Antes de propor mudança grande

1. Já existe ADR sobre? Lê primeiro.
2. Quebra alguma das convenções acima? Justifica.
3. Adiciona dependência nova? Sustenta o custo cognitivo (ex.: novo provider = mais um dashboard, mais uma chave).

## O que NÃO fazer

- Não criar tabela operacional importando do schema antigo (`legacy.*` é read-only pra eval).
- Não usar `mensagens` como agregado. Tabela equivalente nova é `cards`, alimentada por `card_events`.
- Não chamar Anthropic/SSW/Evolution direto de Edge Function de webhook — vai pra fila e agente consome.
- Não adicionar Inngest/Vercel/serviço novo sem abrir ADR e discutir.

## Stack atual

Lovable (UI) + Supabase (DB + Auth + Realtime + pgmq + pg_cron + Edge Functions) + Claude SDK + Evolution API + Resend + Postmark inbound + Bastão (Supabase externo) + SSW (TMS).

## Backup do v1

Em `../backup_lovable/backup-sal-express-2026-04-28/`. **Não importar schema/data direto.** Extrair conhecimento (prompts, regex, regras, dedup, cliente SSW) pra `lib/` e `prompts/` do v2.

# Contexto crítico — Cockpit v2

Sistema de agentes autônomos pra tratativas de NF na Sal Express (transportadora B2B em MG/ES). Evolução do v1 (Lovable + Supabase). Para visão completa de produto, leia `docs/PRD.md` antes de propor mudanças.

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

## Convenções inegociáveis

1. **Event sourcing do card.** Toda mudança de estado é evento em `card_events`. `cards` é projeção. Nunca atualize `cards` sem evento correspondente.
2. **Agente nunca chama serviço externo direto.** Sempre via adapter (`lib/ssw-client.ts`, `lib/evolution-client.ts`, etc.) com retry + idempotency key + cache onde aplicável.
3. **Toda ação de agente vira `audit_log`** com agente, payload, resultado, motivo.
4. **Validação humana é estado explícito** (`AGUARDANDO_VALIDACAO_HUMANA`). Aprovação dispara evento, evento dispara executor.
5. **Prompts em arquivos** (`prompts/*.md`), nunca inline no código. Mudança de prompt = commit revisável + rodar `evals/`.
6. **Idempotência no SSW.** Lançar a mesma ocorrência 2x não pode acontecer. Use `idempotency_key` derivada de `(card_id, codigo_ocorrencia)`.
7. **Roteamento de modelo:** Haiku 4.5 pra triagem/classificação, Sonnet 4.6 pra agentes especialistas, Opus 4.7 só pra auditoria/casos complexos.

## Convenções de código

- TypeScript estrito (`strict: true`, `noUncheckedIndexedAccess: true`).
- Funções puras em `lib/` testadas com Vitest/Bun test.
- Migrations em `migration/` com prefixo de data: `2026-04-29_001_<descricao>.sql`.
- Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`.
- ADR pra qualquer decisão de arquitetura: novo arquivo em `docs/decisions/NNNN-<slug>.md`.
- **Nunca commitar `.env.local`.** Só `.env.example` no repo.

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

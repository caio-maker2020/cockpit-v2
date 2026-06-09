# Contexto crítico — Cockpit v2

Sistema de agentes autônomos pra tratativas de NF na Sal Express (transportadora B2B em MG/ES). Evolução do v1 (Lovable + Supabase). Para visão completa de produto, leia `docs/PRD.md` antes de propor mudanças.

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

# ADR 0003 — Sem multi-tenant; single-tenant Sal Express

**Data:** 2026-04-28
**Status:** Aceito

## Contexto

Versão preliminar do plano (antes de Caio confirmar) considerava arquitetar pra múltiplos clientes (outras transportadoras), com isolamento por `tenant_id`, RLS por tenant, secrets por tenant, onboarding self-service.

Caio confirmou: **uso interno da Sal Express. Sem ambição de vender pra outras transportadoras.**

## Decisão

Single-tenant. Schema sem `tenant_id`. RLS por papel real (`operador` vs `gestor`), não por tenant. Secrets globais (.env.local). Sem onboarding self-service.

## Consequências

**Removido do escopo:**
- Coluna `tenant_id` em todas as tabelas
- Políticas RLS por tenant
- Tabela `tenants` e gestão de tenant
- Branding/customização por cliente
- Onboarding self-service
- Cobrança por seat
- Compliance/DPA com múltiplos clientes
- Migração de WhatsApp pra Cloud API oficial (Meta) por questão de banimento multi-cliente — Evolution dedicada serve

**Ganhos:**
- Schema mais simples
- RLS mais simples e correto
- Lógica de aplicação não precisa filtrar por tenant
- Tempo de MVP cai de 13-17 semanas pra 8-12

## Gatilho pra reconsiderar

Caio decidir que quer vender. Nesse caso, refactor pra multi-tenant é trabalhoso mas viável (adicionar `tenant_id`, ativar RLS, multiplicar secrets). Não impossível, mas é um projeto à parte que justifica reabrir esse ADR.

Sinais que disparariam reconsideração:
- 1+ transportadora pedindo pra usar
- Validação clara de mercado externa (não só ideia)
- Apetite de Caio pra virar empresa de produto

Até lá: single-tenant é a postura correta.

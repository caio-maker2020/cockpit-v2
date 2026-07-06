---
description: Ativa o modo front proprio/Vercel para tarefas em apps/cockpit-web
---

# /modo-front-proprio

Use este modo para tarefas no **front próprio** em `apps/cockpit-web/` (Vercel/homologação).

Regras obrigatórias:

- Não gerar prompt Lovable.
- Não mexer no Lovable.
- Editar somente `apps/cockpit-web/` e docs de migração quando necessário.
- Não alterar backend, migrations, RLS, RPCs, Edge Functions ou payloads salvo pedido explícito do Caio.
- Não criar testes destrutivos.
- Fluxos que aprovariam ação, responderiam e-mail, lançariam OC/SSW ou forçariam atualização real são sempre validação manual com card controlado e aprovação explícita do Caio.
- Build/type-check devem passar antes de commit/deploy de front.

Antes de responder, confirme em uma linha:

`MODO FRONT PRÓPRIO / VERCEL confirmado.`

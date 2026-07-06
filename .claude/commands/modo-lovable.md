---
description: Ativa o modo Lovable/producao atual para tarefas de front
---

# /modo-lovable

Use este modo para tarefas no **front atual em Lovable** (produção dos operadores).

Regras obrigatórias:

- Não editar `apps/cockpit-web/`.
- Não mexer no front próprio/Vercel.
- Se envolver UI/tela/aba/listagem/formulário, gerar **prompt pronto para colar no Lovable**.
- Incluir detalhes de backend necessários ao Lovable: tabelas/colunas, RLS, RPCs/assinatura, Edge Functions, shape de payload.
- Não alterar backend, migrations, RLS, RPCs ou Edge Functions salvo pedido explícito do Caio.
- Objetivo: corrigir/ajustar a produção atual enquanto a migração do front próprio segue em paralelo.

Antes de responder, confirme em uma linha:

`MODO LOVABLE / PRODUÇÃO ATUAL confirmado.`

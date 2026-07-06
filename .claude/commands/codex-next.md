---
description: Executa o proximo handoff preparado pelo Codex em audits/CLAUDE_INBOX.md
---

# /codex-next

Leia o arquivo:

`audits/CLAUDE_INBOX.md`

Execute somente o que estiver nesse arquivo.

Regras obrigatorias:

- Se `audits/CLAUDE_INBOX.md` estiver vazio, incompleto ou ambiguo, pare e diga isso.
- Nao avance para fases que nao estejam explicitamente autorizadas no inbox.
- Nao use instrucoes antigas do chat para ampliar escopo.
- Nao aplique SQL de escrita, migration, deploy, mudanca de RLS, trigger ou alteracao de dados de producao sem aprovacao explicita dentro do inbox.
- Se encontrar decisao de negocio, risco de visibilidade de cards ou duas opcoes com riscos diferentes, pare e pergunte.
- Ao terminar, escreva um resumo completo em `audits/CLAUDE_OUTBOX.md`.

Formato obrigatorio de `audits/CLAUDE_OUTBOX.md`:

```md
# Claude Outbox

## Status

Concluido / Bloqueado / Precisa de aprovacao

## O que foi feito

- ...

## Arquivos alterados

- ...

## Comandos executados

- ...

## Resultado

- ...

## Riscos ou decisoes pendentes

- ...

## Proximo passo recomendado

- ...
```

Depois de escrever o outbox, pare. Nao continue para a proxima fase sozinho.

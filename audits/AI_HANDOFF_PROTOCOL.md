# Protocolo de handoff Codex <-> Claude Code

Objetivo: evitar copiar e colar prompts longos entre Codex e Claude Code.

## Como usar

1. O Codex escreve a proxima instrucao em `audits/CLAUDE_INBOX.md`.
2. No Claude Code, voce digita apenas:

```text
/codex-next
```

3. O Claude Code le `audits/CLAUDE_INBOX.md`, executa somente aquele escopo e grava o resultado em:

```text
audits/CLAUDE_OUTBOX.md
```

4. De volta no Codex, voce diz:

```text
leia o outbox do Claude
```

5. O Codex le `audits/CLAUDE_OUTBOX.md`, valida o resultado e prepara a proxima instrucao no inbox.

## Regras de seguranca

- Cada inbox deve conter uma unica fase ou um unico pacote pequeno de trabalho.
- O Claude deve parar apos escrever o outbox.
- Mudancas em producao, RLS, trigger, migration, deploy e SQL de escrita exigem aprovacao explicita.
- Se houver duvida de negocio, o Claude deve perguntar antes de agir.
- Refatoracoes grandes nao entram nesse fluxo sem plano separado.

## Se o comando nao aparecer no Claude Code

Feche e abra a sessao do Claude Code no projeto, ou mande uma unica vez:

```text
Leia e siga .claude/commands/codex-next.md
```

Depois disso, use `/codex-next`.

# Boas práticas — Git & Deploy (guia do Caio)

> Escrito em 2026-07-06, depois da regularização do incidente em que um deploy a
> partir do git desatualizado apagou o guard INV-027 de produção (executor v130).
> Linguagem de não-técnico, de propósito. Commit da regularização: `883ff15`.

## As 6 Regras de Ouro

1. **Salvar antes de publicar. SEMPRE.**
   Nunca deployar código que não foi commitado. A ordem é sagrada:
   **testar → commitar → deployar.** Foi deployar-sem-salvar que causou a
   regressão do guard (v129/v130).

2. **Fechou uma correção que funcionou? Commit na hora.**
   Não deixar pra "depois que eu terminar tudo". Correção validada = commit
   imediato. Coisa não-salva é coisa que pode sumir com um clique.

3. **Um trabalho, um commit.**
   Não acumular 147 arquivos de novo. O commit grande de 2026-07-06 foi uma
   emergência de resgate — o normal é pequeno e frequente (1 correção = 1 commit).

4. **Antes de qualquer deploy, perguntar: "o que estou prestes a APAGAR de produção?"**
   Quem deploya (Caio, Claude ou Codex) confere ANTES o que já roda lá
   (grep nos markers das proteções no `/body` da função). Subir por cima sem
   conferir foi o que apagou o guard.

5. **Push no fim do dia.**
   Commit protege contra cliques errados; push protege contra o computador
   morrer. 10 segundos, backup completo.

6. **Todo deploy deixa rastro.**
   Depois de deployar, **registrar qual commit foi** (ex.: `883ff15`) junto da
   versão que ficou em produção (ex.: `executor v131`). Se algo regredir, sabe-se
   na hora de qual estado veio — sem investigação por grep.
   Antes de aceitar qualquer deploy (do Caio, do Claude ou do Codex), a pergunta é:
   **"de qual commit você está deployando?"** — se a resposta não for um commit
   específico, **PARE.** (A confusão v129/v130/v131 nasceu de ninguém saber qual
   commit estava em produção.)

## Commit vs Push (sem jargão)

- **Commit** = apertar **"Salvar"** no documento. Registra no histórico do
  computador. **É o que trava regressão.**
- **Push** = mandar **cópia pra nuvem** (GitHub). É o backup. Não muda produção.
- Frequência: **commit** toda vez que algo ficar pronto e testado;
  **push** pelo menos ao fim do dia.

## A rotina simples (post-it)

> Terminou algo que funciona? → **"commita isso"** (Claude roda testes, commita e confirma).
> Vai subir pra produção? → perguntar antes: **"está commitado? de qual commit?"** — só deployar se sim.
> Deployou? → **anotar commit + versão** (regra 6).
> Fim do dia → **"faz o push"**.

## Comandos/botões PERIGOSOS — sempre chamar o Claude antes

- **"Descartar alterações" / Discard / Revert** no editor → apaga trabalho não-salvo, sem lixeira.
- `git reset --hard`, `git checkout .`, `git clean` → mesma coisa, versão terminal.
- **Qualquer deploy** (`supabase functions deploy ...`) → pode sobrescrever proteção que está rodando.
- **Force push** → reescreve o histórico da nuvem.
- Regra prática: **palavra com "descartar", "reset", "force" ou "deploy" → chamar o Claude primeiro.**

## Vale pros robôs também

Exigir de qualquer IA (Claude, Codex) a mesma ordem (commit → deploy), a pergunta
da regra 4 (o que já roda em produção?) e a da regra 6 (de qual commit?). O que
salvou o dia 2026-07-06 foi o Caio ter invertido a ordem proposta (commit antes
do deploy).

## Registro de deploys (regra 6 em prática — manter atualizado)

| Data | Função | Versão | Commit | Quem |
|---|---|---|---|---|
| 2026-07-06 | executor | v131 | `883ff15` | Claude (regularização) |
| 2026-07-06 | agente-sugere-ocs-padrao | v52 | fonte prod v51 + fix Bug 1 (consolidado em `883ff15`) | Claude |
| 2026-07-06 | executor | v130 | `4c30662` (HEAD desatualizado — **REGRESSÃO**, corrigida no v131) | Codex |

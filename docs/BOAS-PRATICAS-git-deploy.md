# Boas práticas — Git & Deploy (guia do Caio) — 7 regras

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

7. **Vários chats ao mesmo tempo = cada um na sua bancada.**
   Vários chats (Claude/Codex) na MESMA pasta é como vários cozinheiros na mesma
   tábua de corte: quando um monta o prato (commit), vai junto ingrediente dos
   outros. Duas defesas:
   - **Commit cirúrgico (sempre):** cada chat commita SÓ os arquivos que ELE
     mexeu, listados um a um. **`git add -A` / `git add .` é PROIBIDO** em
     trabalho paralelo (só em resgate/emergência, consciente).
   - **Worktree (trabalho paralelo de verdade):** começar o chat pedindo
     *"trabalhe num worktree próprio"* — cada chat ganha sua própria pasta com o
     mesmo histórico; misturar vira impossível. Deploy continua com dono único
     (um chat por vez, respondendo a pergunta da regra 6).

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
| 2026-07-06 | agente-oc13-autonomo | v29 | `cc95d47` (supabase/ ≡ `883ff15`) — 18 linhas INV-027 acao_key no banner | Claude |
| 2026-07-21 | LOTE (19 fns): sync-bastao, vinculador, executor, sync-prioridades-ai-do-bastao, criar-card-manual, foto-oc-card, interpretador-evidencia-foto, puxar-historico-ssw-card, r-evidencia, executar-sugestao-evidencia, processar-acoes-agendadas, diag-form-ocorrencia, popular-chave-cte-via-ssw, agente-monitor-efetividade-ai, atualizar-card-via-portal-ssw, audit-invariante, sync-extravios-bastao, voltar-para-to-do-com-rastreio, webhook-ssw-ocorrencias | — | `d7a7915` (fallback_orfao + ssw_secret_prefix + normalizarCodigoSegmento; migs 304/305 aplicadas antes) | Claude |
| 2026-09-02 | vinculador, scan-email-pre-card, cron-ia-resposta-pendentes | v130, v38, v38 | `13bd19c` (master; importavam `_shared/propostas-pos-resposta-cliente.ts` mudado em 01/09 e estavam com bundle de 26/08 — achado pelo `scripts/deploy_pendente.py`) | Claude, por ordem do Caio |
| 2026-09-02 | executor, processar-acoes-agendadas | v157, v41 | `1386f09` (master; remoção da cobrança automática — ADR 0020; mig 375 aplicada antes, 21 canceladas) | Claude, por ordem do Caio |
| 2026-09-02 | LOTE (8): health-check, sync-extravios-bastao, agente-oc13-autonomo, interpretador-resposta-cliente, robo-intranet-wurth, agente-sugere-ocs-padrao, backfill-anexos-inbound, reprocessar-anexos-mensagem | v43, v28, v53, v48, v15, v85, v18, v14 | `8bc085c` (master; estavam com `_shared` velho — provado por extração ESZIP que prod = git no commit-base, nada fora do git) | Claude, por ordem do Caio |
| 2026-09-02 | REMOVIDAS de prod (ADR 0021): sync-prioridades-ai-do-bastao, agente-priorizador-ai, agente-insights-globais-ai, listar-contatos-cobranca, disparar-cobranca-escalonada, sugerir-cobranca-ai, processar-cobrancas-cliente-aguardando | — | `d0f6f2f` (faxina Prioridades AI + cobrança; mig 376 aplicada) | Claude, por ordem do Caio |


## Ritual em qualquer máquina (desde 2026-09-02)

O passo a passo canônico, portátil (Windows incluído), está em
`docs/RITUAL_DEPLOY.md`. Antes de deployar: `python3 scripts/deploy_pendente.py`
diz quais funções estão com produção atrás do git, **incluindo as que só mudaram
por um `_shared/` importado** — foi assim que 3 funções ficaram 6 dias velhas em 02/09.

## DEPLOY-GATE (obrigatório desde 2026-07-21)

Todo deploy de edge function passa pelo hook `.claude/hooks/cockpit-deploy-gate.py`
(registrado em `.claude/settings.json` — vale pra TODAS as sessões Claude do repo).
Ele **bloqueia**: checkout atrás do origin/master; mudanças não commitadas em
`supabase/`; marcador crítico ausente (manifest `.claude/deploy-guards.json`);
função removida de propósito (ex.: wrapper Lovable). Motivo: em 2026-07-21 um
lote de 19 funções deployado de commit desatualizado regrediu o vinculador
(pré-59) — 3ª regressão da mesma classe no dia. Ao remover de propósito uma
feature listada no manifest, atualize o manifest NO MESMO commit. Quebra-vidro
(`DEPLOY_GATE_ACK=1`) só com ordem explícita do Caio.

## GUARD "BRANCH-ATUALIZADA" (PRs — desde 2026-07-22)

Complemento do deploy-gate, na camada de PR: o workflow
`.github/workflows/branch-atualizada.yml` falha qualquer PR cuja branch NÃO
contenha o master atual (nasceu de clone/master desatualizado). Motivo: em
2026-07-22 o clone do Matheus ficou 48 commits atrás após a transferência do
repo pro Caio; branches criadas dali "ressuscitavam" código antigo e pareciam
PRs com regressão surgindo do nada.

Camadas de defesa (da mais cedo pra mais tarde):
1. **Local (pre-push):** hook `.git/hooks/pre-push` bloqueia push de branch
   atrás de `origin/master` (instalar por máquina; ver snippet abaixo).
2. **CI (este workflow):** PR fica vermelho com a contagem de commits em atraso
   e o comando de rebase.
3. **Merge (só admin liga):** Settings → Branches → rule no `master` →
   "Require status checks" (marcar `branch-atualizada`) + "Require branches to
   be up to date before merging". Sem isso o check é visível mas não impede
   o merge.

Snippet do pre-push (instalar com `chmod +x .git/hooks/pre-push`):

```sh
#!/bin/sh
# Bloqueia push de branch que está atrás de origin/master (base velha = regressão).
git fetch origin master --quiet
while read local_ref local_sha remote_ref remote_sha; do
  [ "$remote_ref" = "refs/heads/master" ] && continue
  [ "$local_sha" = "0000000000000000000000000000000000000000" ] && continue
  if ! git merge-base --is-ancestor "$(git rev-parse origin/master)" "$local_sha"; then
    echo "⛔ push bloqueado: '$remote_ref' está atrás de origin/master."
    echo "   Rode: git fetch origin && git rebase origin/master"
    echo "   (bypass consciente: git push --no-verify)"
    exit 1
  fi
done
exit 0
```

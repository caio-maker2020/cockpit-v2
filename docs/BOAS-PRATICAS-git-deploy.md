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
| 2026-09-03 | agente-sugere-ocs-padrao, interpretador-resposta-cliente, **agente-seguir-parcial-auto (NOVA)** | v88, v51, **v1** | `abfc579` (master; F7 do ADR 0025 — oc 55 automática em modo SOMBRA). Migs 379 (tabela + kill-switch OFF), 380 (flag sombra ON + cron 15min) e 381 (liga mestra + 1 CNPJ) aplicadas em volta, todas TIPO B com `--autorizado-por`. Contraprova do cron às 17:45 BRT: `200 {"ok":true,"skipped":"flag_off"}`. **DEIXADAS DE FORA de propósito** (decisão do Carlos no chat — PRÁTICA PROIBIDA desde 04/09, ver nota abaixo da tabela): `atualizar-card-via-portal-ssw`, `criar-card-manual`, `sync-bastao`, `sync-extravios-bastao` — ficaram pendentes só por efeito colateral (importam `_shared/extravio-enrichment.ts`, que sofreu movimentação pura de código + re-export; das exportações desse módulo elas usam apenas `normalizeNf`, que não foi tocada) | Claude, por ordem do Carlos |
| 2026-09-18 | FRONT (Vercel, `git push master` → prod automático) — links pro dashboard de clientes: "Visão geral dos clientes" (Inbox) + "Ver números do cliente" (card, q=nome + cnpj). Sem edge, sem migration. Env `VITE_DASHBOARD_CLIENTES_SENHA` cadastrada na Vercel (Preview+Production). | — | `e8e305a` (PR #34, branch feat/visao-clientes-dashboard-link; INV-157) | Claude (ordem do Caio 18/09) |
| 2026-09-18 | FRONT (Vercel, push master) — botões do header do card em pílula (rounded-[20px], igual ao pill de estado). Sem edge, sem migration, sem env. | — | `8c25e34` (PR #35, branch feat/card-header-botoes-pilula) | Claude (ordem do Caio 18/09) |
| 2026-09-22 | LOTE (26 fns, TODAS as pendentes — fecho transitivo de `_shared/ssw-internal-client.ts` + `lancar-ssw-portal.ts`): agente-extravio-d4, agente-oc43-autonomo, agente-seguir-parcial-auto, agente-sugere-ocs-padrao, alterar-especie-cliente, alterar-especie-cliente-lote, atualizar-card-via-portal-ssw, backfill-texto-ssw-56, cadastrar-tracking-auto, criar-card-manual, diag-form-ocorrencia, diag-ssw-instrucao-oc44, executar-sugestao-evidencia, executor, foto-oc-card, gmail-poll-inbox, interpretador-evidencia-foto, popular-chave-cte-via-ssw, processar-acoes-agendadas, puxar-historico-ssw-card, r-evidencia, relatorio-opc-031-mensal, revalidar-evidencia-card, sync-bastao, vinculador, voltar-para-to-do-com-rastreio + FRONT (Vercel, push master) — marcação "Segregar CTRC" (campo `f8` da tela 101) na aprovação de 54/59 em card de extravio. | executor v167, sync-bastao v268, vinculador v141, gmail-poll-inbox v79 (demais idem) | `81d5e7f` (merge da branch `segregar-ctrc-prati`; ADR 0033, INV-158). Mig 407 aplicada antes do deploy, TIPO B com `--autorizado-por`: tabela `cliente_config_segregacao_ctrc` + RPC `cliente_pode_segregar_ctrc` + flag `segregacao_ctrc_enabled`. **TUDO NASCEU DESLIGADO** — flag `false`, 2 CNPJs da PRATI com `ativo=false`, RPC devolve `f`: nada segrega. Ativar é ato separado (2 UPDATEs TIPO B), NUNCA antes do deploy — flag ON com edge velha = "segregação fantasma". Contraprova: `deploy_pendente` zerado; pulso 25s; 0 eventos de segregação; regressão medida commit-a-commit (7aebeeb × 81d5e7f): backend 1312✓/2✗ idêntico, front 357✓/1✗ idêntico, 12 erros de tipo idênticos, invariantes 19 FAIL → 18 (o que saiu foi o próprio INV-158). | Claude (ordem do Carlos 22/09) |
| 2026-09-22 | **ATIVAÇÃO** da segregação de CT-e para a PRATI (sem deploy, sem edge — só banco) | — | mig 408 `2026-09-22_408_ativar_segregacao_ctrc_prati.sql`, TIPO B com `--autorizado-por`. Liga a flag `segregacao_ctrc_enabled` e ativa os 2 CNPJs (`73856593001057`, `73856593000166`). **Só depois do deploy das 26** (13:04Z) — flag ON com edge velha = "segregação fantasma". Pré-condição medida antes de aplicar: dos 42 to-dos de 54/59 da PRATI, **ZERO** tem `auto_approval_rule`, zero ações autônomas armadas, `autonomia_fatias_enabled=false` — nenhum caminho para o robô. Superfície que muda: 10 propostas em 9 cards de extravio. Contraprova: flag `true`; 2 CNPJs ativos COM dono (`autorizado_por`/`autorizado_em` = Carlos 22/09); RPC devolve `true` para os 2 da PRATI e **`false`** para quem está fora (AMPLA ODONTO `54058693000100`), para CNPJ nulo e para CNPJ inválido — fail-closed preservado; INV-158 PASS com os checks de banco vivos (`ativo_sem_dono=0`, `ativo_nas_duas_listas=0`). ⚠ **Desligar impede NOVAS segregações; NÃO solta carga já barrada — a retirada é manual, SSW opção 091.** Ativado SEM o teste real no CT-e: o CT-e de teste (AMB633145-9, AMPLA ODONTO) não é da PRATI e usá-lo exigiria liberar CNPJ fora do escopo; Carlos foi informado e decidiu ativar assim mesmo. | Claude (ordem do Carlos 22/09) |
| 2026-09-29 | agente-sugere-ocs-padrao, cron-ia-resposta-pendentes, interpretador-resposta-cliente, scan-email-pre-card, vinculador (TODAS as pendentes, fecho transitivo de `_shared/cce-endereco-trava.ts` e `propostas-pos-resposta-cliente.ts`). Sem migration. | v98, v47, v59, v48, v142 | `4604153` (merge da branch `fix/trava-cce-endereco-oc21-autonomo`; ADR 0035, INV-161): reentrega (oc 21) com CCE de endereço vigente não sai mais pela janela de veto. Antes: master = GitHub; `deploy_pendente` listava exatamente as 5; pulso 14 s; 2 reentregas armadas (NF 428913 COM CCE de endereço, armada pelo código antigo às 13:42Z — a operadora aprovou a 21 à mão às 14:39Z e a agendada foi cancelada; NF 40663 sem CCE). Contraprova (10 min depois): `deploy_pendente` zerado; pulso 8 s, 77 ciclos do cron desde a publicação, todos `succeeded`; eventos das 5 funções nascendo (4 `InterpretadorRespostaClienteConcluido`, 4 `RetornoClienteEmAguardo`, 2 `AgenteOcsPadraoDecisao`, 12 `MensagemAnexadaPorThread`), no mesmo ritmo do dia anterior; nenhuma 21 nova armada e nenhum `CceEnderecoSegurouAutonomo` ainda (esperado: 2 a 4 por semana). Os logs `[cce-trava]` não foram lidos: não há script de logs no trilho. | Claude (ordem do Carlos 29/09: "eu autorizo a publicação") |
| 2026-09-30 | agente-extravio-d4 (a ÚNICA pendente — fecho transitivo de `_shared/agente-extravio-reavaliacao.ts`). Sem migration, sem front. | v17 | `e9c6b00` (merge da branch `fix/extravio-d4-marcacao-e-reincidencia`; ADR 0036, INV-163): a marcação do agente de extravio ganha volta (nova tentativa da 49 recusada, até 3; ciclo novo volta a contar; toda 49 grava `data_extravio`) + reincidência "achou e perdeu" e "já tratado" em OBSERVAÇÃO, cada uma com a sua chave. **Chaves NÃO criadas** por ordem do Carlos ("pode publicar, mas n ligue as chaves"). Antes: master = GitHub; `deploy_pendente` listava só esta; pulso 17 s. Contraprova: `deploy_pendente` zerado; 1ª rodada (17h BRT) HTTP 200 em 40,7 s, 0 erros, 49 aceita pelo SSW nas 4 previstas no replay (787209 LARISSA, 179061, 312687 e 2387808), 789631 aguardando; INV-163 (DB) FAIL → PASS. A rodada das 18h não faz nada (trava de horário comercial, sempre foi assim). | Claude (ordem do Carlos 30/09: "pode publicar, mas n ligue as chaves") |
| 2026-10-02 | agente-oc13-autonomo, agente-sugere-ocs-padrao, cron-ia-resposta-pendentes, executor, interpretador-resposta-cliente, robo-intranet-wurth, scan-email-pre-card, vinculador (TODAS as pendentes — fecho transitivo de `_shared/veto-agendamento.ts`; só o interpretador muda de comportamento). Sem migration, sem front. | v64, v100, v48, v168, v60, v19, v49, v143 | `4024b00` (merge da branch `fix/interpretador-conversa-interna-cliente`; ADR 0022 R8, INV-166): conversa entre colegas do cliente deixa de virar 56 lançada sozinha (NF 1042798). A branch foi reescrita em 4 commits ANTES do push para tirar nomes/e-mails reais de clientes dos testes, docs e mensagens (LGPD — repo público). Antes: master = GitHub; `deploy_pendente` listava exatamente as 8, nenhuma com commit de outro trabalho de carona; pulso 55 s. Contraprova (13 min depois): `deploy_pendente` zerado; só as 8 subiram de versão; pulso 28 s; 3 leituras do interpretador, todas `success` e com `pedido_dirigido_a`; 0 erros em `agent_runs`; Fase 7.9 = 0; cron do agente-sugere-ocs-padrao `succeeded` a cada 5 min; os 500/502 do pg_net são os mesmos de antes (Bastão 57014 e "detector: statement timeout", 18 em 6 h). | Claude (ordem do Carlos 02/10: "ok, siga") |
| 2026-10-05 | agente-oc13-autonomo, agente-sugere-ocs-padrao, atualizar-estado-tratativa, cron-ia-resposta-pendentes, executor, health-check, interpretador-resposta-cliente, processar-acoes-agendadas, robo-intranet-wurth, scan-email-pre-card, sync-bastao, vinculador (TODAS as 12 pendentes — fecho transitivo de `_shared/ciclos-tratativa.ts`, `veto-agendamento.ts`, `estado-tratativa-carregar.ts`, `lag-lancamento-54.ts`; mudam de comportamento o agente de sugestão e o sync). Sem migration. Front pela Vercel no push da master. | v65, v101, v4, v49, v169, v44, v61, v47, v20, v50, v269, v144 | `78e92e0` (merge do PR #37, branch `fix/sugestao-por-entrada-e-ciclos`; ADR 0037, INV-168): sugestão do agente por ENTRADA do card (fim do teto vitalício de tentativas), Porta 4 não segura oc nova no mesmo dia, ciclo sem extravio 6/9/16 e com a 49 autônoma, chip "Ciclo N · etapa M". Publicado 15:14Z (12:14 BRT). Contraprova 12:41 BRT: `deploy_pendente` zerado; pulso do cron 24s; sync das 12:30 rodou (44 `BastaoCardAtualizado`, 7 importações, 3 reaberturas); agente de sugestão 3/3 `success`; executor 3 ações; Fase 7.10 com os dois counts em 0; Vercel `success` no commit do merge. Único erro pós-deploy: 1 run do oc13 com `ssw_offline` (HTTP 429 do SSW, transiente, sem relação). Pendente: contraprova de eficácia (aprovações com oc repetida perto de 96% com análise do ciclo) em alguns dias. | Caio (ordem de merge e publicação em 05/10), executado pelo Claude |
| 2026-10-06 | agente-oc13-autonomo, agente-sugere-ocs-padrao, cron-ia-resposta-pendentes, executor, interpretador-resposta-cliente, processar-acoes-agendadas, robo-intranet-wurth, scan-email-pre-card, vinculador (TODAS as 9 pendentes — fecho transitivo de `_shared/segregacao-ctrc.ts` e `veto-agendamento.ts`; mudam de comportamento a janela de veto, o vencimento e a cerca do executor). Sem migration, sem flag. Front pela Vercel no push da master. | v66, v102, v50, v170, v62, v48, v21, v51, v145 | `0802002` (merge da branch `segregacao-operadora-larissa`; ADR 0033 adendo D6–D8, INV-169): relato da Larissa (PRATI) — a caixa "Segregar CTRC" quase nunca aparecia porque o robô lançava a 54/59 antes dela (23 em 2 semanas, 7 antes do início do dia). Agora: 54/59 que poderia segregar fica com a operadora (agendador não arma, vencimento devolve; na dúvida, reserva); linha "SEM e-mail" de cliente que segrega abre painel com CT-e e caixa; 49 só é extravio com a prova do robô do extravio. Antes: master = GitHub (997208b); `deploy_pendente` listava exatamente as 9. Publicado 15:58Z (12:58 BRT). Contraprova 16:06Z: `deploy_pendente` zerado; pulso 14–47 s; 55 execuções do cron `succeeded`, 0 falhas; `agent_runs` 18/18 `success` (11 do agente de sugestão); janela de veto segue agendando para outros clientes (2 × 54+e-mail às 16:04/16:05), 0 agendamento de 54/59 da PRATI; Vercel `success` no commit do merge; erros do pg_net são os de sempre (Bastão 57014 e "detector: statement timeout", mesmo padrão das 6 h anteriores). Testes: backend 1507/2 e front 413/1 (falhas pré-existentes idênticas à master); invariantes 159 PASS / 20 FAIL idênticos + INV-169; 19 mutações pegas. Pendente: consulta viva da INV-169 a partir de 15:58Z tem de seguir em 0 (conferir no lote de 07/10 08h05). | Carlos (merge e publicação autorizados em 06/10), executado pelo Claude |
| 2026-10-06 | MIGRATION DE DADO 412 (sem edge, sem front, sem flag) — `cliente_config` + `contatos_escalonamento`. Chamado CH-20261006-JFV8: Avante, Via Rural, Soma e Medika/HTS com a 49 do extravio no 2º dia útil (só o prazo); 2º CNPJ da PRATI (73856593000166) com a regra INTEIRA da PRATI (cópia da linha do 73856593001057: romaneio interno + template + prazo) e na lista de escalonamento do Ressarcimento que já cobria o 1º. | — | `a125445` (merge da branch `inclusao-clientes-notificacao-extravio-2-dias`; INV-170). Aplicada via `dbq.py --autorizado-por` às 16:16 BRT (19:16Z), ensaio sem gravar antes; a guarda DO da própria mig não acusou. Contraprova 16:22 BRT: `cliente_config` 8 → 15 linhas (as 7 novas como planejado; as 8 antigas idênticas por md5); `contatos_escalonamento` 194 linhas, a lista do analista 426 → 427 (só o 2º CNPJ da PRATI), demais listas idênticas; `cliente_config_oc13`, `cliente_config_segregacao_ctrc`, prazo das operadoras e as 5 flags (extravios, autônomo, veto, segregação, fatias) idênticos; INV-170 PASS (fora=0, prati_divergente=0); INV-163 (DB) 0/0; INV-017c 0; `deploy_pendente` zerado; pulso 24 s. Testes da branch: backend 1507/2 e front 413/1 (falhas pré-existentes idênticas à master); invariantes iguais à master + INV-170 (4 FAIL de vitest/tsc sob falta de memória do Windows rerodados isolados: todos PASS). Esperado: 49 da Avante NF 159165 na rodada das 17h BRT; 7 em 07/10 08h; 16 em 08/10 08h (extravios de 06/10 — validação do Carlos). | Carlos (merge e aplicação autorizados em 06/10), executado pelo Claude |
| 2026-10-07 | confirmar-dossie-oc33, criar-card-manual, interpretador-resposta-cliente (exatamente as 3 que o `deploy_pendente` listava). Sem migration, sem flag. Front pela Vercel no push da master (tela sem mudança). | v3, v34, v63 | `6b37d8e` (merge da branch `fix/oc33-aviso-e-ordem-de-leitura`; INV-171; adendos 07/10 dos ADR 0030 e 0031): NF 1115331 — relato da operadora da carteira Indústria Farmacêutica, "erro ao lançar a 033". Duas causas de 15–17/09: (1) o aviso "o cliente mandou em anexo?" gravava `actor_type` "human", que o CHECK de `card_events` recusa — nunca funcionou (zero registros desde 17/09; erro de servidor em 06/10 e 07/10); agora "operator" (mesma palavra no `criar-card-manual`); (2) o robô reabria em toda leitura o romaneio e o valor já aceitos, que tomavam as 2 vagas de PDF — a NFD com a descrição nunca era aberta; agora o arquivo nunca aberto vai na frente (limites iguais). `liberar_card_suspeito_lockado` ("Forçar atualização") segue com 'human' como exceção conhecida, por decisão do Carlos. Antes: master = GitHub (6b37d8e); `deploy_pendente` listava exatamente as 3. Publicado 17:46Z (14:46 BRT). Contraprova 17:48Z: `deploy_pendente` zerado; pulso 19 s; Vercel `success` no commit do merge; última hora sem erro de servidor nas 3 funções; 1ª leitura pós-deploy (14:47 BRT) concluída com anexos lidos; INV-171 PASS. Testes da branch: backend 1514/2 (master 1507/2, mesmas 2 falhas antigas); invariantes 166 PASS / 19 FAIL (master 164/20; nenhum FAIL novo; diferenças restantes são checks de dado vivo); os 3 testes novos que provam a correção FALHAM contra a master; prova no banco com ROLLBACK ('operator' aceito, 'human' recusado). Pendente: 1º uso real do aviso deve gravar `Oc33DossieConfirmadoPeloOperador` ou `Oc33ConfirmacaoOperadorRecusada`; NF 243764 (valor na NFD nunca aberta) depende de nova resposta do cliente ou do aviso. | Carlos (merge e publicação autorizados em 07/10), executado pelo Claude |
| 2026-10-07 | upload-anexo-email (a ÚNICA que o `deploy_pendente` listava) + MIGRATION DE DADO 413 (TIPO B). Front pela Vercel no push da master (`uploadFileAsAnexo` passa a pedir o reaproveitamento). | v24 | `6866656` (merge da branch `fix/anexos-oc33-reaproveitar-paginas`; INV-172) + `edf5413` (cabeçalho da mig 413: autorização e receita de reversão, SQL igual): NF 941225 — a oc 33 dava "Limite de 20 anexos enviados por você neste card" já na 1ª página com o dossiê completo. As 20 vagas eram CÓPIAS: os modais da 33 sobem as páginas do PDF a cada clique, antes do `aprovar_e_executar`, e cada recusa da parede (mig 365) deixava as páginas pendentes (16 = o mesmo PDF de 4 páginas 4x em 27/08; +4 em 28/09). Agora o servidor devolve a página IDÊNTICA (mesmo card, to-do, nome, tamanho e bytes) já pendente, ANTES do teto; opt-in só das páginas convertidas (o "e-mail + oc 33" fica de fora: lá a 33 perderia o arquivo). Teto de 20 igual. Mig 413: baixa nas cópias exatas (mesmo eTag), mantendo a mais recente; só outbound pendente, `preservar=false`, to-do pendente/cancelado, >24h; registro em `audit_log`. Aplicada com `--autorizado-por "Carlos, 07/10: autorizado publicar upload-anexo-email e aplicar a mig 413 (NF 941225, chat)"`. Antes: master = GitHub (edf5413); ensaio BEGIN/ROLLBACK refeito na hora = 26 cards / 124 cópias / 941225 com 6 / 0 inbound / 0 preservado. Publicado 19:22Z (16:22 BRT). Contraprova: `select` pós-aplicação igual ao ensaio (941225: 6 vagas, 1 de cada arquivo; 119865: 8; 240766: 11); receita de reversão ensaiada com ROLLBACK (voltaria a 20; ficou 6); `deploy_pendente` zerado; função ACTIVE, `verify_jwt` igual (padrão, nunca teve entrada própria no config.toml); chamada sem login = 401; sem erro de servidor após o deploy; pulso 42 s; Vercel `success` no merge. Testes: 13 novos (nomes fictícios); backend 1527/2 (mesmas 2 falhas antigas da master); front 413/1 (falha antiga, arquivo não tocado); invariantes branch × master só diferem na INV-172 (master FAIL, branch PASS; INV-003b é dado vivo, rerodada = PASS). Pendente: 1º lançamento real da 33 da NF 941225; `cleanup_email_anexos_orfaos` (mig 063) segue NUNCA agendada (apagaria anexo do cliente) — INV-172 confere. | Carlos (merge, publicação e mig 413 autorizados em 07/10), executado pelo Claude |
| 2026-10-08 | upload-anexo-email (a ÚNICA que o `deploy_pendente` listava). Sem migration, sem flag, sem front (Vercel `success` no merge, tela igual). | v25 | `1abb636` (merge da branch `diag/reaproveitamento-upload`; INV-172): depois da publicação de 07/10, a mesma página subiu de novo no mesmo to-do (NF 1561134 em 07/10 e NF 941225 em 08/10 — nesta a oc 33 saiu, garantida pela limpeza da mig 413) e não havia como saber se a tela PEDIU o reaproveitamento ou se o servidor não achou a cópia igual. Agora cada página convertida (ou upload que pediu) grava UMA linha em `audit_log` (`upload_reaproveitamento_diagnostico`: pedido sim/não + resultado reaproveitado / sem_candidato / bytes_diferentes / download_falhou / erro_consulta / sem_todo / nao_pedido). Só observa: decisão e resposta iguais; best-effort com teto de 3 s, nunca lança; `audit_log` para não mexer no relógio do card. Antes: master = GitHub (1abb636). Publicado 13:20Z (10:20 BRT). Contraprova: `deploy_pendente` zerado; função ACTIVE, `verify_jwt` igual; chamada sem login = 401; pulso 52 s. Testes: +6 (19 no arquivo); backend 1533/2 (mesmas 2 falhas antigas); invariantes master = branch (167/19/2, zero diferença); ensaio do INSERT com ROLLBACK passou nos CHECKs de `audit_log`. Leitura: `INV-172-diag` (só informativo) no `/verify-cockpit`; `nao_pedido` = tela antiga no navegador (pedir F5). | Carlos (merge e sincronização dos 4 pilares autorizados em 08/10), executado pelo Claude |
| 2026-10-08 | MIGRATION DE DADO 414 (sem edge, sem front, sem flag) — `cliente_config_oc13`. Chamado CH-20261008-OBY6 (carteira AGRO/VET): VIA RURAL (10406295000235, 10406295000154 e o 3º CNPJ do grupo 10406295000669) e J.A AGRO UBE (29997296000572) entram na exceção da oc 13 VISÍVEIS e com o robô DESLIGADO (`ativo=true`, `autonomo_ativo=false`), igual à PRATI: a oc 13 deles passa a virar card na fila da operadora da carteira, com as 5 opções de sempre (21, 54 + e-mail `LIMITACAO_CLIENTE`, 56, 41, 54 sem e-mail; ordem inalterada) e nada sai sem ela aprovar. Caso âncora NF 118031 / CTRC ACW640889-3 (extravio que virou oc 13 em 25/09 e foi para TRANSFERIDO sem chegar à fila). | — | `f867d6d` (merge da branch `fix/oc13-via-rural-ja`; INV-173). Antes: master = GitHub (15d0b1c → f867d6d), Vercel `success` no merge (tela igual). Aplicada via `dbq.py --autorizado-por` às 11:54 BRT (14:54Z), ensaio sem gravar antes (6 cenários); a guarda DO da própria mig não acusou. Contraprova 11:55 BRT: `cliente_config_oc13` 17 → 21 linhas (as 4 novas com ativo=t/autonomo_ativo=f), robô ligado 15 → 15 (as 17 antigas intocadas), sem robô 2 → 6; INV-173 PASS (fora_da_regra=0); nenhum card mexido pela aplicação (0 oc 13 abertas no Bastão para os 4 CNPJs; os 2 cards desses clientes alterados no período foram antes da aplicação, por resposta de cliente e pela rotina dos extravios); `deploy_pendente` zerado; pulso 15 s. Testes da branch: backend 1533/2 (mesmas 2 falhas antigas); invariantes master 167/18/2 x branch 167/19/2 — única diferença INV-173 (FAIL antes da aplicação, PASS depois). Prova real: na próxima oc 13 de VIA RURAL ou JA, card na fila da operadora em até 30 min e zero ação do `agente-oc13-autonomo`. | Carlos (inclusão, merge e aplicação autorizados em 08/10), executado pelo Claude |
| 2026-10-08 | `agente-oc13-autonomo` v67 + front (Vercel, merge na master) + MIGRATIONS 415 (DROP da view legada `v_agente_oc13_metricas`) e 416 (DADO: 153 pares retroativos em `agente_oc13_feedback`/`agent_feedback` + 39 carimbos `sugestao_vigente` reconstruídos em `card_events`). Pedido do Duilio ("a oc 13 não está sendo medida"): os pares existiam (121 em set); o indicador lia uma view que filtra `cod=13` (0 linhas), o ramo 21+cancelar não chegava ao carimbo (22/22 vazios em set) e o agente reanalisava card concluído 3× (`.or()` solto desde 21/05). Fix: `_shared/oc13-sugestao-aviso.ts` (destaque dos 3 ramos + filtro agrupado, 6 testes), indicador no `v_placar_agente`, INV-174. | — | `b2e9688` (merge do PR #43, branch `fix/oc13-medicao-completa`, apagada depois). Sequência 15:12–15:25 BRT (18:12–18:25Z): merge → checkout master limpo → deploy v67 (deploy-gate OK; a 1ª tentativa foi bloqueada por checkout atrás do master e refeita do master) → mig 416 `--autorizado-por` em DUAS rodadas (a 1ª gravou os 153 pares e abortou no DO: o `dbq` aplica em autocommit e a temp table `ON COMMIT DROP` sumiu; trigger append-only ficou LIGADO; migration corrigida pra temp table comum e reaplicada: 39 carimbos) → Vercel `success` → mig 415 `--autorizado-por` (classificador do dbq trata DROP VIEW como TIPO B; cabeçalho corrigido). Contraprova: `retro_pares`=153, `carimbos_reconstruidos`=39, `carimbo_vazio_pos_oc13`=0, `card_events_no_update` ligado, view ausente, `deploy_pendente` zerado, pulso do cron 30–45 s antes/depois, INV-174 PASS (janela a partir do deploy_em). Testes: deno 6/6, tsc limpo, vitest divergencia 14/14; deno check do agente = mesmos 10 erros do master. Achado: `.githooks/pre-commit` usa `mapfile` e este Mac só tem bash 3.2 — com `hooksPath` ligado todo commit aborta (ficou desligado como estava). | Caio (merge, deploy e migrations autorizados no chat em 08/10 "pode fazer o merge... garanta que tudo estará regularizado"), executado pelo Claude |
| 2026-10-09 | confirmar-dossie-oc33 + interpretador-resposta-cliente (exatamente as 2 que o `deploy_pendente` listava) + front (Vercel `success` no merge `f80179f`, 16:53Z). Sem migration, sem flag. | v4, v64 | `9e73480` (merge da branch `fix/oc33-cartao-simples-popup`; INV-152 ampliado; adendo 09/10 do ADR 0030) e `f80179f` (merge da branch `feat/telemetria-evidencias-dossie`; INV-191): chamado CH-20261007-B8VZ, NF 387252 (SOMA MG) — "Erro ao aprovar — OC33_DOSSIE_INCOMPLETO" 2x em 08/10, 7 anexos descartados em cada. Com o card fora da validação humana (aqui `AGUARDANDO_CLIENTE`), a tela usava o `ProposalCard`, que nunca recebeu a trava do carimbo (11/09) nem o pop-up (16/09): 139 cards nesse estado com a 33 acesa e bloqueada. (1) O cartão simples passa a usar as MESMAS expressões da lista (carimbo como fonte, pop-up como exceção, aviso com motivo) e as janelas da 33 só fecham no sucesso; (2) a pergunta do pop-up vira "no e-mail ou em anexo?" (decisão do Carlos, opção b — a descrição da 387252 veio no CORPO; condição do pop-up inalterada) e o registro do NÃO descreve a pergunta feita; (3) o evento `DossieExtravioAtualizado` ganha `diagnostico_evidencias` (o que o robô leu × o que a prova aceitou; módulo puro, mesma régua, try/catch; `extravio-parcial-dossie.ts` intocado). Antes: master = GitHub (`f80179f`); `deploy_pendente` listava exatamente as 2. Publicado 17:02:46Z (14:02 BRT). Contraprova: `deploy_pendente` zerado; v4 ACTIVE `verify_jwt` true (sem login = 401) e v64 ACTIVE `verify_jwt` false (igual ao `config.toml`); pulso 22 s; 0 erro de servidor do interpretador no dia. Testes sobre a master já com o merge: backend 1876/6 (as MESMAS 6 falhas antigas), front sem a tela de Operação 516/1 (a 1 é antiga; a Operação esgota tempo também na master e não importa nenhum arquivo alterado), invariantes sem FAIL novo (INV-191 nova PASS; INV-047 mudou só por dado vivo), build ok, lint igual à master; os testes novos FALHAM contra a master (8 de fonte + 5 que clicam no botão + o de fiação da telemetria) e os 3 de não-regressão passam nas duas. Pendente: 1º uso real do pop-up num card fora da validação humana (âncora 387252) e 1º `diagnostico_evidencias` gravado. | Carlos (merge, publicação e sincronização dos 4 pilares autorizados em 09/10), executado pelo Claude |


> ⛔ **REGRA ABSOLUTA (Caio 04/09): NUNCA deixar função pendente de fora do
> deploy — nem "de propósito", nem com justificativa.** A linha de 03/09 acima
> foi o caso que criou a regra: a análise "só usam normalizeNf" estava errada
> pra 2 das 4 funções (sync-bastao e atualizar-card usam analisarExtravio, que
> carrega o parser corrigido) e produção rodou ~18h inconsistente. O
> `deploy_pendente.py` calcula o fecho transitivo por construção — pendente =
> deploya, sempre. Regularizado em 04/09 (deploy das 4 pelo Claude, ordem do Caio).

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

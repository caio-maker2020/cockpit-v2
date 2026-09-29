# ADR 0035 — Reentrega (oc 21) com CCE de endereço não sai pela janela de veto

Data: 2026-09-28
Status: aceito — mergeado na master em 29/09 com autorização do Carlos; **publicado em
produção em 29/09 às 14:40Z (11:40 BRT)**, também com autorização do Carlos (as 5
funções, a partir de `4604153`; registro em "Publicação")
Autor da regra: Carlos (chat 28/09, caso reportado pelo Felipe)
Guards: **INV-161** · `supabase/functions/_shared/cce-endereco-trava.test.ts` ·
`supabase/functions/_shared/cce-endereco-trava.fiacao.test.ts`
Relacionados: ADR 0016 (janela de veto), mig 357 (piloto FELIPE/ISABELY/LARISSA)

## Contexto

NF 40484 (FELIPE, TSD): o cliente respondeu *"Segue carta de correção em anexo"* com o
PDF da CCE. O `interpretador-resposta-cliente` sugeriu a 21 com "CCE EM ANEXO" no texto,
a janela de veto venceu e a reentrega foi lançada sozinha, sem ninguém corrigir o
endereço no SSW. A "Padronização oc 11" (07/08) trata "CC-e" como mais um dado que
confirma o endereço, sem passo de correção.

NF 3907402 (FELIPE): a CCE chegou em 18/09 e, em 24/09, uma cobrança **sem** CCE soltou a
21. No dia seguinte a entrega falhou de novo no endereço.

Medição de 60 dias (28/09): 10 reentregas com CCE real saíram sozinhas em 30 dias. O
tratamento de CCE que existia era só o do Würth, e ele só não saía sozinho porque a
Ingrid está fora do piloto.

## Decisão (Carlos, 28/09)

1. **Só CCE de ENDEREÇO.** CCE de volume, pedido ou produto segue no automático.
2. **Vale até a reentrega sair:** a trava fica ativa até existir uma 21 com `sucesso` em
   `acoes_executadas_ssw` iniciada **depois** do e-mail com a CCE, **ou** uma 21
   lançada direto no SSW depois da CCE. Esta segunda parte foi decidida pelo Carlos em
   28/09, depois da revisão. A hora da 21 do SSW vem do próprio SSW, e não da hora em
   que o Cockpit percebeu: uma 21 lançada **antes** da CCE e só vista depois não
   encerra a trava.
3. **Cobre 3 portas:** leitura do e-mail (`interpretador-resposta-cliente`), rede de
   segurança (`propostas-pos-resposta-cliente`) e reanálise (`agente-sugere-ocs-padrao`).
4. **Caso duvidoso** (CCE sem sinal de endereço, como NF 662585 "Recusa Total" +
   "segue a carta de correção") **segue no automático**.
5. **Só a saída automática muda.** A 21 continua sendo sugerida com o mesmo texto e o
   operador aprova normalmente; operador fora do piloto não é afetado.

## Como funciona

As 3 portas trocam `agendarAcaoAutonomaSeElegivel` por `agendarComTravaCce`
(`_shared/cce-endereco-trava.ts`):

- chave que não é 21 → delega na hora, **sem nenhuma consulta a mais**;
- 21 que não poderia sair sozinha (flag master OFF, degrau inativo ou dono fora do
  piloto) → delega, e o agendador recusa como hoje; a trava nem lê e-mail;
- 21 que poderia sair sozinha → relê os e-mails do card (últimos 50) e, se houver CCE de
  endereço depois da última 21 com sucesso, **não agenda** e grava UM evento
  `CceEnderecoSegurouAutonomo` (sem duplicar por CCE + chave);
- erro de consulta → não agenda (fail-safe, igual ao agendador) e escreve
  `[cce-trava] verificação falhou` no log. Falha ao gravar o evento também vai para o
  log (`registro do evento falhou`); a 21 continua segurada.

**21 lançada direto no SSW (decisão 2, segunda parte).** Só quando a trava já
seguraria, ela lê `cards.historico_ssw`: o histórico de ocorrências do CTRC, gravado
pelo `atualizar-card-via-portal-ssw` e pelo `puxar-historico-ssw-card`. Cada linha traz
o código e a data (`DD/MM/YY HH:MM`, horário de Brasília), convertida por
`parseSswDataHoraBrt`, a fonte única do projeto. Se houver uma 21 com data depois da
CCE, a trava não segura. Cuidados medidos (revisão de 28/09, somente leitura):
- **A data é a DIGITADA no lançamento, não a da inclusão.** O Cockpit digita "agora
  menos 2 minutos", e isso bate no minuto em 1.284 de 1.286 lançamentos. O SSW recusa
  data futura: 0 de 14.046 linhas têm data depois do momento da leitura. A data é,
  portanto, sempre igual ou anterior ao lançamento real, e uma 21 com data depois da
  CCE foi lançada depois dela. O único erro possível é **segurar a mais**, quando alguém
  lança depois mas digita uma data antiga. Data impossível (31/02) ou no futuro é
  ignorada, com folga de 10 minutos de relógio.
- **O CTRC é o do card.** As duas funções que gravam o histórico pedem ao SSW o CTRC do
  card e recusam gravar se ele não bater. Nenhum dos 139 registros de 21 veio de outro
  CTRC da mesma NF, e hoje não há card ativo sem CTRC. O histórico não registra de qual
  CTRC veio. Se o card trocar de CTRC, a CCE fica no card antigo (caso antigo, fora desta
  mudança).
- **Erro ao ler o histórico** conta como "sem histórico": a trava segura normalmente,
  grava o evento e escreve `histórico do SSW não lido` no log.
- **Quando uma 21 do SSW encerra a trava**, nada novo vai para o card. Fica só a linha
  `[cce-trava] 21 no SSW em … encerrou a CCE` no log.
- O conversor de horário supõe Brasília fixo em −3h. Se o horário de verão voltar, é
  preciso revisar `parseSswDataHoraBrt`, senão a trava pode soltar até 1h cedo.
- **O histórico expira em 24h.** O cron `cleanup-historico-ssw-every-hour` apaga o
  histórico 24h depois de puxado. Ausência, portanto, **não** prova que não houve 21, e
  sem histórico a trava continua segurando (lado seguro). O evento grava
  `historico_ssw_disponivel`, com histórico vazio contando como `false`, para medir isso
  depois. Esse campo só aparece na primeira vez que a trava segura cada CCE, por causa
  da deduplicação. Das 156 armações de 21 em 60 dias, 131 (84%) tinham leitura do SSW
  nas 24h anteriores e 100 (64%) nas 2h anteriores. Prova contra produção em 29/09
  (somente leitura): dos 1.273 cards do piloto com e-mail em 60 dias, 24 têm CCE de
  endereço vigente. Só 1 deles tinha histórico gravado naquele momento, sem 21, e
  nenhum seria liberado. A liberação depende, na prática, de o histórico ter sido puxado
  perto da hora em que a 21 é armada.
- **O histórico é cumulativo:** uma leitura nova traz todas as 21 do CTRC, inclusive
  as antigas, cada uma com a sua data.
- **O Bastão nunca registra a passagem para 21**, porque a 21 não é ocorrência de
  relacionamento (0 casos em 60 dias). O evento `AtualizadoViaPortalSsw` vê a 21 (148
  em 60 dias), mas não guarda a data do SSW. Nenhum dos dois serve para a decisão.
- Data ilegível, impossível ou futura conta como "não houve 21". A trava nunca solta por
  dado ruim.

**O que o evento significa, exatamente:** a 21 passou nas 3 cercas de sistema (flag
master, degrau, dono no piloto) **e** havia CCE de endereço vigente. As outras cercas do
agendador (veto no ciclo, mesma 21 no ciclo, sugestão com mais de 4h, cerca de estado)
não rodam antes do evento. Em 30 dias, 83 de 94 decisões de 21 no piloto viraram
armação, ou seja, cerca de 12% não sairiam de qualquer forma. Por isso o contador de
eventos fica **acima** do número de 21 que de fato teriam saído sozinhas.

**Nada é gravado para "lembrar" da CCE.** A vigência é recalculada a partir dos e-mails
a cada tentativa de armar uma 21, o que vale também para CCE recebida antes da
publicação, mas **só para armações novas**. Uma 21 que já estava agendada (armada pelo
código antigo antes da publicação, ou antes de o anexo da CCE ser gravado) **não é
desarmada** e sai no vencimento. Ver o resíduo e o roteiro de publicação.

Detecção:
- **CCE:** no texto escrito pelo cliente (`separarTextoDoCliente`, sem a citação) por
  `CCE`, `CCe`, `cc-e`, `C.C.E` ou "carta (de) correção"; ou pelo nome do anexo
  (`-cce.pdf`, `dacce-…`, `carta_correcao…`). A frase do nosso template ("solicitamos
  também o envio de uma CCe") é **sempre** retirada, inclusive quando o cliente repassa o
  nosso e-mail acima do marcador de citação (NF 29819: 1 caso em 2.115 mensagens, que
  deixou de ser falso positivo; o replay de 60 dias ficou idêntico).
- **Endereço:** o texto do cliente fala em "endereço", "local de entrega", "número da
  casa", "logradouro" ou traz link de mapa; ou o assunto da mensagem ou do nosso e-mail
  anterior é de endereço ("Insucesso na entrega" = PROBLEMAS_COM_ENDERECO, "endereço",
  "divergência de cidade"). "Rua", "av." e "CEP" ficaram de fora de propósito, porque
  aparecem em assinatura.

## Armadilhas registradas

- Ler o e-mail inteiro casa com a nossa própria frase citada: foram 11 falsos positivos
  medidos, entre eles NF 670133 ("O endereço da clínica está correto!").
- O `ehEmailCce` do Würth não reconhece `cc-e` (NF 381683) nem CCE que vem só no anexo
  (NF 3912376). Ele **não foi alterado**, porque o fluxo Würth depende dele.
- O nome do evento **não** pode começar com "Acao": `reconciliar_execucoes_presas`
  trata `event_type LIKE 'Acao%'` como sinal de execução.
- Guardar o sinal em `ia_sugestao_oc_resposta` ou em `agent_state` não funciona: os dois
  são zerados ou reescritos por outros fluxos.
- **`VERSAO_REGRAS_ANALISE` NÃO sobe de propósito.** Subir a versão manda reanalisar
  todo card com banner vivo, e cada reanálise pode armar ações autônomas em massa. A
  trava não muda a análise (nem o texto nem a oc sugerida), só se a 21 sai sozinha, e
  uma análise guardada não arma nada. O INV-128 olha só `HEAD~1..HEAD` e vai acusar FAIL
  quando o último commit tocar `interpretador-resposta-cliente` ou
  `agente-sugere-ocs-padrao`. Nesse caso é alarme falso, explicado aqui.
- Os testes foram provados por mutação (28–29/09): a trava foi quebrada de propósito em
  64 pontos, um de cada vez, e os testes reprovaram 60. As 4 que passam não mudam nada na
  prática. Uma usa o dado da leitura com erro, que o banco devolve vazio. As outras: duas trocam "depois de" por "no mesmo instante ou depois de" (a 21 e a CCE
  teriam de cair no mesmo milésimo de segundo), e uma só afeta a deduplicação do evento
  para a variante da 21 com e-mail, que hoje nem tem degrau. Casos que só passaram a ser
  cobertos depois da revisão: citação com outra frase nossa sobre CCE; nosso e-mail
  repassado acima do marcador; card sem nenhum e-mail; cobrança mais nova que a CCE, as
  duas no banco; oc 54 ou 21 de outro card depois da CCE; duas 21; erro em cada uma das
  8 consultas; WhatsApp; anexo nosso; e-mail nosso de outro card; apelido do assunto; e
  a variante da 21 com e-mail. O guard de fiação usa **lista de exceções**: reprova
  chamada ao agendador por apelido, por `import * as` ou num arquivo novo, e aceita
  import quebrado em várias linhas. Na master, reprova 7 de 9.

## Medição da regra (replay de 60 dias com dados reais, 28/09)

| Porta | 21 armadas | Seguradas | Das seguradas, saíram sozinhas na vida real |
|---|---|---|---|
| interpretador-resposta-cliente | 93 | 13 | 10 |
| agente-sugere-ocs-padrao | 58 | 0 | 0 |

As 13 seguradas são todas CCE de endereço: 234026, 3892859, 312388, 381683, 6047,
5808650, 68540, 39386, 3907402 (22/09 e a cobrança de 24/09), 3912376, 69317 e 40484.
Não houve falso positivo. A NF 1119547, cuja CCE era do número do pedido, segue no
automático, conforme a decisão 1. A prova contra produção, feita em modo somente leitura
com o cliente bloqueando qualquer escrita, validou as consultas; a 21 da NF 8615, que
recebeu CCE em 28/09, foi segurada.

## O que NÃO está coberto (resíduo consciente)

- `robo-intranet-wurth`: só importa se a Ingrid entrar no piloto.
- `agente-oc13-autonomo` (caminho instantâneo, sem janela): não rodou em 60 dias.
- `scripts/backfill-veto-agendamentos.ts`: é manual e passa por cima das travas locais.
- CCE só por WhatsApp.
- CCE mais antiga que as últimas 50 mensagens do card.
- CCE sem sinal de endereço (decisão 4).
- **E-mail em conversa NOVA, ligado ao card pelo número da NF.** O `vinculador` chama o
  interpretador (`vinculador/index.ts:552`) **antes** de ligar a mensagem ao card
  (`:644`). Como a trava lê os e-mails pelo card, ela não vê a CCE que acabou de chegar.
  O vencimento também não pega esse caso, porque só devolve mensagem recebida depois do
  agendamento. Em 60 dias o efeito foi zero: 37 acionamentos por esse caminho, todos fora
  do piloto (medido de novo em 29/09: 37 em 90 dias pelo evento `via: nf`, nenhum no
  piloto; no máximo 1 por outro critério, a NF 926351). O vinculador chama o
  interpretador de forma síncrona (`acionar-resposta-cliente.ts:101`), então o furo é
  real. **Decisão do Carlos (29/09): fechar numa segunda etapa**, com o mesmo ciclo de
  testes, passando à trava o `message_id` que o interpretador já recebe. O anexo dessa
  mensagem continuaria fora, porque é gravado depois.
- **21 já agendada não é desarmada nem reconferida no vencimento**
  (`processar-acoes-agendadas` não olha CCE). Isso vale para a 21 armada pelo código
  antigo antes da publicação e para o anexo gravado depois da leitura (o `gmail-poll-inbox`
  põe a mensagem na fila antes de gravar os anexos). Nesses casos o histórico pode mostrar
  "segurou" e a 21 sair logo depois. A resposta nova do cliente **já** cancela as ações
  armadas do card (`cancelar_acoes_agendadas_do_card`, antes do interpretador), então o
  caso comum está coberto. Sobram a hora da publicação (3 armadas em 29/09, média de 4,8
  por dia) e a CCE só no anexo gravado depois (0 em 30 dias). Recomendação: não mexer no
  código e conferir as 21 armadas na publicação. Cancelar a 21 viva, ou reconferir no
  vencimento, muda comportamento e depende de decisão do Carlos.
- 21 lançada **fora** do Cockpit só encerra a trava se o histórico do SSW estiver
  gravado no card na hora da decisão (ele expira em 24h). Foram 66 passagens para oc 21
  sem 21 do Cockpit em 60 dias, 15 delas no piloto (ex.: NF 39386). Sem histórico, a
  próxima 21 desse card segue para o operador, que é o lado seguro, e o evento registra
  `historico_ssw_disponivel = false`. Uma 21 cujo CT-e complementar foi cancelado depois
  no SSW ainda conta como reentrega, igual à 21 do Cockpit.
- O detector não reconhece o plural "CCEs" nem anexo com o nome grudado num número
  (`<nº>CCe.pdf`). Esses casos seguem no automático, como hoje.
- Menção a CCE sem o envio dela, em conversa de endereço ("caso seja possível, faremos a
  carta de correção"), também segura. Isso vale para mensagens da **nossa própria
  equipe** gravadas no card ("Aguardo envio da CCe para alteração de endereço"): foram 6
  em 60 dias, nenhuma do piloto. Tudo isso vai para o lado seguro.
- A lista de anexos vem numa única consulta, e o limite de linhas por resposta do banco
  pode cortá-la (um card chegou a 1.737 anexos nas últimas 50 mensagens). Nesse caso, a
  CCE que está só no nome do anexo passa, e a 21 segue no automático, como hoje.
- Duplicata rara do evento: a checagem lê e depois grava, sem trava no banco. Duas
  leituras simultâneas do mesmo card podem gravar 2 linhas. O efeito é só visual.
- Card **fora** do piloto com o banco devolvendo erro: a trava não chama o agendador, e a
  memória do card (`estado_tratativa`, um cache sem evento) é recalculada pelo próximo
  leitor, e não nesse momento. Esse é o único caso em que quem está fora do piloto vê
  alguma diferença.
- No front próprio, o evento aparece só com o nome técnico, e a explicação fica em "Ver
  payload". Como o Lovable mostra o evento não foi verificado.
- A trava **não confere** se o endereço foi corrigido no SSW: ela só garante que um
  humano olhe antes.

## Publicação (quando autorizada)

Não tem migration. Para publicar, rodar antes `python3 scripts/deploy_pendente.py`
(outra sessão pode ter publicado algo) e republicar as 5 funções que importam os
arquivos alterados: `interpretador-resposta-cliente`, `agente-sugere-ocs-padrao`,
`vinculador`, `scan-email-pre-card` e `cron-ia-resposta-pendentes`. Publicação parcial
deixa uma porta sem a trava: são as 5 juntas.

**Ordem com a branch da ponte** (`origin/matheuscastro12-eng/ponte-cockpit`, PR 36): as
duas mexem em `.claude/commands/verify-cockpit.md` e em `docs/INVARIANTES_COCKPIT.md`.
Se o conflito for resolvido com "aceitar ambos", é preciso inserir um `fi` entre os
blocos INV-160 e INV-161 e rodar `bash -n` em cada cerca. Sem isso, a Fase 8
(continuação 2) quebra em silêncio: os dois INVs deixam de rodar sem nenhum FAIL (ver a
memória da cerca da Fase 8). Se a ponte entrar na master antes, o `deploy_pendente` vai
listar 7 funções (mais `executor` e `redator`): ou publicar estas 5 antes de mesclar a
ponte, ou decidir de forma explícita publicar tudo junto.

**Antes e depois do deploy:** listar as 21 que já estão armadas, porque a trava não as
desarma. Conferir cada card. Se houver CCE de endereço, o operador veta na janela.

```sql
select id, card_id, executar_em, created_at
from acoes_agendadas
where tipo = 'executar_acao_autonoma' and status = 'pendente'
  and payload->>'acao_key' in ('lancar_ocorrencia:21', 'lancar_oc_e_enviar_email:21')
order by executar_em;
```

**Nos 10 minutos seguintes:** o `vinculador` e o `cron-ia-resposta-pendentes` são
disparados pelo cron. Conferir que `select max(start_time) from cron.job_run_details`
avança e que surgem `card_events` novos (`RetornoClienteEmAguardo`,
`InterpretadorRespostaClienteConcluido`), mesmo sem migration (INV-156). Procurar
`[cce-trava]` nos logs das 5 funções. Se `verificação falhou` aparecer com frequência,
investigar.

Depois, acompanhar pelo banco:

```sql
select count(*) from card_events where event_type = 'CceEnderecoSegurouAutonomo' and created_at > now() - interval '7 days';
```

A expectativa é de **2 a 4 CCEs distintas por semana**. O replay deu 12 em 33 dias, perto
de 2,5 por semana, e perto de 3,5 por semana nas duas últimas semanas. A série de
`acoes_agendadas` com 21 deve cair nessa mesma proporção, e essa queda **não** significa
que o trilho parou. Antes de usar o contador como indicador, cruzar com as recusas do
agendador, porque o evento conta também 21 que outra cerca teria segurado (ver "O que o
evento significa").

### Registro da publicação (29/09, ordem do Carlos: "eu autorizo a publicação")

- **14:40Z**, a partir de `4604153`: agente-sugere-ocs-padrao v98,
  cron-ia-resposta-pendentes v47, interpretador-resposta-cliente v59,
  scan-email-pre-card v48 e vinculador v142. O `deploy_pendente` listava exatamente essas
  5 antes e ficou zerado depois.
- **Reentregas armadas antes:** 2. A da **NF 428913** (piloto) tinha CCE de endereço: o
  cliente escreveu às 13:41Z "seguir com a entrega no endereço da carta correção em
  anexo", e o código antigo armou a 21 às 13:42Z. É o caso deste ADR, 58 minutos antes da
  trava entrar. A operadora aprovou a 21 à mão às 14:39Z, depois de puxar o histórico do
  SSW, e a agendada foi cancelada. A da NF 40663 não tinha CCE e seguiu armada.
- **10 minutos depois:** pulso de 8 s, 77 ciclos do cron desde a publicação, todos com
  sucesso, e eventos das 5 funções nascendo no mesmo ritmo do dia anterior. Nenhuma 21
  nova foi armada e ainda não houve `CceEnderecoSegurouAutonomo`. Os logs `[cce-trava]`
  não foram lidos, porque o trilho não tem script de logs. O acompanhamento fica pela
  consulta acima.

# ADR 0035 — Reentrega (oc 21) com CCE de endereço não sai pela janela de veto

Data: 2026-09-28
Status: aceito — implementado na branch `fix/trava-cce-endereco-oc21-autonomo`; **nada
publicado nem mergeado** (aguarda ordem do Carlos)
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
   `acoes_executadas_ssw` iniciada **depois** do e-mail com a CCE.
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
- erro de consulta → não agenda (fail-safe, igual ao agendador).

**Nada é gravado para "lembrar" da CCE.** A vigência é recalculada a partir dos
e-mails, o que cobre também CCE recebida antes da publicação.

Detecção:
- **CCE:** no texto escrito pelo cliente (`separarTextoDoCliente`, sem a citação) por
  `CCE`, `CCe`, `cc-e`, `C.C.E` ou "carta (de) correção"; ou pelo nome do anexo
  (`-cce.pdf`, `dacce-…`, `carta_correcao…`). Sem marcador de citação, a frase do nosso
  template ("solicitamos também o envio de uma CCe") é retirada antes.
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
- 21 lançada **fora** do Cockpit não encerra a trava. O erro vai para o lado seguro: a 21
  segue indo para o operador.
- Menção a CCE sem o envio dela, em conversa de endereço ("caso seja possível, faremos a
  carta de correção"), também segura. Também vai para o lado seguro.
- A trava **não confere** se o endereço foi corrigido no SSW: ela só garante que um
  humano olhe antes.

## Publicação (quando autorizada)

Não tem migration. Para publicar, rodar antes `python3 scripts/deploy_pendente.py`
(outra sessão pode ter publicado algo) e republicar as 5 funções que importam os
arquivos alterados: `interpretador-resposta-cliente`, `agente-sugere-ocs-padrao`,
`vinculador`, `scan-email-pre-card` e `cron-ia-resposta-pendentes`.

Depois, acompanhar pelo banco:

```sql
select count(*) from card_events where event_type = 'CceEnderecoSegurouAutonomo' and created_at > now() - interval '7 days';
```

A expectativa é de 1 a 2 casos por semana. A série de `acoes_agendadas` com 21 deve cair
nessa mesma proporção, e essa queda **não** significa que o trilho parou.

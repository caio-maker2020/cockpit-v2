# Ponte v2 (Painel da Operação): o que o time do Cockpit precisa revisar

Branch `matheuscastro12-eng/ponte-operacao`, que parte da ponte v1
(`matheuscastro12-eng/ponte-cockpit`). A decisão completa está no ADR 0035.

**Nada foi aplicado, deployado ou ligado.** As migrations 411 e 412 estão só como arquivo,
as três flags nascem OFF e nenhum secret foi criado.

## O que muda

O Roteirizador ganha uma tela da operação. Ela fala com o Cockpit por dois endpoints
novos, e um worker novo executa o que for pedido.

| Peça | O que faz | Escreve em |
|---|---|---|
| `ponte-tratativas` (POST) | lê, por CTRC, o estado da tratativa e o `bloqueiaEntrega`, com o motivo e a data | **nada** |
| `ponte-pedido-operacao` (POST/GET) | registra o pedido da operação e, se o CTRC tem card ativo, grava o evento no card | `ponte_operacao_pedidos`, `card_events` |
| `processar-pedidos-operacao` (cron 1 min) | acha ou cria o card (Bastão) e lança a 49 ou a ocorrência pelo envelope, até 2/min | `cards` (só INSERT de card novo), `card_events`, `audit_log`, `acoes_executadas_ssw` (pelo envelope) |

**O que não muda:** executor, envelope do SSW, tripé, sync da v1, roteador de eventos,
redator, IA da 49, vinculador, sync-bastao e `prompts/` estão **byte a byte iguais** ao
commit `fbc5e30`, e um teste prova isso. Nenhuma função existente importa o código novo.

## Risco, e onde está a trava

| Risco | Trava |
|---|---|
| rajada de login na conta `ai.salex` (INV-159) | o POST nunca faz login. A vazão é contada no banco: janela de 60 s, teto de 3/min, um por vez e quarentena de 30 min depois de um login recusado |
| ocorrência duplicada | `pedidoId` é a PK e a reserva é atômica. Lançamento interrompido vira `erro` e nunca é relançado. Duplicidade com outro pedido ou com o executor resulta em `recusado` |
| pedido de robô | `solicitadoPor` (id e nome) é obrigatório, identidade de automação recebe 422 e a lista de códigos nasce vazia |
| card fabricado | card só nasce de `devolver`, só com dado do Bastão e só pelas regras do ADR 0035 D2 (INV-006, INV-017, INV-040, regra de ouro do CTRC) |
| lock em tabela quente | nenhum `ALTER` em `cards`, `card_events` ou `audit_log`. A tabela de pedidos não tem FK para `cards`, de propósito |
| a 49 por cima da 54 | o pedido não move card existente. Quem move é o sync-bastao, quando o Bastão mostra a 49 (INV-019) |
| placar e monitor da 49 contam a 49 da operação | registrado no ADR. Se contaminar, filtrar por `todo_id IS NULL` |

## Como ligar

Um passo por vez, pelo trilho:

1. Revisar e rodar as suítes:
   `deno test --no-check --allow-read --allow-env supabase/functions/_shared/ponte-operacao-*.test.ts`
2. Confirmar a paridade de CTRC com um caso real.
3. Merge da ponte v1 e desta branch.
4. **Mig 411** (`dbq.py --autorizado-por`). Ela é inerte, e o smoke confirma isso.
5. Secret `COCKPIT_APP_URL` (opcional). O `ROTEIRIZADOR_PONTE_TOKEN` já é o da v1.
6. Deploy das 3 edges. Elas respondem 503 ou `skipped`.
7. `ponte_operacao_leitura` ON. Conferir 3 CTRCs conhecidos.
8. **Mig 412** (cron) e prova de pulso (INV-156).
9. `ponte_operacao_pedidos` ON, ainda sem SSW. Conferir o evento no card e o status
   `executado` com "a 49 não foi lançada".
10. Medir a taxa de login (INV-159 c). Depois, `ponte_operacao_lancar_ssw` ON, em horário
    calmo e com um CTRC de teste.
11. Códigos de `lancar_ocorrencia`, um por um. Cada um precisa de `criterio`, `pedido_por`
    e `autorizado_por` (TIPO B).

## Como desligar

- **SSW:** `ponte_operacao_lancar_ssw` OFF. Vale no próximo lançamento, porque a flag é
  relida antes de cada um.
- **Pedidos:** `ponte_operacao_pedidos` OFF. POST e GET respondem 503 e o worker fica
  `skipped`.
- **Leitura:** `ponte_operacao_leitura` OFF, e o endpoint responde 503.
- **Um código:** `UPDATE ponte_operacao_codigos_permitidos SET ativo = false WHERE codigo = N`.
- **Tudo:** `cron.unschedule('processar-pedidos-operacao')` e a receita de reversão do
  cabeçalho da mig 411.
- **O que não volta:** ocorrência já lançada não se desfaz, e card nascido de pedido segue
  como qualquer card.

## O que o Roteirizador precisa garantir do lado dele

- chamar `ponte-pedido-operacao` **só a partir do clique** de uma pessoa, nunca de agente;
- mandar o CTRC com trim e em maiúsculas;
- fazer cache de 60 s ou mais para `ponte-tratativas`;
- tratar `cardId: null` no 202 e consultar o GET.

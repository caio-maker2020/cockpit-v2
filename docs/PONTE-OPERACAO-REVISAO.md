# Ponte v2 (Painel da Operação): o que o time do Cockpit precisa revisar

Branch `matheuscastro12-eng/ponte-operacao`, que parte da ponte v1
(`matheuscastro12-eng/ponte-cockpit`). A decisão completa está no ADR 0039, já com as emendas de 25/09 do contrato (NF opcional
no pedido, `tratativaDesde`, 409 e token próprio).

**Nada foi aplicado, deployado ou ligado.** As migrations 418 e 419 estão só como arquivo,
as três flags nascem OFF e nenhum secret foi criado.

## O que muda

O Roteirizador ganha uma tela da operação. Ela fala com o Cockpit por dois endpoints
novos, e um worker novo executa o que for pedido.

| Peça | O que faz | Escreve em |
|---|---|---|
| `ponte-tratativas` (POST) | lê, por CTRC, o estado da tratativa e o `bloqueiaEntrega`, com o motivo, a data no texto e em `tratativaDesde` | **nada** |
| `ponte-pedido-operacao` (POST/GET) | registra o pedido da operação e, se o CTRC tem card ativo, grava o evento no card | `ponte_operacao_pedidos`, `card_events` |
| `processar-pedidos-operacao` (cron 1 min) | acha ou cria o card (Bastão) e lança a 49 ou a ocorrência pelo envelope, até 2/min | `cards` (só INSERT de card novo), `card_events`, `audit_log`, `acoes_executadas_ssw` (pelo envelope) |

**O que não muda:** executor, envelope do SSW, tripé, sync da v1, roteador de eventos,
redator, IA da 49, vinculador, sync-bastao e `prompts/` estão **byte a byte iguais** ao
commit da v1 (`fbc5e30`, hoje `7c4f0cb` depois do rebase sobre o master `178dcf8`
em 07/10, com as migs renumeradas 410–412 → 417–419 e os ADRs 0034/0035 → 0038/0039),
e um teste prova isso. Nenhuma função existente importa o código novo.

## Risco, e onde está a trava

| Risco | Trava |
|---|---|
| rajada de login na conta `ai.salex` (INV-159) | o POST nunca faz login. A vazão é contada no banco: janela de 60 s, teto de 3/min, um por vez, quarentena de 30 min depois de um login recusado e o freio de emergência (`ponte_operacao_lancar_ssw`) relido antes de cada chamada ao SSW |
| ocorrência duplicada | `pedidoId` é a PK e a reserva é atômica. Lançamento interrompido vira `erro` e nunca é relançado. Duplicidade com outro pedido ou com o executor resulta em `recusado` |
| pedido de robô | `solicitadoPor` (id e nome) é obrigatório e a lista de códigos nasce vazia. A recusa de identidade de automação é só heurística: a garantia real é o Roteirizador mandar o usuário logado que clicou |
| token da v1 vazado abre a v2 | a v2 usa um token só dela, `PONTE_OPERACAO_TOKEN`; o `ROTEIRIZADOR_PONTE_TOKEN` não autentica aqui |
| NF errada vinda do Roteirizador | a NF do pedido é conferida contra a do card e a do Bastão (divergência é recusa) e só entra no tripé quando o card não tem NF; o tripé confere com o SSW antes do submit |
| `pedidoId` reusado com outro conteúdo | 409 com o status do original, sem executar |
| card fabricado | card só nasce de `devolver`, só com dado do Bastão e só pelas regras do ADR 0039 D2 (INV-006, INV-017, INV-040, regra de ouro do CTRC) |
| loop de fabricação (INV-040) | o nascimento por pedido passa pelo mesmo guard do sync (`excedeuLimiteLoopCriacao`, 3 encerrados da NF em 24 h), aqui fail-closed; e o card nunca nasce encerrado |
| lock em tabela quente | nenhum `ALTER` em `cards`, `card_events` ou `audit_log`. A tabela de pedidos não tem FK para `cards`, de propósito |
| a 49 por cima da 54 | o pedido não move card existente. Quem move é o sync-bastao, quando o Bastão mostra a 49 (INV-019) |
| placar e monitor da 49 contam a 49 da operação | registrado no ADR. Se contaminar, filtrar por `todo_id IS NULL` |

## Testes

- **Suítes da v2:** 5, todas verdes:
  `deno test --no-check --allow-read --allow-env supabase/functions/_shared/ponte-operacao-*.test.ts`.
- **Suíte `_shared` inteira** (`deno test --no-check --allow-all supabase/functions/_shared/`):
  2 falhas **pré-existentes**, que não são desta branch. Elas já falhavam no master
  `92cd9fb` (merge da mig 409, 24/09) e na ponte v1 `fbc5e30`:
  1. `supabase/functions/_shared/regras-auto-acao.sem-email-54.test.ts`: "card oc=49 com
     override 59 (extravio total): cria 59+email E gêmeo 59 sem email";
  2. `supabase/functions/_shared/tools-registrados-no-front.test.ts`: "a lista de exceções
     não pode conter tool que nem existe mais (higiene)".

## Como ligar

A ordem é fixa, um passo por vez, pelo trilho:

**418 → deploy das 3 funções → 419 → `leitura` ON → `pedidos` ON (worker sem SSW) →
`lancar_ssw` por último, com a lista de códigos ainda vazia.**

0. **Antes:**
   - rodar as suítes:
     `deno test --no-check --allow-read --allow-env supabase/functions/_shared/ponte-operacao-*.test.ts`;
   - confirmar a paridade de CTRC com um caso real;
   - merge da ponte v1 e desta branch.
1. **Mig 418** (`dbq.py --autorizado-por`). Ela é inerte, e o smoke confirma isso.
2. **Deploy das 3 funções** (`ponte-tratativas`, `ponte-pedido-operacao`,
   `processar-pedidos-operacao`). Antes do deploy, criar o secret
   **`PONTE_OPERACAO_TOKEN`**, novo, com o mesmo valor do `RI_COCKPIT_TOKEN` do
   Roteirizador (não reusar o `ROTEIRIZADOR_PONTE_TOKEN` da v1). `COCKPIT_APP_URL` é
   opcional. As três respondem 503 ou `skipped`.
3. **Mig 419** (cron) e prova de pulso (INV-156). O worker fica `skipped: flag_off`.
4. **`ponte_operacao_leitura` ON.** Conferir 3 CTRCs conhecidos.
5. **`ponte_operacao_pedidos` ON: o worker roda sem SSW.** Conferir o evento no card e o
   status `executado` com "a 49 não foi lançada".
6. **`ponte_operacao_lancar_ssw` ON, por último, com a lista de códigos ainda vazia:** só
   a 49 do `devolver` vai ao SSW. Antes, medir a taxa de login (INV-159 c). Ligar em
   horário calmo e com um CTRC de teste.

**Depois, fora desta ordem:** códigos de `lancar_ocorrencia`, um por um, cada um por uma
migration TIPO B com `--autorizado-por`. Só fato da rota (saiu, não coube, não chegou),
nunca tratativa. Dono: Caio. Ver ADR 0039, D4.

## Como desligar

- **SSW:** `ponte_operacao_lancar_ssw` OFF. Vale no próximo lançamento, porque a flag é
  relida antes de cada um.
- **Pedidos:** `ponte_operacao_pedidos` OFF. POST e GET respondem 503 e o worker fica
  `skipped`.
- **Leitura:** `ponte_operacao_leitura` OFF, e o endpoint responde 503.
- **Um código:** `UPDATE ponte_operacao_codigos_permitidos SET ativo = false WHERE codigo = N`.
- **Tudo:** `cron.unschedule('processar-pedidos-operacao')` e a receita de reversão do
  cabeçalho da mig 418.
- **O que não volta:** ocorrência já lançada não se desfaz, e card nascido de pedido segue
  como qualquer card.

## O que o Roteirizador precisa garantir do lado dele

- chamar `ponte-pedido-operacao` **só a partir do clique** de uma pessoa, nunca de agente;
- mandar o CTRC com trim e em maiúsculas;
- fazer cache de 60 s ou mais para `ponte-tratativas`;
- tratar `cardId: null` no 202 e consultar o GET;
- mandar a `nf` quando souber, e tratar o 409 (`pedidoId` reusado) como bug do lado dele;
- chamar com `RI_COCKPIT_TOKEN`, que é o `PONTE_OPERACAO_TOKEN` do Cockpit.

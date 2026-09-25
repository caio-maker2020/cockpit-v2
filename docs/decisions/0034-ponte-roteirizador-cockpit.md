# ADR 0034 — Ponte Roteirizador ↔ Cockpit (lado do Cockpit)

Data: 2026-09-24
Status: proposto. Código na branch `matheuscastro12-eng/ponte-cockpit`. A migration 410
**não foi aplicada** (nem em dry-run), nenhuma edge foi deployada e nenhuma flag foi ligada.
Tudo aguarda o time do Cockpit, pelo trilho.
Contrato: `docs/PONTE-COCKPIT.md` no repo do Roteirizador Inteligente (o lado dele está
pronto e testado).
Guards: **INV-160** · migration `2026-09-24_410_ponte_roteirizador.sql`

## Contexto

A Sal Express tem dois sistemas de agentes. Cada um é dono de uma coisa:

| | Roteirizador Inteligente | Cockpit |
|---|---|---|
| Dono de | rota do dia: plano, carro, motorista, execução | NF e cliente: conversa, tratativa, ocorrência |
| SSW | só **lê** | **escreve** (lança ocorrência) |

O Cockpit não sabe em que carro está a nota nem se ela saiu hoje. O Roteirizador não fala
com o cliente e não sabe o que foi combinado com ele. A ponte (`/v3/ponte`, Bearer
`ROTEIRIZADOR_PONTE_TOKEN`) liga os dois sem que um reimplemente o outro.

## Decisão

Quatro peças. Todas ficam inertes enquanto a flag correspondente estiver OFF **e**
enquanto faltar a env (dupla trava).

1. **Adapter** `_shared/roteirizador-ponte-client.ts`
   - Timeout por tentativa e retry exponencial curto só em 5xx, rede ou timeout. 4xx nunca
     é repetido.
   - Erros tipados (`desligado`, `nao_autorizado`, `invalido`, `indisponivel`, `timeout`,
     `rede`, `resposta_invalida`…).
   - **Nunca lança**: devolve `ResultadoPonte`.
   - Env ausente = cliente desligado.

2. **`consultar_rota_roteirizador(ctrc)`** — `_shared/consultar-rota-roteirizador.ts`,
   flag `roteirizador_ponte_consulta_enabled`
   - Os agentes do Cockpit não fazem `tool_use`; eles usam `completeJson`. Por isso a
     "tool" é determinística: o código consulta `GET /notas/:ctrc` **antes** da chamada ao
     modelo e injeta um bloco de contexto com carro, motorista, situação e link de
     rastreio. É o mesmo padrão do `estadoBloco` da oc 49.
   - Pontos de uso:
     - **rastreamento**: `redator` (só `card.tipo === "rastreamento"`);
     - **extravio**: IA da oc 49 (`montarContextoIa49`, cobre o fallback e a sombra).
   - O CTRC vem **sempre do card**, nunca de busca por NF.
   - O telefone do motorista fica fora do bloco, porque o prompt redige texto para o
     cliente.
   - Falha, flag OFF ou card sem CTRC resultam em `null` e o prompt fica igual ao de hoje.

3. **Compromisso de reentrega** — `_shared/compromisso-reentrega-ponte.ts`, flag
   `roteirizador_ponte_compromissos_enabled`
   - Roda no executor, **depois** do sucesso do lançamento da oc 21. Não encosta no
     envelope `lancarSswPortal`.
   - Faz `POST /compromissos` com `tipo=reentrega`, o CTRC do card, `cardId` e
     `idempotencyKey = ${card_id}:reentrega:${data}`.
   - Grava `audit_log` (`external_system='roteirizador'`) e um card_event
     (`CompromissoEnviadoAoRoteirizador` ou `CompromissoRoteirizadorFalhou`).
   - Falha da ponte não bloqueia a tratativa.
   - **A data só vem de campo estruturado**: `extras.data_reentrega` (YYYY-MM-DD), mais
     `janela_inicio`/`janela_fim` (HH:MM) e `observacao_reentrega` opcionais. Hoje
     **nenhum produtor preenche esses campos**: a data combinada existe só como texto
     livre (`instrucao_reentrega_sugerida`). Tirar data de texto livre seria inventar
     dado, por isso não fazemos. Enquanto ninguém preencher, a peça é no-op mesmo com a
     flag ligada. Próximo passo: um produtor, seja um campo de data no modal da 21 ou um
     campo estruturado no schema do interpretador (mudança de prompt versionada).
   - Os campos novos **não** entram na Instrução do SSW: a whitelist
     `EXTRAS_PRA_DESCRICAO_SSW` não os lista.
   - Limitação aceita: mesma data com janela nova usa a mesma chave, então não atualiza o
     compromisso. Para trocar a janela é preciso cancelar no Roteirizador
     (`DELETE /compromissos/:id`, fora deste escopo).

4. **Sync de eventos** — edge `sync-roteirizador-ponte`, cron */5, flag
   `roteirizador_ponte_sync_enabled`
   - Lê `GET /eventos` por cursor (`roteirizador_ponte_cursor`). O cursor só avança
     quando a página inteira foi gravada.
   - É idempotente: PK `(evento_id, ctrc)` em `roteirizador_ponte_eventos`. A RPC
     `ponte_roteirizador_registrar_linha` grava a linha e o card_event na mesma transação.
   - Roteamento (`_shared/roteirizador-eventos-rotear.ts`, puro):

     | Evento | Card ativo do CTRC | Sem card ativo |
     |---|---|---|
     | `nota_removida` / `nota_nao_coube` **com motivo** (ALERTA) | card_event `RoteirizadorAlertaRota` | `aguardando_card`: anexado quando o card aparecer (≤72h), depois expira |
     | `rota_aprovada`, `nota_seguida`, `nota_fora_da_doca`, removida/não coube sem motivo (CONTEXTO) | card_event `RoteirizadorContextoRota` | `sem_card` (só registro) |
     | tipo fora do contrato / sem CTRC | — | `ignorado` |

   - O sync **nunca cria card, nunca muda `state` nem `cod_ultima_ocorrencia`**. Card
     terminal (RESOLVIDO/CANCELADO/TRANSFERIDO) não recebe evento (INV-042).

### Por que não abrir card / não mandar pelo intake quando não há card

- **INV-001 + ADR 0004:** card nasce do Bastão (ocorrências de relacionamento) ou de
  mensagem **do cliente**. Um evento de rota não é nenhum dos dois.
- Empurrar o evento como "mensagem" para o triador/vinculador fabricaria card a partir
  de texto sintético, fora do escopo do Relacionamento, e por um caminho de criação sem o
  guard anti-loop (INV-040).
- O fluxo natural já cobre o caso: a nota removida da rota vira ocorrência no SSW,
  lançada pela base. O Bastão traz o card se ele for de relacionamento, e o alerta
  pendente é anexado nesse momento. O Relacionamento vê o motivo do motorista no card
  assim que o card existe.
- Se o time quiser o card **antes** do SSW, isso é outra decisão: um caminho de criação
  próprio, com guard INV-040 e escopo de ocorrência. Fica para outro ADR.

## Consequências e riscos

- **Formato do CTRC:** o match é por igualdade com `cards.ctrc`, que já é normalizado
  (`AMB642904-1`, upper/trim). Os exemplos do contrato (`VGA123`) são sintéticos.
  **Antes de ligar qualquer flag**, confirmar com um CTRC real que o Roteirizador devolve
  o mesmo formato, com série e dígito. Sem paridade, a consulta volta `noPlano:false` e o
  sync não acha card. É inofensivo, mas deixa tudo inútil.
- **audit_log:** o CHECK de `external_system` ganha `'roteirizador'` (mig 410, item 2).
  O ALTER/VALIDATE trava o audit_log durante a varredura. Sugestão: aplicar o item 2 em
  migration separada, fora do pico. Sem ele, o compromisso funciona, mas o audit_log
  falha no CHECK e vira só log. O card_event continua sendo gravado.
- **Cron:** reusa o segredo do vault `cron_sync_bastao_key`. Se ele rotacionar, os três
  crons precisam ser atualizados.
- **Sem gate de chamador:** o sync segue o padrão de `sync-extravios-bastao`
  (`verify_jwt=false`, sem checar o chamador). Invocá-lo só dispara um sync idempotente.
- **Latência:** o compromisso acrescenta até ~8s ao executor no pior caso (2 tentativas
  de 4s), depois do lançamento no SSW. A consulta acrescenta a mesma latência ao redator
  e à IA da 49, e só com a flag ligada.
- `RoteirizadorAlertaRota` ainda **não** marca a memória do card (`estado_tratativa`)
  como dirty. Entrar na lista do trigger `project_card_event` é TIPO B (REPLACE de função
  existente) e fica para quando o evento provar valor.

## Ordem de ativação sugerida

1. Paridade de CTRC confirmada.
2. Env `ROTEIRIZADOR_API_URL` e `ROTEIRIZADOR_PONTE_TOKEN` nos secrets das edges.
3. Deploy de `sync-roteirizador-ponte`, `redator`, `executor` e `agente-sugere-ocs-padrao`
   (usar `deploy_pendente.py`).
4. Aplicar a mig 410 e fazer a prova de pulso (INV-156).
5. `roteirizador_ponte_sync_enabled` ON. Conferir `roteirizador_ponte_eventos` e o cursor.
6. `roteirizador_ponte_consulta_enabled` ON. Conferir `agent_runs.input.rota_roteirizador`
   do redator.
7. `roteirizador_ponte_compromissos_enabled` ON, só quando existir produtor de
   `extras.data_reentrega` e o time da base estiver ciente, porque isso muda o plano do
   dia.

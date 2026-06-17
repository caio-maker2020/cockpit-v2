# Máquina de estados do card

Card = agregado vivo de uma tratativa de NF. Estado atual é **projeção** de `card_events`. Toda transição é evento auditável.

## Estados

| Estado | Significado | Quem entra | Quem sai |
|---|---|---|---|
| `RECEBIDO` | Mensagem chegou ou ocorrência SSW abriu, ainda sem classificação | Ingestor | Triador conclui |
| `EM_TRIAGEM` | Triador rodando | Triador | Ao publicar evento `ClassificacaoConcluida` |
| `AGUARDANDO_VINCULACAO` | Triador classificou, aguarda vinculador | Triador | Vinculador conclui |
| `AGUARDANDO_CONTEXTO` | Faltam dados externos (consulta SSW, dados cliente) | Agente especialista | Contexto chegou |
| `AGUARDANDO_AGENTE` | Pronto, na fila do agente especialista | Vinculador / Sistema | Agente assume |
| `EM_EXECUCAO_AUTOMATICA` | Agente raciocinando/agindo | Agente | Próxima decisão |
| `AGUARDANDO_VALIDACAO_HUMANA` | Agente propôs ação que exige aprovação | Agente | Operador aprova/rejeita |
| `EXECUTANDO_ACAO` | Validado, executor agindo | Sistema | Ação concluída ou erro |
| `AGUARDANDO_CLIENTE` | Resposta enviada, esperando cliente responder | Executor | Cliente responde OU SLA estoura |
| `AGUARDANDO_TERCEIRO` | Esperando SSW (sync Bastão), motorista, embarcador | Executor | Evento externo chega |
| `BLOQUEADO_POR_ERRO` | Falha técnica não resolvida pelo agente | Sistema | Humano destrava |
| `ESCALADO_HUMANO` | Caso fora do escopo do agente (jurídico, indenização alta, avaria com seguro) | Agente / Operador | Humano resolve |
| `EXTRAVIO_MONITORADO` | Card de extravio (oc 6/9/16, resp. Perdas) visível na aba EXTRAVIOS pro Relacionamento monitorar. NÃO processado por agentes de relacionamento. | sync-extravios-bastao | Operador age (49/54 → fluxo normal) OU Perdas localiza (oc=20) |
| `RESOLVIDO` | Caso fechado | Sistema / Operador | Final (reabrível) |
| `CANCELADO` | Card duplicado, falso positivo, classificação errada | Operador | Final |

## Eventos que disparam transições

| Evento | Origem | Pode transitar pra |
|---|---|---|
| `MensagemEntrante` | Ingestor | cria card em `RECEBIDO` ou anexa em existente |
| `OcorrenciaSSWDetectada(54)` | Sync Bastão | cria card em `AGUARDANDO_CLIENTE` (ocorrência 54 = aguardando retorno) |
| `OcorrenciaSSWDetectada(21)` | Sync Bastão | move pra `AGUARDANDO_TERCEIRO` (acompanhamento) |
| `OcorrenciaSSWDetectada(14)` | Sync Bastão | move pra `RESOLVIDO` |
| `ClassificacaoConcluida` | Triador | `AGUARDANDO_VINCULACAO` |
| `VinculacaoConcluida` | Vinculador | `AGUARDANDO_AGENTE` |
| `AgenteAssumiuCard` | Agente especialista | `EM_EXECUCAO_AUTOMATICA` |
| `ContextoFaltando` | Agente especialista | `AGUARDANDO_CONTEXTO` |
| `ContextoCarregado` | Adapter (SSW, etc.) | volta pra `EM_EXECUCAO_AUTOMATICA` |
| `AcaoPropostaPeloAgente` | Agente especialista | `AGUARDANDO_VALIDACAO_HUMANA` |
| `AprovacaoOperador(acao_id)` | Operador | `EXECUTANDO_ACAO` |
| `RejeicaoOperador(motivo)` | Operador | volta pra `EM_EXECUCAO_AUTOMATICA` com feedback |
| `AcaoExecutadaComSucesso(payload)` | Executor | depende da ação: `AGUARDANDO_CLIENTE`, `AGUARDANDO_TERCEIRO`, ou `RESOLVIDO` |
| `AcaoFalhou(erro)` | Executor | `BLOQUEADO_POR_ERRO` se irrecuperável |
| `RespostaClienteRecebida` | Ingestor (em card existente) | reativa fluxo: novo `EM_EXECUCAO_AUTOMATICA` |
| `SLAEstourado` | Cron | escala risco ou notifica gestor; pode mover pra `ESCALADO_HUMANO` |
| `AutoAprovacaoPermitida(regra)` | Sistema | atalho de `AGUARDANDO_VALIDACAO_HUMANA` direto pra `EXECUTANDO_ACAO` |

## Sub-estados por tipo de tratativa

Cada agente especialista mantém **mini-FSM interna** dentro de `EM_EXECUCAO_AUTOMATICA`. Exemplo Reentrega:

```
EM_EXECUCAO_AUTOMATICA:
  └─ aguardando_confirmacao_endereco
  └─ endereco_confirmado
  └─ aguardando_lancamento_21
  └─ ocorrencia_21_lancada
  └─ aguardando_followup_d+1
```

Esses sub-estados ficam num campo `agent_state` no card, **não** poluem o estado principal. Auditoria continua sendo via `card_events`.

## Regras invariantes

- **Card em `EXECUTANDO_ACAO` é monoexecutado.** Lock pessimista no `card_id` durante execução pra impedir 2 ações simultâneas.
- **Toda transição publica `card_events`.** Sem exceção.
- **`audit_log` SEMPRE** pra ações com efeito externo (SSW, WhatsApp, e-mail). Pode ser implícito em transição de estado também, mas tem que ter linha em `audit_log`.
- **Reabertura:** card em `RESOLVIDO` que recebe `MensagemEntrante` volta pra `EM_TRIAGEM` (não cria card novo).
- **Cancelamento:** só por humano. Agente nunca cancela card.

## Estados terminais

`RESOLVIDO` e `CANCELADO`. Mas `RESOLVIDO` é **reabrível** se o cliente voltar a falar.

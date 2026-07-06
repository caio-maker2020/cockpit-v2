# Lovable — Restaurar o checkbox "NÃO VALIDAR EVIDÊNCIA" no envio de e-mail ao cliente (aba AGUARDANDO VOCÊ)

## Contexto
Existia um checkbox **"MARCAR PARA NÃO VALIDAR EVIDÊNCIA"** no modal de aprovação, usado pelos operadores em alguns casos ao notificar o cliente por e-mail. Ele **sumiu do front**. O backend continua suportando a flag — só falta o controle na tela.

## Por que importa
Nas ocorrências **10, 11 e 35** (recusa / endereço errado / recusa parcial), quando a ação envia e-mail com o link de evidência, o Cockpit **bloqueia o envio** se não houver foto correlacionada no SSW (erro de "evidência indisponível"). Em alguns casos a foto existe em outra oc, ou o operador vai anexar manualmente — ele precisa poder **dispensar a validação** e seguir com o envio + lançamento.

## O que implementar
No modal de aprovação das ações que **notificam o cliente por e-mail**, na aba **AGUARDANDO VOCÊ**, adicionar um checkbox:

> ☐ **Não validar evidência** — envia o e-mail e lança a oc mesmo sem foto correlacionada no SSW (você se responsabiliza por anexar manualmente). Fica registrado em auditoria.

### Quando mostrar
Quando a ação aprovada envia e-mail ao cliente, ou seja:
`todo.proposta_payload.tool === 'lancar_oc_e_enviar_email'` **OU** `todo.proposta_payload.meta?.modo === 'completo'`.
(É especialmente necessário quando `card.cod_ultima_ocorrencia ∈ {10, 11, 35}` — é aí que o envio é bloqueado por falta de foto. Pode mostrar sempre que houver e-mail; nas demais ocs a flag é inócua.)

NÃO mostrar nas ações "sem e-mail" (`meta.sem_email_explicito === true`) — não há validação de evidência ali.

### Comportamento
- Default: **desmarcado**.
- Quando **marcado**, incluir no `p_extras` da chamada `aprovar_e_executar(p_todo_id, p_extras)`:
  ```json
  { "skip_evidencia": true }
  ```
  (Merge com os extras que o modal já manda — ex.: `template_id_override`, `email_destinatarios`, `quantidade_volumes`. Apenas adicione a chave `skip_evidencia`.)
- Quando desmarcado, **não** enviar a chave (ou enviar `false`).

### Backend (já pronto, não precisa mexer)
- O executor lê `args.extras.skip_evidencia`. Se `true`, pula a validação de evidência (`deveValidarEvidencia = ... && !skipEvidencia`), envia o e-mail + lança a oc, e registra o evento `EvidenciaIgnoradaPorOperador` (auditoria de quem ignorou, quando e a oc).
- Chave exata: **`skip_evidencia`** (booleano `true`). Não é `validar_evidencia` (essa é a flag oposta, opt-in pra oc 49).

## Critério de aceite
- Em um card oc 10/11/35 sem foto no SSW, ao aprovar "Lançar oc 54 + e-mail" com o checkbox **marcado**, o e-mail é enviado e a oc lançada (sem o erro de "evidência indisponível"), e aparece o evento `EvidenciaIgnoradaPorOperador` no histórico.
- Com o checkbox **desmarcado**, o comportamento atual de bloqueio por falta de evidência permanece.

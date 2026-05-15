# Lovable — aba RESPOSTA: cobrança em AGUARDANDO_CLIENTE

**Data:** 2026-05-15
**Backend:** edge `cobrar-cliente-aguardando` em produção. Cron diário envia automático em 4 dias úteis sem retorno (max 2 disparos: 4d + 8d).

## Contexto

Quando o Cockpit lança oc=54 + email, o card vai pra `state=AGUARDANDO_CLIENTE`. Esperamos retorno do cliente. Se o cliente não responde em 4 dias úteis, sistema dispara cobrança autônoma; mas operador também pode disparar manualmente quando achar útil.

## O que adicionar

Na aba **RESPOSTA** do card (já existe pra resposta livre via `responder-email-cliente`):

### Quando card está em state `AGUARDANDO_CLIENTE`

1. **Indicador de dias sem retorno** (topo da aba):
   - Cálculo: `now() - max(cards_emails_outbound.sent_at WHERE card_id=X)`.
   - Mostrar formatado em **dias úteis** (seg-sex). Helper: na dúvida usar a função `dias_uteis_entre(t1, t2)` via RPC Supabase.
   - Texto: "Cliente sem retorno há **X dias úteis** desde o último email enviado."
   - Cor:
     - 0–3 dias: cinza neutro
     - 4–7 dias: amarelo (1ª cobrança já saiu automática, se ≥ 4)
     - 8+ dias: vermelho

2. **Bloco "Cobranças enviadas"**:
   - Mostrar contador `cobranca_cliente_emails_enviados` (0, 1, ou 2).
   - Texto:
     - `0` → "Nenhuma cobrança automática enviada ainda."
     - `1` → "1 cobrança automática enviada em **DD/MM**."
     - `2` → "2 cobranças automáticas enviadas — máximo atingido. Operador pode enviar manual."
   - Listar timestamps de `card_events` onde `event_type='CobrancaClienteEmailEnviada'` (mostra histórico das automáticas + manuais).

3. **Botão "ENVIAR COBRANÇA AGORA"**:
   - Aparece sempre que `state=AGUARDANDO_CLIENTE`.
   - Texto fixo enviado: `"{nome_pessoa}, estamos aguardando um retorno para finalizarmos a tratativa. Obrigado."` (nome do contato do email destinatário; fallback "Olá," se sem nome). Operador NÃO edita esse texto — botão é pra cobrança rápida sem fricção. Se quiser texto custom, usa o composer livre que já existe na aba RESPOSTA.
   - Click:
     ```js
     const { data, error } = await supabase.functions.invoke('cobrar-cliente-aguardando', {
       body: { card_id: card.id, modo: 'manual' }
     });
     ```
   - Resposta esperada: `{ ok: true, gmail_message_id, destinatario, saudacao }`.
   - Sucesso → toast: "Cobrança enviada pra {destinatario}".
   - Erro → toast com `data.error`.

## Cron automático (info pro operador, não precisa implementar nada)

- Cron `cobranca-cliente-aguardando-daily` roda diariamente às 09:00 BRT.
- Pra cada card em AGUARDANDO_CLIENTE há ≥ 4 dias úteis sem retorno do cliente E com `cobranca_cliente_emails_enviados < 2`, dispara cobrança automática.
- Máximo 2 disparos automáticos. Depois disso só manual.
- Card_events tipo `CobrancaClienteEmailEnviada` registram tudo (modo=manual ou modo=automatico).

## Critérios de aceite

1. Card em AGUARDANDO_CLIENTE com último outbound há 2 dias úteis → mostra "2 dias úteis" (cinza), botão "Enviar cobrança" disponível, 0 cobranças no histórico.
2. Operador clica botão → toast sucesso, card_events ganha 1 row `CobrancaClienteEmailEnviada actor_type=operator`, cliente recebe email com saudação personalizada na mesma thread.
3. Card em AGUARDANDO_CLIENTE há 5 dias úteis sem retorno → cron automático já mandou cobrança automática (count=1), bloco mostra "1 cobrança automática enviada em DD/MM".
4. Card há 10 dias úteis sem retorno → count=2, texto "Máximo atingido. Operador pode enviar manual." Botão continua funcional (chamada manual não incrementa contador).
5. Card sai pra `CLIENTE_RESPONDEU` (state=AGUARDANDO_VALIDACAO_HUMANA + cliente_respondeu_em != null) → indicador some, botão some.

## Schema de referência

```ts
// cards
cobranca_cliente_emails_enviados: number  // 0, 1, 2 (máx)
cobranca_cliente_ultima_em: string | null  // timestamptz
cliente_respondeu_em: string | null

// cards_emails_outbound (existente)
sent_at: string
gmail_thread_id, gmail_message_id, to_email, subject

// card_events filter
event_type='CobrancaClienteEmailEnviada'
payload.modo: 'manual' | 'automatico'
payload.contagem_auto_pos_disparo: number | null
```

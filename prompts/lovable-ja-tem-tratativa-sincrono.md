# Lovable — Botão "JÁ TEM TRATATIVA" deve rodar o scan NA HORA (síncrono) e mostrar o resultado

## Problema (NF 721938)
Hoje o botão "JÁ TEM TRATATIVA" chama a RPC `buscar_tratativa_do_card`, que só **enfileira** um job e volta na hora — mas o resultado depende de um worker que estava entupido. O operador clicava e **não puxava nada**. O backend já foi corrigido (a fila não entope mais), mas o botão continua assíncrono: o operador não vê o resultado na hora.

## O que mudar
O botão "JÁ TEM TRATATIVA" deve rodar o scan **de forma SÍNCRONA** e mostrar o resultado imediatamente, em vez de só enfileirar.

### Chamada
Invocar a Edge Function `scan-email-pre-card` com o corpo:
```json
{ "scan_card_id": "<card.id>", "contexto": "card_em_espera" }
```
(POST; a função roda o scan na hora — busca no Gmail do operador dono do card — e retorna o resultado.)

### Resposta
```json
{ "ok": true, "debug": true, "resultado": { "resultado": "sugerido", "candidatos_total": 1, "melhor_score": 85 } }
```
Valores de `resultado.resultado`:
- `"sugerido"` → achou tratativa(s). O backend gravou `cards.email_preexistente_sugerido`. **Re-buscar o card** (ou a view `v_email_preexistente`) e renderizar os candidatos (assunto, participantes, preview das mensagens, score).
- `"nenhum_candidato"` → não há thread compatível. Toast: "Nenhuma tratativa encontrada para esta NF."
- `"sem_credencial_gmail"` → toast: "Operador sem Gmail conectado — reconectar."
- `"sem_operador"` / `"sem_nf"` / `"card_inexistente"` → toast de erro correspondente.
- `ok:false` → toast: "Erro ao buscar tratativa" + `error`.

### UX
- Mostrar **loading** no botão enquanto roda (o scan leva ~2-6s, é busca no Gmail).
- Ao terminar com `sugerido`, abrir/atualizar o painel de tratativa pré-existente com os candidatos de `email_preexistente_sugerido` (mesmo componente que já renderiza a sugestão automática).
- Permitir as ações que já existem nesse painel (Seguir / adotar thread / descartar).

### Onde ler os candidatos
`cards.email_preexistente_sugerido` (jsonb):
```
{
  "tipo": "thread_preexistente",
  "candidatos": [
    { "score": 85, "assunto": "...", "iniciada_em": "...", "participantes": ["..."],
      "preview": [ { "de": "...", "ts": "...", "direcao": "inbound|outbound", "snippet": "..." } ] }
  ]
}
```
Ou a view `v_email_preexistente` (já filtra `tipo='thread_preexistente'` e não-decididos).

## Importante
- **Não** depender mais só da RPC `buscar_tratativa_do_card` (ela continua existindo e agora é deduplicada, mas é assíncrona). O caminho do clique deve ser a chamada síncrona acima, pra o operador ver o resultado na hora.
- Manter o botão visível em cards em AGUARDANDO VOCÊ / AGUARDANDO CLIENTE sem e-mail rastreado (como hoje).

## Critério de aceite
- Clicar "JÁ TEM TRATATIVA" mostra loading e, em poucos segundos, ou lista a(s) tratativa(s) encontrada(s) ou diz "Nenhuma tratativa encontrada" — nunca fica em silêncio.

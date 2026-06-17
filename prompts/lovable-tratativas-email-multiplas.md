# Lovable — Múltiplas tratativas de e-mail no mesmo card

Quando um card junta MAIS DE UMA thread Gmail da mesma NF (ex.: conversa com o
pagador + conversa de agendamento com o destinatário), precisamos separar as
conversas visualmente, avisar a operadora e deixá-la escolher qual responder/
finalizar — SEM perder o layout de balões (estilo WhatsApp) que já existia.

Backend pronto (mig 212): RPCs `listar_tratativas_email_do_card` e
`escolher_tratativa_email`; coluna `cards.tratativa_email_escolhida`; executor
responde na thread escolhida; guard em `aprovar_e_executar` trava ação de e-mail
sem escolha quando há >1 tratativa ativa.

---

## REGRA DE OURO (correção do 1º round)

NÃO substituir o componente de mensagens. Os balões de conversa (resposta da
Larissa de um lado, do cliente do outro, com CORPO COMPLETO) continuam sendo a
ÚNICA coisa que renderiza cada mensagem. O RPC `listar_tratativas_email_do_card`
traz só um `preview` curto (280 chars) — é pra CABEÇALHO/AGRUPAMENTO, nunca pra
renderizar a mensagem. A separação por tratativa é só um AGRUPAMENTO (accordions
que abrem pra baixo) por cima dos balões existentes.

---

## Fonte de dados

### RPC de leitura (cabeçalho + agrupamento)
`supabase.rpc('listar_tratativas_email_do_card', { p_card_id: card.id })` →
```
{
  card_id, total_tratativas, tratativas_ativas,
  multiplas_tratativas: boolean,        // true => banner + trava
  tratativa_escolhida: string | null,   // gmail_thread_id escolhido
  tratativas: [{
    gmail_thread_id: string,
    assunto: string,                    // sem prefixos Re:/Res:
    participantes: string[],
    responder_para: string | null,      // e-mail pra responder esta tratativa
    qtd_mensagens, primeiro_em, ultimo_em,
    analisada_pela_ia: boolean,         // a sugestão da IA veio desta tratativa
    aguardando_resposta: boolean,       // última msg é do cliente (esperando nós)
    escolhida: boolean,
    mensagens: [...]                    // NÃO usar pra renderizar (preview curto)
  }]
}
```

### RPC de escolha
`supabase.rpc('escolher_tratativa_email', { p_card_id: card.id, p_thread_id: <gmail_thread_id> })`
(p_thread_id null limpa). Recarregar o card/RPC depois.

---

## UI

1. **Agrupar os balões existentes por tratativa.** Cada mensagem já tem o
   gmail_thread_id:
   - inbound: `messages_inbox.raw_payload.gmail_thread_id`
   - outbound: `cards_emails_outbound.gmail_thread_id`
   Agrupe as mensagens (com os balões originais, corpo completo) por
   gmail_thread_id, dentro de blocos/accordions que abrem pra baixo.

2. **Cabeçalho/ordem dos blocos vêm do RPC** (casar pelo gmail_thread_id):
   - ordem = ordem do array `tratativas`
   - título = `assunto`
   - badge "Analisada pela IA" se `analisada_pela_ia`
   - badge "Aguardando resposta" se `aguardando_resposta`
   - botão "Responder esta tratativa" (seleção)

3. **Banner** (quando `multiplas_tratativas === true`), no topo da seção de e-mails:
   "⚠️ ESSA NF TEVE MAIS DE UMA TRATATIVA NO E-MAIL LOCALIZADA. Escolha qual
   tratativa você vai responder e finalizar."

4. **Seleção:** ao clicar "Responder esta tratativa", chamar
   `escolher_tratativa_email` com o gmail_thread_id e marcar o bloco como escolhido.

5. **Travar:** enquanto `multiplas_tratativas === true` E
   `tratativa_escolhida === null`, DESABILITAR os botões de aprovar/finalizar
   (tooltip "Escolha qual tratativa responder primeiro"). Habilitar após escolha.

6. **Rotear a resposta:** ao aprovar uma ação que envia e-mail (aprovar_e_executar),
   passar em `p_extras`:
   `extras.email_destinatarios = [ <responder_para da tratativa escolhida> ]`
   (1º item = Para). O backend já responde na thread Gmail correta.

7. **Mensagens sem gmail_thread_id** (legado): mostrar normalmente ao final, fora
   dos blocos (ou num bloco "Outras mensagens"). Não somem.

8. Se `multiplas_tratativas === false`: comportamento atual (lista única de balões).
   Sem banner, sem exigir escolha.

---

RESUMO: balões de conversa anteriores INTACTOS; a novidade é só agrupá-los em
accordions por gmail_thread_id, com cabeçalho/seleção/banner vindos do RPC.

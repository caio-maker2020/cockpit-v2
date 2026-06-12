# Lovable — Banner amarelo "Email bloqueado pelo servidor do cliente"

**Data:** 2026-06-02
**Backend:** Mig 187 aplicada. Campos `cards.ultimo_bounce_em` e `cards.ultimo_bounce_payload` populados pelo `gmail-poll-inbox` quando detecta bounce SMTP.

## Contexto

Quando o email enviado pelo Cockpit pro cliente é rejeitado pelo servidor SMTP do destinatário (típico: `550 spam detected`), o `gmail-poll-inbox` agora detecta o bounce, **NÃO** vincula ao card como se fosse resposta do cliente, e **registra o bounce em `cards.ultimo_bounce_em` + `cards.ultimo_bounce_payload`**.

Sem alerta visual, a operadora não sabe que o canal está degradado. Caso âncora NF 5826 MIX MOTO — email retornou bounce 550, mas o cliente confirmou recepção por canal alternativo (quarentena/spam). Operadora não foi avisada, ficou aguardando resposta achando que o email tinha sido entregue normal.

## O que implementar

Quando `card.ultimo_bounce_em` é não-nulo E `card.cliente_respondeu_em` é nulo (ainda esperando resposta), mostrar banner amarelo no topo do card, acima do banner sugestão IA.

### Estrutura do payload

```ts
interface UltimoBouncePayload {
  destinatario: string | null;        // ex: "sac@mixmoto.com.br"
  motivo_smtp: string | null;         // ex: "550 The mail server detected your message as spam..."
  gmail_message_id: string;
  subject_original: string;           // ex: "Insucesso na entrega — NF 5826"
  detectado_em: string;               // ISO timestamp
}
```

### Banner

```tsx
{card.ultimo_bounce_em && !card.cliente_respondeu_em && (
  <div className="bg-amber-50 border-l-4 border-amber-500 p-3 mb-3">
    <div className="flex items-start gap-2">
      <span className="text-amber-700">⚠️</span>
      <div className="flex-1 text-sm">
        <p className="font-semibold text-amber-900">
          Email bloqueado pelo servidor do cliente
        </p>
        <p className="text-amber-800 mt-1">
          O servidor de {card.ultimo_bounce_payload?.destinatario ?? 'destino'} rejeitou
          o email enviado em {formatDataHora(card.ultimo_bounce_em)}.
          {card.ultimo_bounce_payload?.motivo_smtp && (
            <span className="block mt-1 font-mono text-xs text-amber-700">
              {card.ultimo_bounce_payload.motivo_smtp}
            </span>
          )}
        </p>
        <p className="text-amber-800 mt-2 text-xs">
          O cliente pode ter recebido em outro endereço (quarentena, spam, alias).
          <strong> Confirme recebimento por outro canal antes de aguardar resposta.</strong>
        </p>
        <button
          onClick={() => marcarBounceComoVisto(card.id)}
          className="mt-2 text-xs underline text-amber-900 hover:text-amber-700"
        >
          Já confirmei — dispensar aviso
        </button>
      </div>
    </div>
  </div>
)}
```

### Handler "dispensar aviso"

```ts
async function marcarBounceComoVisto(cardId: string) {
  const { error } = await supabase
    .from('cards')
    .update({ ultimo_bounce_em: null, ultimo_bounce_payload: null })
    .eq('id', cardId);
  if (error) {
    toast.error(`Não consegui dispensar: ${error.message}`);
    return;
  }
  queryClient.invalidateQueries({ queryKey: ['card', cardId] });
  toast.success('Aviso dispensado');
}
```

## SELECT do card precisa incluir os campos

Adicione no query principal:

```ts
.select('..., ultimo_bounce_em, ultimo_bounce_payload')
```

## Validação

NF 5826 MIX MOTO atualmente não tem mais o bounce (foi limpo no backfill 2026-06-02). Pra testar:
1. Aguardar próximo bounce real (gmail-poll-inbox vai popular sozinho), OU
2. Forçar manual: `UPDATE cards SET ultimo_bounce_em=now(), ultimo_bounce_payload='{"destinatario":"teste@cliente.com","motivo_smtp":"550 teste"}'::jsonb WHERE nf='5826';`

Após teste, dispensar via botão volta o campo pra NULL e banner some.

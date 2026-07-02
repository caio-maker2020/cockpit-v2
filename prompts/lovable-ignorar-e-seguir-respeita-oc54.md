# Lovable — Botão "IGNORAR E SEGUIR" (banner de pendências IA): avisar quando o card permanece em AGUARDANDO VOCÊ

## Contexto

No card, quando a IA detecta pendências na resposta do cliente (banner laranja "IA DETECTOU PENDÊNCIAS"), a operadora vê os botões **[✉ RESPONDER CLIENTE]** e **[IGNORAR E SEGUIR]**. O botão "IGNORAR E SEGUIR" chama a RPC `ignorar_pendencias_resposta_cliente(p_card_id, p_motivo)`.

Mudou uma regra no backend (invariante **INV-019** / oc=54 ⟺ AGUARDANDO CLIENTE): a aba **AGUARDANDO CLIENTE só pode conter cards com a última ocorrência = 54**. Antes, "IGNORAR E SEGUIR" sempre mandava o card pra AGUARDANDO CLIENTE — inclusive quando a última ocorrência era de **relacionamento ≠54** (ex.: oc **19, 49, 20, 11, 35, 10**), o que deixava o card preso e invisível (bug NF 1119469).

Agora:
- **oc = 54** (ou lag pós-lançamento de 54): comportamento atual — card volta pra **AGUARDANDO CLIENTE**.
- **oc de relacionamento ≠54** (ainda não lançada no SSW): o card **NÃO** vai pra AGUARDANDO CLIENTE. Ele sai da aba **CLIENTE RESPONDEU** (o sinal de resposta é limpo) mas **permanece em AGUARDANDO VOCÊ** (locked, com as propostas), porque a operadora ainda precisa **lançar a ocorrência de fato** pra tratar o caso.

## O que o backend agora retorna

A RPC `ignorar_pendencias_resposta_cliente` ganhou campos novos no retorno:

```json
{
  "ok": true,
  "card_id": "…",
  "state_novo": "AGUARDANDO_VALIDACAO_HUMANA", // ou "AGUARDANDO_CLIENTE"
  "lock_novo": true,                            // true quando ficou em AGUARDANDO VOCÊ
  "permaneceu_em_aguardando_voce": true,        // NOVO — true quando oc de relacionamento ≠54
  "cod_ultima_ocorrencia": 19                   // NOVO — última ocorrência do card
}
```

## O que fazer no front

No fluxo de sucesso do "IGNORAR E SEGUIR" (quando `ok === true`):

1. **Se `permaneceu_em_aguardando_voce === false`** (caso normal, oc=54/lag/out-of-escopo):
   - Comportamento atual: fecha o banner de pendências, toast de sucesso, o card sai da aba CLIENTE RESPONDEU / vai pra AGUARDANDO CLIENTE.

2. **Se `permaneceu_em_aguardando_voce === true`** (oc de relacionamento ≠54):
   - Fecha o banner de pendências (a pendência foi ignorada), mas mostrar um toast **de atenção** (cor de aviso, não erro):
     > **Pendências ignoradas.** O card continua em **AGUARDANDO VOCÊ** porque a ocorrência **{cod_ultima_ocorrencia}** ainda precisa ser lançada no SSW. Ignorar a resposta do cliente não trata a ocorrência — escolha uma das propostas do card para lançá-la.
   - **NÃO** remover o card da aba AGUARDANDO VOCÊ nem mandá-lo pra AGUARDANDO CLIENTE otimisticamente. Fazer refetch do card: ele sai de CLIENTE RESPONDEU mas continua em AGUARDANDO VOCÊ (locked, com propostas).

## Observação

Nenhuma mudança de tabela/coluna. A assinatura da RPC (`p_card_id`, `p_motivo`) **não muda** — é só ler os campos novos do retorno e ajustar toast + refetch. Nenhum outro fluxo muda.

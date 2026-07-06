# Lovable — Botão "Criar Card" (criação manual de card)

## Contexto
Nova função para criar um card na hora, manualmente, para uma NF que ainda não
venceu prazo (logo, ainda não apareceu pelo ciclo automático do Bastão). Use só em
situações específicas. O backend já está pronto: edge function `criar-card-manual`.
Ela entra no SSW, busca a NF pelo pagador, lê a última ocorrência e cria o card 100%
nas regras existentes. O front só coleta NF + pagador e trata a resposta.

## 1. Onde
Adicionar um botão **"Criar Card"** no topo do board do operador (ao lado dos filtros).
Ao clicar, abre um **modal** com: campo NF + busca de pagador (typeahead) + botão Criar.

## 2. Typeahead de pagador (só a carteira do operador)
O usuário digita as primeiras letras e aparecem os clientes. A tabela `clientes` já
tem RLS que filtra pela carteira do operador logado (gestor vê todos), então NÃO
precisa filtrar carteira no front — basta consultar como o usuário autenticado:

```ts
const { data } = await supabase
  .from('clientes')
  .select('cnpj_cpf, nome, segmento_nome')
  .eq('ativo', true)
  .ilike('nome', `%${termo}%`)
  .order('nome')
  .limit(20);
// item selecionado guarda: cnpj_cpf (vai como cnpj_pagador) e nome (vai como pagador_nome)
```
Debounce ~250ms. Mostrar `nome` (e opcionalmente `segmento_nome`). Exigir seleção de
um item da lista (não aceitar texto livre) antes de habilitar "Criar".

⚠️ **A fonte do typeahead TEM que ser a tabela `clientes`** (com a RLS de carteira), e
NÃO uma lista mais ampla (ex.: pagadores de cards antigos). Caso âncora real: um operador
conseguiu escolher "IMA EQUIPAMENTOS..." que **não está na carteira dele nem cadastrada em
`clientes`** → o backend recusou (cliente não atribuído) e dava erro. Se a busca vier de
`clientes`, só aparecem clientes válidos da carteira e o operador não escolhe quem não pode.

## 3. Chamada ao backend — IMPORTANTE: erro sempre claro
Use o **cliente Supabase autenticado** (o mesmo da sessão do operador). Se você criar um
client novo / anônimo, a sessão não vai junto e o backend devolve "sessão não reconhecida".

O backend **sempre responde HTTP 200** com `{ ok, resultado, mensagem }` — inclusive nos
erros tratados (fora da carteira, NF não achada, SSW fora do ar, etc.). Então **leia
`data`**, não dependa de `error`. A regra de ouro: **só `data.ok === true && data.resultado
=== 'created'` é sucesso. Qualquer outra coisa → mostrar `data.mensagem` e NÃO fechar/criar.**

```ts
const { data, error } = await supabase.functions.invoke('criar-card-manual', {
  body: {
    nf,                       // string, ex "684385"
    cnpj_pagador: cliente.cnpj_cpf,
    pagador_nome: cliente.nome,
    // ctrc_escolhido: só na 2ª chamada (ver passo 5)
  },
});

// Fallback p/ erro de borda (sessão ausente no gateway, crash) — NÃO mostrar o
// genérico "Edge Function returned a non-2xx status code". Ler a mensagem real:
if (error) {
  let msg = 'Não foi possível criar o card. Tente de novo.';
  try { const body = await error.context?.json?.(); if (body?.mensagem) msg = body.mensagem; } catch {}
  mostrarErro(msg);
  return;
}

if (data.ok && data.resultado === 'created') {
  toastSucesso('Card criado.');
  if (data.email_preexistente?.encontrou) toast(`Achei ${data.email_preexistente.candidatos} e-mail(s) desta NF.`);
  abrirCard(data.card_id);            // o banner "já tem tratativa" já vem preenchido
  return;
}
if (data.resultado === 'escolher_ctrc') { /* passo 5 */ return; }
if (data.resultado === 'card_ja_existe') { mostrarAviso(data.mensagem, data.card_id /* botão abrir */); return; }
// TODOS os outros resultados → mostrar a mensagem do backend, tal como veio:
mostrarErro(data.mensagem);
```

A chamada pode levar **alguns segundos** (consulta o SSW ao vivo + scan de e-mail):
mostrar spinner e **desabilitar o botão** durante a chamada (evita duplo-clique).

## 4. Resultados possíveis (todos vêm com `data.mensagem` em português)
| `resultado` | O que fazer |
|---|---|
| `created` | Sucesso. Abrir/atualizar o card por `data.card_id`. |
| `escolher_ctrc` | NF tem CTRC **normal** + **devolução**. Renderizar `data.opcoes` (`{ctrc, tipo, rotulo}`) como Normal vs Devolução; ao escolher, re-invocar com `ctrc_escolhido` (passo 5). |
| `card_ja_existe` | Mostrar `data.mensagem`; se `data.card_id`, botão "Abrir card existente". |
| `ultima_oc_nao_relacionamento` | Mostrar `data.mensagem` (contém a frase exata "NÃO FOI POSSÍVEL CRIAR POIS A ÚLTIMA OCORRÊNCIA NÃO É RELACIONAMENTO" + qual oc). |
| `fora_carteira` / `cliente_nao_atribuido` / `sessao_invalida` / `ssw_indisponivel` / `nf_nao_encontrada` / `sem_ctrc_ativo` / `ctrc_ambiguo` / `erro` | **Só mostrar `data.mensagem`** (já está clara e em português). Não precisa tratar cada uma — o `else` final cobre todas. |

> O front **não precisa conhecer cada `resultado`**: trate `created`, `escolher_ctrc` e
> `card_ja_existe`, e pra TODO o resto mostre `data.mensagem`. Assim qualquer motivo novo
> que o backend devolver já aparece claro pro operador, sem mudar o front.

## 5. Fluxo de escolha de CTRC (2 etapas)
1ª chamada sem `ctrc_escolhido` → se vier `escolher_ctrc`, o modal mostra as opções.
O operador escolhe Normal ou Devolução → **2ª chamada** idêntica + `ctrc_escolhido`.
A 2ª chamada conclui (`created`) ou repete `escolher_ctrc` se a situação mudou.

## 6. Exemplo de resposta `created`
```json
{ "ok": true, "resultado": "created", "card_id": "uuid",
  "nf": "684385", "ctrc": "AMB368633-7", "oc": 10, "assigned_operator_id": "uuid",
  "email_preexistente": { "encontrou": true, "candidatos": 2 } }
```
O card nasce em **AGUARDANDO VOCÊ** já com a sugestão de ação (ex.: notificar cliente
+ 54). O operador valida normalmente. Daqui pra frente o card é atualizado pelo Bastão
como qualquer outro (não precisa nada no front).

**E-mail pré-existente (síncrono):** o scan da caixa do operador roda **na hora da
criação** (não espera o cron de 2 min). Quando `email_preexistente.encontrou == true`,
o card já nasce com o banner `cards.email_preexistente_sugerido` preenchido (N threads
com NF no assunto + cliente). Ao abrir o card por `card_id`, renderizar esse banner
"já tem tratativa" com os candidatos e os botões **Seguir** (adotar a thread) / **Novo**
— via as RPCs já existentes `adotar_thread_preexistente(p_card_id, p_gmail_thread_id)` e
`descartar_email_preexistente(p_card_id)`. Pode usar `email_preexistente.candidatos` do
retorno pra um toast ("achei 2 e-mails relacionados a esta NF"). Se `encontrou == false`
ou `email_preexistente == null`, não mostrar banner.

## Observações
- Não expor service-role no front; tudo via `supabase.functions.invoke` autenticado.
- Mensagens de erro vêm prontas em `data.mensagem` — exibir como estão.
- O card criado é atribuído automaticamente ao operador dono do cliente (pela carteira),
  então pode aparecer no board de outro operador (ex.: gestor cria, cai pro Victor).

# Tela da Operação no Cockpit (front)

Front da fila da Operação (ADR 0041), em `apps/cockpit-web`. O backend (migs 430–433,
RPCs `op_*`, visão `op_v_fila`) está descrito no ADR; aqui está só o que a tela faz.

## Rotas e quem vê o quê

| Rota | Quem abre |
|---|---|
| `/operacao`, `/operacao/:itemId` | membro ativo da Operação (`operacao_membros`) ou gestor |
| todas as outras (Inbox, cards, extravios…) | quem está em `operadores` (Relacionamento) |

Decisão do dono: "Relacionamento não precisa aparecer para a Operação, nem vice-versa".

- Membro só da Operação que abre uma rota do Relacionamento é levado para `/operacao`.
  O header, o menu, o filtro por operador, o "agente chamando" e o feedback da 49 nem
  montam para ele. Nenhuma consulta nem canal Realtime de tabela do Relacionamento é aberto.
- Operador do Relacionamento (não gestor) que abre `/operacao` volta para o Inbox.
- Gestor vê os dois. O item "Operação" no menu só aparece com `flags.operacao_tela` ON.
  Com a tela OFF, o membro vê o aviso "A tela da Operação ainda está desligada" e o
  gestor continua vendo a fila (ADR 0041 D9).
- **Fail-open para o Relacionamento.** Se `op_minha_sessao` falhar (a mig 430 ainda não
  foi aplicada, por exemplo), ninguém vira "da Operação" e o Cockpit fica exatamente como
  está hoje.

O muro de dados é a RLS (migs 430/431). A tela só garante que ninguém veja a rota ou o
menu da outra área. A decisão é a função pura `decidirAreas` (`src/lib/operacao/areas.ts`).

## Três visões: Por problema | Por andamento | Lista

O seletor fica acima da fila e a escolha é lembrada no navegador. Os filtros valem nas três.
Dentro de cada coluna, o mais parado vem primeiro. Cada coluna tem contador e rolagem
própria e mostra 50 cartões por vez, com "ver mais": 300 cartões de uma vez travam a tela.

### Por problema (principal)

Com a fila real, quase tudo está "Nova", então o andamento não separa nada. A visão
principal agrupa pela **família do problema**: o que a Operação precisa fazer, derivado de
`cod_ultima_ocorrencia` (`src/lib/operacao/familias.ts`, tabela pura com teste). A
semântica foi conferida nas descrições do dicionário (migs 008/204) e na fila real.

| Família (ordem das colunas) | ocs | Próxima oc natural / regra |
|---|---|---|
| Pronta para entregar | 13, 15, 55, 21, 7, 36, 39 | 14 (saída para entrega), que nasce do romaneio |
| Necessita informação | 56 | 49 — devolve ao Relacionamento a informação que falta |
| Redespacho | 40 | **relógio de 2 dias**: o cartão mostra "oc 40 há N d · limite 2 d"; a partir de 2 dias sem movimento vira "Cobrar: N d sem movimento" (vermelho) |
| Agendamento | 29 | — |
| Comprovante retido | 12 | — |
| Informação | 41 | — |
| Em rota (passiva) | 14 | — (lançada pelo romaneio; vira trabalho só com a baixa do motorista) |
| Outros | 4, 5, 22, 24, 25, 27, 37, 38, 45, 48, 50, 51, 52 (de propósito; a coluna só aparece se tiver item) | — |

Famílias redefinidas pelo Caio em 08/10/2026 (dono do produto). "Entrega impossível"
não se aplica mais. A 14 é lançada automaticamente pelo romaneio e vai ao SSW
sozinha: ninguém da Operação age nela até a baixa do motorista chegar (aí a oc já é
outra e a nota cai no cockpit de alguém) — por isso "Em rota" é passiva. O andamento aparece
como selo no cartão: Nova, Assumida, Na fila, Lançada, Confirmada ou Erro.

**A 14 nunca é lançada no Cockpit** (Caio 08/10): está na lista de proibidas em todas as
cercas — `OCS_PROIBIDAS_OPERACAO` (TS), CHECKs de `op_codigos_lancaveis`/`op_lancamentos`
e `op_previa_lancamento` (mig 430), regras aprendidas (434/439/440), validador da IA
(435/439) e o prompt do agente (1.2.0). Só o romaneio gera 14.

**Filtro "Tipo CT-e"** (Caio 08/10): `op_itens.tipo_cte` = `Bastão.tipo_documento`
normalizado (NORMAL, DEVOLUCAO, REDESPACHO, REVERSA, SUBC FORM CTRC…). As opções vêm da
própria fila; entra no `snapshot_hash` do materializador.

### Por andamento (alternativa)


As colunas são só uma visão do estado
(`src/lib/operacao/kanban.ts`, mesmo molde do `KANBAN_COLUMNS` do Inbox, o primeiro
`match` ganha):

| Coluna | Quando |
|---|---|
| Nova | ninguém assumiu e não há lançamento |
| Assumida | alguém assumiu e não há lançamento ativo (pedido cancelado volta para cá) |
| Na fila do SSW | último lançamento `fila` ou `lancando` |
| Lançada | `lancado` (esperando a confirmação) |
| Confirmada | `confirmado` |
| Não confirmado / Erro | `nao_confirmado`, `erro` ou `recusado` (uma pessoa confere) |

O cartão mostra NF, CTRC, oc atual + descrição, unidade, tempo parado e a sugestão em
destaque. Tem duas ações: **Assumir** e **Aceitar sugestão**. Aceitar abre a MESMA prévia →
confirmação do detalhe (`useFluxoLancamento`): nenhum caminho lança sem a pessoa ver a
prévia. Clicar no cartão abre o detalhe ao lado.

## Sugestões (contrato v2 do ADR 0041 D10)

`op_itens.sugestao` é lido de forma tolerante (`src/lib/operacao/sugestao.ts`). Valem o
contrato v2 (`{versao_contrato:2, acao, fonte, base_regra, codigo|null, texto, motivo,
lancavel, confianca, casos, justificativa?, modelo?}`), o formato antigo da regra pura e o
do fixture (`casos: {n, m}`). A fonte aparece no rótulo:

- regra aprendida: "Sugestão: 36 — 82% (aprendida com a Sal: 41 de 50 casos parecidos)";
- agente de IA: "Sugestão: 22 — agente de IA: 72% — <justificativa>", com ícone de robô;
- regra fixa: "Sugestão: 15 — regra fixa".

Sem `fonte`, ela é deduzida: `base_regra`/`regra_id` `agente_ia` ou `modelo` indicam o agente;
confiança ou casos indicam regra aprendida; o resto é regra fixa.

Uma sugestão de **lançar** só vira botão quando o código está liberado e **não é a oc atual**.
A fila real de 07/10 trazia 71 das 110 sugestões repetindo a oc atual, o que o contrato
proíbe; a tela mostra essas como "Só registro: o código sugerido já é a oc atual". Na demo,
`lancavel` é recalculado contra a lista da demo, porque o arquivo foi gerado contra a
lista real, que está vazia.

## Encaminhar ao Relacionamento (D11)

- Quando a sugestão tem `acao = "encaminhar_relacionamento"`, o cartão e o detalhe mostram
  o botão **Encaminhar ao Relacionamento**. O detalhe também tem o encaminhamento manual,
  com o motivo escrito pela pessoa.
- O fluxo é sempre o mesmo: `op_previa_encaminhamento` → janela com destino, CTRC, NF e o
  **texto exato da 49** → `op_encaminhar_relacionamento` com o token. `op_aceitar_sugestao`
  nunca é usado para encaminhar, e o servidor recusa com `sugestao_e_encaminhamento`.
- Encaminhamento automático agendado (`op_v_fila.encaminhamento_*`): o cartão e o detalhe
  mostram "Encaminhamento agendado para HH:MM" com **Desfazer**
  (`op_desfazer_encaminhamento`).
- Depois de enviada, a nota sai da fila e some das colunas, porque a visão só traz item
  aberto. No detalhe, ela aparece só como evento ("Encaminhada ao Relacionamento") e com o
  status do pedido de `op_encaminhamentos_do_item`, nunca com o card.
- A sessão não expõe a flag `ponte_operacao_pedidos`. Com ela OFF, o botão aparece e o
  servidor responde `encaminhar_desligado`, que a tela traduz.

## Espelho do Relacionamento (D12, mig 438)

Decisão do dono: por enquanto, nada vai ao Relacionamento real. Com `op_encaminhar_modo()`
igual a `'espelho'` (o padrão):

- A prévia e a confirmação do encaminhamento mostram, em destaque, "Destino: ESPELHO do
  Relacionamento (não chega ao Cockpit real)". O texto da 49 aparece marcado como "não vai
  ao SSW", e o botão vira "Confirmar e enviar ao espelho". O front lê o modo de
  `previa.modo`; sem o campo (mig 436), trata como real.
- A resposta `status: 'espelhado'` gera o aviso "encaminhada ao espelho do Relacionamento
  às HH:MM. Nada foi ao Relacionamento real". O item fecha com `encaminhado_espelho` e, no
  detalhe, aparece só como evento ("Encaminhada ao espelho do Relacionamento").
- A página **/operacao/espelho**, "Espelho do Relacionamento", é só para o gestor e o
  `supervisor_op`. O link fica no topo da /operacao, e o servidor também barra com
  `sem_acesso_ao_espelho`. Ela lista `op_espelho_relacionamento_listar` com CTRC, NF, oc
  base, texto da 49, motivo, origem (manual/automático, regra/agente e confiança), quem e
  quando. Tem os botões **Teria aceitado** / **Teria recusado**, e a recusa exige motivo de
  pelo menos 5 caracteres (`op_espelho_relacionamento_avaliar`). Filtra por status
  (servidor) e por avaliação (tela). Os contadores são encaminhadas, avaliadas e % que teria
  aceitado entre as avaliadas.
- Na demo, o adaptador usa o modo `'espelho'` e implementa as duas RPCs em memória. Com os
  dados fictícios, ele já começa com 3 entradas no espelho (uma sem avaliação, uma que
  "teria aceitado" e uma que "teria recusado").

## Lançamento: sempre prévia, depois confirmação

1. A pessoa escolhe o código (lista de `op_codigos_disponiveis`) e escreve o texto.
   O texto é obrigatório (mín. 10) quando o código `exige_texto` (41/56).
2. **Ver prévia** chama `op_previa_lancamento`. A janela mostra exatamente CTRC, NF,
   código + descrição, oc atual, texto que vai na Instrução do SSW, conta SSW e unidade.
3. **Confirmar** chama `op_solicitar_lancamento` com o token da prévia. Se o servidor
   responder `previa_desatualizada`, a janela continua aberta com a prévia **nova** e
   pede outro clique.
4. **Aceitar sugestão** é 1 clique que abre a mesma prévia (com o código e o texto da
   sugestão). O confirmar chama `op_aceitar_sugestao` com o token.
5. Enquanto o pedido está `fila`, dá para **cancelar** (`op_cancelar_lancamento`).

Cada código de erro do ADR tem mensagem humana em `src/lib/operacao/erros.ts`. Um teste
compara a lista com o próprio ADR. Com a lista de códigos vazia, a tela diz "A Operação
ainda não liberou códigos para lançamento".

O relógio "parado há" mede desde `data_ultima_ocorrencia`. `materializado_em` e
`updated_at` são reescritos pelo materializador a cada rodada e não servem de relógio
(mesma lição do INV-151).

## Realtime

A fila e o item aberto escutam `op_itens` e `op_lancamentos` com `useRealtimeTable`.
**A mig 430 não coloca essas tabelas na publication `supabase_realtime`.** Até alguém
incluir as duas (TIPO B, pelo trilho), o Realtime não dispara. A tela também refaz a
leitura a cada 60 s para não congelar.

## Modo demonstração (sem banco)

Serve para ver e clicar na tela localmente, sem Supabase e sem SSW.

```bash
cd apps/cockpit-web
VITE_OPERACAO_DEMO=true npm run dev -- --port 5180 --host 127.0.0.1
# abrir http://127.0.0.1:5180/operacao
```

- O login é pulado. A pessoa é **Marina Duarte, supervisora da Operação** (fictícia),
  com `pode_lancar` e as três flags ON.
- O adaptador em memória (`src/lib/operacao/demo/`) tem 25 itens fictícios (bases
  VGA/POA/BHZ, ocs 13/14/15/21/36/37/56) e 5 códigos liberados (14, 15, 36, 37 e 56,
  que exige texto). Ele aplica as mesmas cercas da mig 430, na mesma ordem.
- Itens que mostram cada caso: `demo-item-02` tem sugestão aceitável; `demo-item-10` tem sugestão do agente de encaminhar; `demo-item-14` tem sugestão do agente de lançar a 22; `demo-item-24` tem encaminhamento automático agendado (dá para desfazer); `demo-item-03`
  tem pedido na fila (dá para cancelar); `demo-item-11` tem tratativa aberta no
  Relacionamento (a cerca recusa); `demo-item-22` está sem NF; `demo-item-24` está sem
  unidade.
- **Fila real opcional:** se existir `apps/cockpit-web/demo/fila-real.json` (array de
  linhas de `op_v_fila`, fora do git pelo `.gitignore`), a demo usa essas linhas no
  lugar das fictícias. As cercas, os códigos liberados e a supervisora continuam os da
  demo, e as unidades dela passam a ser as do arquivo. O cabeçalho da página avisa qual
  fonte está em uso. Arquivo inválido ou vazio cai nos fictícios, com aviso no console.
  Depois de criar ou trocar o arquivo, recarregue a página.
- Um "worker" falso leva o pedido de fila → lançando → lançado → confirmado em uns 17 s.
- Recarregar a página volta tudo ao estado inicial.
- O banner roxo no topo avisa que é demonstração; o cabeçalho da página diz se os dados são fictícios ou a fila real do arquivo.

**Por que isso não vai para a produção:** o modo só liga com `import.meta.env.DEV`
(`vite dev`) **e** `VITE_OPERACAO_DEMO=true`. O adaptador é importado só por
`carregarOpApi.ts`, por `import()` dinâmico atrás dessa condição. No `vite build`, `DEV`
vira `false` literal, o ramo morre e o chunk do adaptador nem é gerado. Conferido em
`dist/`: nenhum arquivo com `adaptadorDemo`, `demo-item-`, `Marina Duarte`,
`DEMONSTRAÇÃO DA OPERAÇÃO` ou `127.0.0.1:9`. (O aviso de origem da página, que só aparece
com a OpApi demo, é o único texto da demo que fica no bundle.) O teste `src/lib/operacao/demoIsolamento.test.ts` trava isso. Na demo,
o client do Supabase aponta para `http://127.0.0.1:9` mesmo que exista `.env.local` com
o projeto real.

## Demonstração no site do roteirizador v3 (`--mode demo-v3`)

`npx vite build --mode demo-v3` gera a tela com `base: "/operacao-cockpit/"`, para o site
do v3 servir em `https://<v3>/operacao-cockpit/` (o script `scripts/atualizar-operacao-cockpit.sh`
do repo do roteirizador rebuilda e copia). Nesse modo:

- o adaptador em memória continua dono das ações (assumir, lançar, encaminhar ao espelho):
  nada vai ao SSW nem ao Relacionamento, e a faixa do topo diz "Dados reais do SSW (só
  leitura) · nada é lançado no SSW nem enviado ao Relacionamento";
- a fila **não vem no bundle**: `demo/filaDoV3.ts` lê o endereço da API em
  `/operacao-cockpit-config` (rota do site do v3) e chama `GET /v3/cockpit-demo/fila` com o
  token de sessão do v3 (`localStorage["ri_token"]`, a mesma origem). A API calcula a fila ao
  vivo, só leitura, do legado;
- sem sessão do v3 (ou com sessão de motorista, ou 401/403 da API), `PortaoDemoV3` mostra
  "Entre no roteirizador primeiro" com o link `/login?voltar=/operacao-cockpit/`;
- API fora ou fila vazia: os fictícios, com o porquê no cabeçalho;
- o router usa `basename` = `BASE_URL`; o client do Supabase aponta para o endereço morto, como
  na demo local;
- o arquivo local `demo/fila-real.json` só é lido por `demo/fixtureLocal.ts`, que só o ramo do
  `vite dev` importa: o build demo-v3 não o alcança (o script do v3 confere que nenhum CTRC
  dele está no bundle, e `demoIsolamento.test.ts` trava os imports).

A sugestão "aguardar" (mig 439) aparece como "Aguardar: motivo · reavaliar em HH:MM", sem
botão, nos cartões, no detalhe e no chip.

## Arquivos

- `src/pages/operacao/Operacao.tsx`: a página (fila, filtros, resumo, detalhe ao lado).
- `src/components/operacao/`: kanban, lista, filtros, chips, detalhe, janela de
  confirmação e `useFluxoLancamento` (o fluxo único prévia → confirmação).
- `src/lib/operacao/`: tipos do contrato, `OpApi` (real e demo), filtros e ordenação
  puros, áreas e mensagens de erro.
- `src/contexts/OperacaoContext.tsx`: `OpApiProvider`, `useOpSessao`, `useAreas`.
- `src/components/auth/AreaGuard.tsx`: `SoRelacionamento` e `SoOperacao`.

## Testes

```bash
cd apps/cockpit-web
npx vitest run src/lib/operacao src/pages/operacao src/components/auth
npm run typecheck && npm run build
```

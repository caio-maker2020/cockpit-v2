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
- Itens que mostram cada caso: `demo-item-02` tem sugestão aceitável; `demo-item-03`
  tem pedido na fila (dá para cancelar); `demo-item-11` tem tratativa aberta no
  Relacionamento (a cerca recusa); `demo-item-22` está sem NF; `demo-item-24` está sem
  unidade.
- Um "worker" falso leva o pedido de fila → lançando → lançado → confirmado em uns 17 s.
- Recarregar a página volta tudo ao estado inicial.
- O banner roxo no topo avisa que são dados fictícios.

**Por que isso não vai para a produção:** o modo só liga com `import.meta.env.DEV`
(`vite dev`) **e** `VITE_OPERACAO_DEMO=true`. O adaptador é importado só por
`carregarOpApi.ts`, por `import()` dinâmico atrás dessa condição. No `vite build`, `DEV`
vira `false` literal, o ramo morre e o chunk do adaptador nem é gerado. Conferido em
`dist/`: nenhum arquivo com `adaptadorDemo`, `demo-item-`, `DEMONSTRAÇÃO DA OPERAÇÃO`
ou `127.0.0.1:9`. O teste `src/lib/operacao/demoIsolamento.test.ts` trava isso. Na demo,
o client do Supabase aponta para `http://127.0.0.1:9` mesmo que exista `.env.local` com
o projeto real.

## Arquivos

- `src/pages/operacao/Operacao.tsx`: a página (fila, filtros, resumo, detalhe ao lado).
- `src/components/operacao/`: lista, filtros, chips, detalhe e janela de confirmação.
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

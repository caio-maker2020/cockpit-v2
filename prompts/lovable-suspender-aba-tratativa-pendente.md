# Lovable — Suspender aba "TRATATIVA PENDENTE"

## Contexto

O state `TRATATIVA_PENDENTE` foi **suspenso no back** (Caio 2026-05-12). A regra antiga "cliente cobra sobre card RESOLVIDO/TRANSFERIDO → reabre como TRATATIVA_PENDENTE" foi desativada. Agora vale a regra única:

> **Bastão tem oc de relacionamento → card automaticamente vai pro state final correto (AGUARDANDO VOCÊ / PARA FAZER / AGUARDANDO CLIENTE / RESOLVIDO).**

Cliente cobrar via email **não muda mais o state** do card. Se o Bastão devolver a NF como pendência de relacionamento, o sync reabre no state certo automaticamente.

Backend já está travado:
- `vinculador`: bloqueado o UPDATE pra TRATATIVA_PENDENTE
- `regras-auto-acao` (combo extravio 6/9/16): vai pra AGUARDANDO_VALIDACAO_HUMANA + lock (= aba AGUARDANDO VOCÊ)
- `sync-bastao voltouParaRelacionamento`: cards legados em TRATATIVA_PENDENTE são liberados automaticamente

**Hoje há 0 cards em TRATATIVA_PENDENTE. Pode esconder a aba sem risco.**

## O que fazer no front

### 1. Remover a aba "TRATATIVA PENDENTE" da navegação principal

Procurar no código onde as abas do Cockpit são definidas. Padrão esperado: um array de tabs ou um objeto com configs. Algo como:

```ts
const TABS = [
  { key: 'para_fazer', label: 'PARA FAZER', state: 'AGUARDANDO_AGENTE' },
  { key: 'aguardando_voce', label: 'AGUARDANDO VOCÊ', state: 'AGUARDANDO_VALIDACAO_HUMANA' },
  { key: 'cliente_respondeu', label: 'CLIENTE RESPONDEU', ... },
  { key: 'aguardando_cliente', label: 'AGUARDANDO CLIENTE', state: 'AGUARDANDO_CLIENTE' },
  { key: 'tratativa_pendente', label: 'TRATATIVA PENDENTE', state: 'TRATATIVA_PENDENTE' }, // ← REMOVER
  ...
];
```

**Remover** a entrada com `state: 'TRATATIVA_PENDENTE'` (ou label "TRATATIVA PENDENTE").

### 2. Conferir filtros e queries

Buscar referências à string literal `'TRATATIVA_PENDENTE'` em:
- Componentes de listagem de cards (filtros `.eq('state', 'TRATATIVA_PENDENTE')` ou `.in('state', [..., 'TRATATIVA_PENDENTE'])`)
- Badges/labels de status no card
- Painéis de métricas/contadores

**Manter** se for usado apenas como label visual no detalhe do card (caso surja um legado). **Remover** se for filtro de aba/contador.

### 3. Tratamento de cards "órfãos" (defesa)

Se por algum motivo aparecer um card em `state='TRATATIVA_PENDENTE'` (não deve acontecer mas é defesa):
- **Não criar uma aba fantasma só pra ele.** Pode renderizar dentro da aba "PARA FAZER" com badge cinza "Estado legado — aguardando sync".
- O sync-bastao vai mover ele pro state correto no próximo ciclo (≤2min).

### 4. NÃO remover do schema/types

A constante `TRATATIVA_PENDENTE` continua valendo no DB e nos tipos TypeScript (ainda existe no CHECK constraint da tabela `cards`). Só não é mais usado como destino de transição. Manter no enum/union types pra retrocompatibilidade.

## Resultado esperado

- Aba TRATATIVA PENDENTE some da navegação.
- Larissa vê só: PARA FAZER, AGUARDANDO VOCÊ, CLIENTE RESPONDEU, AGUARDANDO CLIENTE (+ as outras que já existem).
- Zero quebra: cards em outros states continuam aparecendo normalmente.

## Reativação futura

Se algum dia o Caio decidir reativar, é só (1) re-adicionar a aba aqui e (2) reativar o UPDATE no `vinculador/index.ts:367-394` e `_shared/regras-auto-acao.ts:537-541`. Histórico está commitado em `9a4fb58`.

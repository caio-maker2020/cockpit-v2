# Tela do Relacionamento no padrão da torre (front)

Redesign do Inbox do Relacionamento (`apps/cockpit-web`) no mesmo padrão da tela da Operação
(`docs/OPERACAO-TELA.md`). É **redesign, não reescrita de regra**: as colunas, o "primeiro
match ganha" do `KANBAN_COLUMNS`, a ordenação de cada coluna, as queries, o realtime, o
trilho autônomo (piloto) e todos os filtros do Inbox continuam os mesmos. Nada de banco,
edge function, migration ou RLS mudou. Relacionamento e Operação continuam sem se enxergar.

## Personas

Não havia documento de personas; estas saem do PRD (seção 4), do CLAUDE.md ("operador valida,
não executa") e das decisões do Caio registradas no código.

| Persona | Quem é | O que a tela faz por ela |
|---|---|---|
| **Operadora de carteira** (~10, papel `operador`) | Cuida dos cards dela ("Meus cards"). Valida a ação que o agente propõe; não executa à mão. | Abre na aba **Trabalho**, em "Meus cards", começando por **Aguardando você** (Aguardando você + Cliente respondeu). |
| **Operadora do piloto do trilho autônomo** (Felipe, Isabely, Larissa) | Vigia o que o robô vai fazer sozinho e veta quando precisa. | A etapa **Trilho autônomo** aparece na barra e no quadro, com a contagem regressiva no cartão. |
| **Gestor** (Caio, papel `gestor`) | Acompanha todo mundo, calibra regras, lê a torre. | Dono "Todos", filtro por operador do cabeçalho, aba **Torre** com especialistas, certeza das sugestões e conselheiro. |

**Fluxo principal da operadora:** abre o Inbox → aba Trabalho, "Meus cards" → `j` percorre os
cards de **Aguardando você** (o selecionado ganha contorno) → `Enter` abre o card → valida ou
recusa como sempre → `j`/`k` (ou as setas "3 de 12" no topo do card) vão para o próximo card da
mesma fila, sem voltar ao Inbox.

**Fluxo do gestor:** Torre → onde está o volume (especialistas por tipo de caso), quantas
sugestões com certeza baixa, avisos do conselheiro → Trabalho com dono "Todos".

## A tela

Uma única barra de topo (≤ 56 px): abas **Trabalho | Torre** (sempre abre no Trabalho); as etapas do fluxo com
contagem (são a navegação das colunas: clicar leva à coluna); "N cards ativos"; **dono**
(Meus cards / Sem dono / Todos, este só para gestor); busca; **Filtros** (popover; painel de
baixo no celular) com cliente, risco, ocorrências (várias, com busca), tipo de caso e CT-e;
e o **⋯** com a Visão geral dos clientes (link do Caio, 18/09) e a ajuda dos atalhos. Os
cartões vêm logo abaixo. Nada saiu do produto: o que estava no topo mudou de lugar.

### Etapas do fluxo (`ETAPAS_REL`, `src/lib/relacionamento/torre.ts`)

| Etapa | Colunas do kanban (regras de sempre) |
|---|---|
| Aguardando você (dúvida) | Aguardando você, Cliente respondeu |
| Trilho autônomo (regra firme) | Ação autônoma, Autônoma executada (só piloto/gestor ou quando há card) |
| Para fazer | Para fazer |
| Aguardando cliente | Aguardando cliente |
| Ação executada / Ação confirmada | Ação executada, Ação confirmada |

Nada some (Caio): toda coluna aparece, e a vazia mostra o recado de sempre. O agrupamento e a ordenação saíram do Inbox para `agruparInbox` sem mudança (teste
em `torre.test.ts`).

### Torre

Saudação e resumo do turno, os 4 números de antes (ativos, resolvidos hoje, aguardando SSW,
risco alto), **regras** (firme = robô vai agir; dúvida = você valida) com a **certeza das
sugestões do agente** em palavras (alta ≥ 85%, média ≥ 65%, baixa; nunca porcentagem),
**especialistas** por tipo de caso, **conselheiro** (ação que não executou, cards parados há
mais de 1 dia útil, possível resposta em outra conversa, ocorrência alterada, risco alto, sem
chave do CT-e) e o **registro do turno**.

O conselheiro no **cartão** são os próprios sinais que o card já mostrava, com o teto de 2
sinais da des-poluição do Caio (26/08). O cartão (KanbanCard) e o card aberto (CardDetail)
ficam exatamente como no Cockpit oficial: títulos, textos e campos não mudam.

### Atalhos

| Tecla | Onde | Faz |
|---|---|---|
| `j` / `k` | Trabalho | próximo / anterior card, na ordem das colunas |
| `Enter` | Trabalho | abre o card selecionado (ou o primeiro) |
| `Esc` | Trabalho | solta a seleção |
| `j` / `k` | card aberto | próximo / anterior card da mesma fila (a ordem vai no sessionStorage) |
| `c` | prévia da demonstração | confirma |

Nunca disparam dentro de campo de texto nem com janela aberta. No card real, a aprovação
continua sendo a do painel de decisão de hoje (não mudou); depois de aprovar, `j` leva ao
próximo card.

## Demonstração (`vite build --mode demo-rel`)

Servida pelo site do roteirizador em `/relacionamento-cockpit/`, com banner "Demonstração ·
dados fictícios". Dados **fictícios** em memória (`lib/relacionamento/demo/dadosDemoRel.ts`):
nenhuma leitura nem escrita no Cockpit real; o client do Supabase aponta para endereço morto
nesse modo e o cartão não consulta nada. A página da demo entra só por import dinâmico atrás
de `MODE === "demo-rel"` (literal): no build de produção o ramo e os dados somem (teste em
`torre.test.ts`). Na demo, o card abre num painel ao lado (o card real precisa do banco):
aprovar → prévia → `c` confirma → o card vai para "Ação executada" e abre o próximo.

## Arquivos

- `src/pages/Inbox.tsx` — queries de sempre; renderiza `TelaRelacionamento`.
- `src/components/relacionamento/` — `TelaRelacionamento` (abas, colunas, torre),
  `BarraRelacionamento` (barra e filtros), `NavegacaoCards` (próximo/anterior no card).
- `src/lib/relacionamento/torre.ts` (+ teste) — agrupamento, etapas, torre.
- `src/components/cards/KanbanCard.tsx` — o do master; só ganhou `onAbrir` (a demo abre num
  painel) e não consulta o banco na demonstração.
- `src/pages/relacionamento/DemoRelacionamento.tsx` e `src/lib/relacionamento/demo/` — só demo.

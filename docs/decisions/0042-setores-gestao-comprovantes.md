# ADR 0042 — Setores do Pendências, Gestão e Comprovantes no Cockpit de Operação

Data: 2026-10-08
Status: proposto (branch `op/pendencias-setores`, integrada na `matheuscastro12-eng/operacao-e-motorista`, PR #41 em rascunho).
As migrations 417–440 já estão aplicadas no Cockpit, segundo leitura do coordenador em 08/10 (com
`operacao_membros` vazia). As migrations **441** e **442** existem só como arquivo: nada foi aplicado no banco, nada publicado
como edge, nenhuma flag ligada.
Estende: 0041. Fonte das regras: o Pendências (`tatiana-kelly/pendency-tracker` @a884368). O mapa
completo, com `arquivo:linha`, está em `docs/PENDENCIAS-REGRAS.md`.

## Contexto

O dono pediu (08/10) que a Operação herde do Pendências três coisas: os setores e os perfis
(o que cada setor faz e por quais ocorrências responde), a Gestão e os Comprovantes. Do
Pendências vieram as regras e o propósito de cada tela. O visual não foi copiado.

## Decisão

### D1 — Setores e o setor dono de cada código (mig 441)

- `op_setores` tem 7 setores: Operação, Agendamento, Devolução, Ressarcimento, Perdas, Cliente e
  Relacionamento. `op_setor_por_oc` recebe o mapa do Pendências (60 códigos), com a fonte citada
  em cada linha.
- `op_setor_do_item(responsavel_atual, oc)` decide o setor da nota. O `responsavel_atual`
  conhecido manda; se não houver, vale o mapa pela oc; se a oc não estiver no mapa, o resultado é
  `NAO_IDENTIFICADO`. Essa nota não é descartada: o operador não a vê, mas supervisão, gerente e
  gestor veem, e a Gestão mostra a contagem.
- A `op_v_fila` ganha a coluna `setor` no fim. O front tem um espelho puro
  (`lib/operacao/setores.ts`), e o teste `operacao-setores.test.ts` confere que o espelho e a
  semente da 441 dizem a mesma coisa.
- **Entrada na fila:** pelos setores com `na_fila = true`. A semente liga **só a Operação**, e o
  materializador sai byte a byte igual ao de hoje. Ligar outro setor é migration TIPO B do dono.
  O Relacionamento é proibido por CHECK, porque a separação do 0041 D2 continua valendo.

### D2 — Perfis por setor (mig 441)

| Papel | Pendências | Vê |
|---|---|---|
| `operador_op` | `usuario_setor` | as suas unidades **e** os seus setores (`operacao_membros.setores`, padrão `{OPERACAO}`) |
| `gerente_op` (novo) | `gerente_filial` | as suas unidades, todos os setores; abre a Gestão |
| `supervisor_op` | admin/diretor/head (na Operação) | tudo; abre a Gestão |
| gestor do Cockpit | — | tudo (como no 0041) |

- **RLS:** uma policy RESTRICTIVE `opi_setor_do_membro` em `op_itens`. As tabelas de eventos,
  lançamentos e encaminhamentos herdam a regra pelo `EXISTS` em `op_itens`.
- **Triggers:** barram o `operador_op` de assumir, lançar ou encaminhar nota de outro setor
  (`fora_do_seu_setor`, com mensagem humana na tela).
- **Limite conhecido:** as RPCs da 430/436 testam `papel_op <> 'supervisor_op'`, então o
  `gerente_op` ainda não força assumir nem cancela lançamento de outra pessoa (age como operador
  nas unidades dele). Se o gerente precisar disso, as RPCs mudam numa mig própria.
- **A fila troca de fonte com a 441:** o materializador passa a usar os códigos de
  `op_setor_por_oc` (mapa do Pendências) no lugar de `ocorrencias_dicionario` = 'Operação'. Antes
  de aplicar, o time roda (leitura) o diff entre as duas fontes e registra aqui; a oc 57 é a
  divergência conhecida. Responsável preenchido e desconhecido (ex.: `indenizacao`) continua
  fora, como no `ehDaOperacao` antigo.
- **Furo conhecido (P2):** `op_item_detalhe` e `op_encaminhamentos_do_item` ainda olham só a
  unidade. Para ler, a pessoa precisaria do uuid, e a fila não o entrega para nota de outro setor.

### D3 — Setor de cada membro (mig 442)

- Os membros já existem: em 08/10 foram cadastradas 90 linhas em `operacao_membros`, vindas do
  Pendências. São 67 `operador_op` e 23 `supervisor_op`, sem setor.
- A 441 dá a todos `setores = {OPERACAO}`.
- A 442 (gerada por `scripts/gerar-semente-membros-operacao.ts` a partir da planilha de setores
  do Pendências) **não insere ninguém**. Ela casa pelo e-mail e só acerta `setores`, além de
  passar `gerente_filial` para `gerente_op`.
- Quem não casa fica `pendente` em `op_membros_semente`. Nenhum login é criado.
- A 442 já está preenchida a partir do export do Pendências (commit 889638f); continua só arquivo.

### D4 — Barra e abas

- As abas são Trabalho | Gestão | Comprovantes | Torre. A Gestão só aparece para supervisão,
  gerente e gestor.
- O filtro **Setor** fica na barra, ao lado da Filial. O operador abre em "Meus"; os outros
  abrem em "Todos".
- As etapas do fluxo só aparecem em Trabalho e Torre.

### D5 — Gestão

- É só leitura e segue o fluxo da torre: o agente leu → regras firmes ou dúvida → especialistas
  por setor → conselheiro → você confirma.
- Logo abaixo vem um único bloco, "Comece por aqui": os gargalos por filial × setor, cada um com
  uma ação ("Abrir a mais antiga" e "Ver na fila").
- O resto fica recolhido: cargas críticas, faixas de carga parada, setor × filial, atraso,
  regional, ocorrências, produtividade e os indicadores de estoque.
- Regras usadas (`lib/operacao/regua.ts` e `lib/operacao/gestao.ts`):
  - carga parada em dias úteis, com feriados nacionais;
  - crítica com mais de 5 dias;
  - prazo de cada setor pela `sla_setores`;
  - a exportação de carga parada.
- "Baixar carga parada (CSV)" só baixa o arquivo no navegador.
- Os 3 indicadores de ciclo do Pendências precisam de histórico, que o Cockpit não tem. Por
  isso aparecem só as versões de estoque, com esse nome.

### D6 — Comprovantes

- Como no Pendências, a tela é **só leitura**. Ela mostra uma lista de trabalho por base, da mais
  urgente para a menos urgente, com faixas Em dia, Atrasada, Crítica e Vencida.
- Cada base tem uma ação, "Baixar cobrança da base", que gera um CSV. As notas reais da fila com
  oc 12 (comprovante retido) têm "Abrir na fila".
- Lançar no SSW só pelo fluxo que já existe: prévia, clique humano, fila `ai.salex`, INV-159,
  nada em lote.
- **A fonte ainda não existe no Cockpit.** No Pendências ela vem das views de outro projeto
  Supabase. Na demonstração, a tela usa 60 comprovantes fictícios e as notas reais com oc 12,
  ligados pelo adaptador de demonstração (`OpApi.comprovantesDemo`).

### D7 — Demonstração

- No `demo-v3`, Gestão e Comprovantes usam a fila real do v3, só leitura; Comprovantes também usa
  os fictícios. Nada é gravado fora do navegador.
- A persona da demonstração continua a supervisora fictícia, agora com `setores = {OPERACAO}`.
  Ainda não há membros reais (D3).

## Decisões para o Matheus

- **D-1 (respondida em 08/10):** o Bastão **é** o projeto Supabase do Pendências. O ref de
  `BASTAO_SUPABASE_URL`/`BASTAO_PROJECT_REF` no `.env.local` do cockpit-v2 é o mesmo do
  `supabase/config.toml` do Pendências. Os membros (`user_roles`, `user_sectors`,
  `user_branches`) moram lá, e o Cockpit não os lê. Resta saber se `indenizacao` (mig 029) deve
  virar Ressarcimento.
- **D-2:** quem é o dono do mapa oc → setor daqui em diante? O Cockpit guarda uma cópia
  congelada em a884368, e o Pendências muda a dele sem migration (a 60 mudou assim). E a **oc 57**:
  o dicionário do Cockpit (mig 204) a põe no Relacionamento, o Pendências na Operação. A 441 segue
  o Pendências, então a oc 57 com `responsavel_atual` vazio passa a entrar na fila da Operação.
- **D-3 (respondida em 09/10, pelo código — ver D8):** fonte = views do projeto `fsswfealkyavtjfaleil`
  lidas pela edge `comprovantes-operacao`; a tela continua só leitura, com "Cobrar base" (copiar texto + CSV).
- **D-4:** que setores entram na fila além da Operação (`na_fila`)? E encaminhar para um setor
  da Operação (Devolução, por exemplo), não só para o Relacionamento?
- **D-5 (respondida em 09/10, ver D8 — vale o que o código executa):** regras em que o próprio Pendências diverge (detalhe no `PENDENCIAS-REGRAS.md`):
  - carga parada: o mínimo é 1 dia útil no código e 2 no texto de ajuda;
  - faixas de idade dos comprovantes: a ajuda e os gráficos usam faixas diferentes;
  - tolerância de "estável": 2% num lugar, 0,5% no outro;
  - Agendamento não tem linha na `sla_setores`;
  - indicador de 7 dias: `>= 7` num lugar, `> 7` no outro.

## D8 — Revisão v2 (09/10/2026): recriar pelo código do Pendências

Mapa feito no código de `tatiana-kelly/pendency-tracker` @a884368. Regra escolhida = a que o código executa.

**Comprovantes**
- Fonte real: projeto Supabase `fsswfealkyavtjfaleil`, views `vw_pendencias_comprovante_entrega`
  (lista; 268 linhas em 09/10) e `vw_comprovantes_entregues` (só contagem; 679.720), lidas no Pendências com a
  chave anon fixa no front (`src/integrations/supabase-comprovantes/client.ts:5-14`). Nenhum SQL dessas
  views nem o ETL que as alimenta está no repo do Pendências.
- No Cockpit: edge `comprovantes-operacao` (GET, JWT obrigatório, `op_minha_sessao`, nunca service_role).
  Supervisor/gestor veem tudo; operador e `gerente_op` só as suas unidades (filtro em `unidade_receptora`
  na fonte e de novo na volta); membro sem unidade recebe lista vazia. Lógica em
  `supabase/functions/_shared/operacao-comprovantes.ts`.
- Secrets que faltam (não configurados): `COMPROVANTES_SUPABASE_URL`, `COMPROVANTES_SUPABASE_ANON_KEY`.
  Sem eles a edge responde 503 `comprovantes_sem_credencial` e a tela diz isso (sem dado fictício no modo real).
  A chave já é pública no front do Pendências; a proteção real é o JWT + filtro por unidade do nosso lado.
- Corrigido em relação ao Pendências: paginação com `order`; exclusões (CTRC OVD352980-1 e ocorrência com
  RESSARCIMENTO) feitas na edge sem perder linhas com descrição nula; datas `YYYY-MM-DD` no fuso de São Paulo
  (o Pendências mostra um dia antes); restrição por base no servidor (no Pendências é só no navegador).
- Faixas = as executadas pelo gráfico do Pendências: 0-5, 6-10, 11-30, 31-60, 61-90, 91-150, 151+
  (as 4 faixas do texto de ajuda nunca rodam). Mediana de idade em vez de média.
- % de pendência = pendentes / (pendentes + entregues) — aproximação: as exclusões só saem do numerador.
  Com filial específica escolhida, o % vira "—" (a contagem de entregues cobre as unidades do membro).
- Ação: o Pendências só exporta; a cobrança é manual. Aqui: "Cobrar base" (confirmação → copia texto pronto +
  CSV da base) e "Exportar tudo". Sem WhatsApp (não há número por base), sem gravação no SSW.
- Cortado: variação mês a mês ("Situação por base" no Pendências compara acumulado com ele mesmo e nunca
  mostra "melhorando"), ranking global de placas, listas por cliente.

**Gestão** (tudo calculado da fila que o Cockpit já tem, `op_v_fila`)
- "Exportar carga parada": regra do código (1+ dia, não os 2+ da ajuda) em `lib/operacao/cargaParada.ts`:
  dev/rev só com última oc 2; demais CT-e NORMAL com previsão vencida; oc 40 ≥ 3 dias úteis; 51/52/58/56 ≥ 1
  ("Informação faltante - resolver rápido"); pré-entrega ≥ 1. CSV único com coluna Base, com confirmação.
- "Pré-entregas obrigatórias": previsão ≤ próximo **dia útil** (o Pendências usa dia corrido: sexta → sábado).
- Painel regional com o mapa `src/lib/regionais.ts` do Pendências; nota sem regional aparece como "Sem regional".
- Divergências conhecidas: base vem do código da filial, não da base de destino; grupo por lista fixa de oc,
  não pela tabela `status_registros`; CSV único, não XLSX por aba.
- Histórico (Evolução Diária, indicadores `meta_ciclo_dia`, `historico_carga_parada_diario`): a chave anon do
  Bastão recebe 0 linhas (RLS). **Não** se adiciona service_role do Bastão ao Cockpit; a tela diz que o
  histórico não está disponível. Para trazer: pedir ao Pendências uma policy/view de leitura.
- Fora: Controle Pré-Entrega (aba inacessível no Pendências) — sem migration nesta revisão.

**Segurança no Pendências (avisar Tatiana/Kelly, fora deste PR):** `pendencias-alerta-atraso` envia e-mail
da conta Gmail para qualquer endereço sem login (`verify_jwt=false`, `?mode=test-send&to=`);
`snapshot-carga-parada-diario` regrava o dia sem login; tabelas com `USING(true)` expõem outras bases.

# Regras do Pendências aplicadas ao Cockpit de Operação

Fonte: `tatiana-kelly/pendency-tracker` (o "Pendências"), commit **a884368** (07/10/2026), lido
em 08/10/2026 só como texto (nada foi instalado, compilado ou executado). Todo `arquivo:linha`
abaixo é desse commit. Decisão e implementação no Cockpit: **ADR 0042**.

Do Pendências vieram **as regras e o propósito de cada tela**. O visual não foi copiado: as abas
novas usam o padrão da tela da Operação (barra única, cartões, linguagem de operador).

## 1. Setores e os códigos de ocorrência de cada um

| Setor | Responde pelas ocorrências | Fonte |
|---|---|---|
| Operação | 1, 2, 4, 5, 7, 12, 13, 14, 15, 21, 22, 24, 25, 27, 29, 32, 34, 36, 37, 38, 39, 40, 41, 45, 48, 50, 51, 52, 55, 56, 57 | `src/types/pendencia.ts:64-70` |
| Perdas | 6, 9, 16 | `:72` |
| Relacionamento | 3, 8, 10, 11, 17, 19, 20, 23, 26, 28, 35, 43, 49 | `:74-77` |
| Agendamento | 31 | `:79` |
| Ressarcimento | 18, 33, 42, 46, 47 | `:81` |
| Devolução | 30, 44, 53, 58 | `:83` |
| Cliente | 54, 59, 60 | `:85` (a 60 virou Cliente por decisão da gestão, Sara, 24/09/2026: `:84`) |

- O mesmo mapa está no ETL: `etl/notas-ciclo/src/setores.js:44-58`. Desde 24/09/2026 a fonte de
  verdade é a tabela `ocorrencias_setores` (`setores.js:10-14`), criada em
  `supabase/migrations/20260122182257_*.sql:2-9`. Quando banco e arquivo divergem, a divergência
  é listada, nunca resolvida em silêncio (`criarMapaSetores`, `setores.js:101-120`).
- **A hierarquia:** o `responsavel_atual` do registro manda. Se estiver vazio, vale o mapa pelo
  código. Código fora do mapa vira `NAO_IDENTIFICADO` na régua nova (`setores.js:35`, `:74`) e
  OPERACAO no front antigo (`pendencia.ts:88-90`).
- **52:** foi para Relacionamento (`20251211142947_*.sql:54-56`) e voltou para Operação
  (`20260615150051_*.sql:21-28`).
- **Furos no próprio Pendências** (não copiados):
  - A semente de `ocorrencias_setores` (`20260122182257_*.sql:42-106`) ainda põe 31, 52 e 58 em
    Relacionamento e não tem 59 nem 60. A 60 mudou direto no banco, sem migration.
  - A função SQL `get_responsavel_from_ocorrencia` (`20260615150051_*.sql:1-17`) está
    desatualizada: 31/58 em Relacionamento, sem 59/60, sem Agendamento.
  - O Cockpit segue o mapa do front e do ETL, que concordam entre si.

## 2. Perfis, papéis e permissões

| Pendências | Regra | Fonte |
|---|---|---|
| `admin`, `diretor`, `head` | veem tudo (`is_admin_or_higher`) | `20251211031335_*.sql:5`, `:148-159` |
| `gerente_filial` | todos os setores, recortado pelas filiais dele; abre Gestão | `20251215144856_*.sql:2`; `AuthContext.tsx:312-323` |
| `usuario_setor` (padrão do cadastro) | só os setores dele (`user_sectors`) e as bases/filiais dele | `20251215144917_*.sql:67`; `20260108192030_*.sql:78-88` |
| `acesso_total` (flag do perfil) | vê tudo | `20260616214910_*.sql:30-68` |
| Lista vazia | sem restrição naquela dimensão | `20260526123602_*.sql:1-39` |

- A RLS de `pendencias` (`20260616214910_*.sql:30-68`) exige base + setor + responsável de
  relacionamento + logística ao mesmo tempo. Para REVERSA/DEVOLUÇÃO, a base é a operacional
  atual. Para o resto, é a base de destino (`:3-21`).
- Rotas: Gestão, Tempo por Setor, Visão Executiva, Agendamento, Eficiência e Reversa são só para
  admin, diretor, head e gerente_filial (`src/App.tsx:96-160`). Comprovantes só pede login
  (`:166-172`), com o recorte pelas bases da pessoa.
- `AuthContext.tsx:375` deixa um e-mail fixo no código passar por qualquer módulo. Não foi
  copiado.

## 3. Status, prazos e régua

- **Régua de pendência** (`src/lib/regraPendencia.ts`): a nota precisa ter um tipo de documento
  aceito (`:68-77`) e estar com **mais de 1 dia corrido** de atraso sobre a previsão (`:93`).
  Ficam fora a 32 e a 34 (`:90`) e as ocorrências de encerramento **1, 22, 30, 42, 44, 46, 47,
  61** (`:84`). O banco tem uma cópia da régua: `20260921140000_pendencias_regua.sql:53-69`.
- **Carga parada** = dias úteis desde a última ocorrência, sem sábado, domingo e feriado
  nacional (`pendencia.ts:122-153`). Atraso = dias corridos desde a previsão (`:92-104`).
  Feriados: fixos, Carnaval (seg/ter), Sexta Santa e Corpus Christi
  (`etl/notas-ciclo/src/calendario.js:48-55`).
- **Faixas de carga parada:** 0, 1, … 7 dias e "acima de 7" (`CargaParadaAnalise.tsx:15-23`).
  Crítica = mais de 5 dias (`CargasCriticasPanel.tsx:17`; `RegionalPanel.tsx:26`).
- **Prazo por setor** (`sla_setores`, prazo/crítico em dias): Operação 3/7, Relacionamento 3/7,
  Perdas 5/10, Ressarcimento 5/10, Devolução 3/7, Cliente 5/10
  (`20260305193540_*.sql:16-22`). Agendamento não tem linha.
- **Exportar carga parada** (`src/pages/Gestao.tsx:800-990`):
  - Entra só tipo NORMAL fora do prazo.
  - Pré-entrega (07, 13, 15, 21, 36, 39, 55): a partir de 1 dia útil no código
    (`:809-812`); o texto de ajuda diz 2.
  - Informação faltante (56 e destroca 51/52/58): a partir de 1 dia útil (`:844-848`).
  - Redespacho Final (40): a partir de 3 dias úteis (`:838-843`).
  - Devolução/reversa com oc 2: entra sempre (`:815-830`).
  - O arquivo tem uma aba por base, com o gerente regional.
- **Priorização automática** (`src/lib/autoPriorizar.ts:17-36`):
  - pré-entrega NORMAL a partir de 2 dias úteis (3 até 29/09/2026);
  - destroca a partir de 5;
  - informação faltante a partir de 2.
- **Os 3 indicadores** (`docs/INDICADORES-DE-PENDENCIA.md:313-315`;
  `src/components/gestao/indicadores/definicoes.ts:31-87`):

  | Indicador | Quem entra | Como conta | Limite |
  |---|---|---|---|
  | Até 7 dias | coorte da previsão, sem devolução e reversa | só os dias úteis em OPERAÇÃO | 7 dias úteis |
  | Pré-entrega até 2 dias | ocorrência 07, 13, 15, 21, 36, 39 ou 55 depois que o prazo vence | até a ocorrência 14 | 2 dias úteis |
  | Devolução até 15 dias | todas | da emissão até o encerramento | 15 dias úteis |

- **Regionais** (`src/lib/regionais.ts:17-69`): Daiene, Geraldo, Gil, Bruno e Isabella. Para
  cada uma, a lista de bases.
- **Responsável de relacionamento:** sai do CNPJ do pagador (`clientes_segmentos`). Sem
  cadastro, vai para o responsável padrão (`processar-batch/index.ts:264-342`, `:162-190`).
  Não se aplica à Operação.

## 4. Gestão (o que a tela faz)

- **Sub-abas** (`Gestao.tsx:776-781`):
  - **Visão Geral**: carga parada por faixa; regional → base; base, responsável e código da
    última oc; pendências novas do dia anterior; exportar carga parada.
  - **Gestão de Entregas**: programação do dia seguinte; notas e volumes por data; top cidades;
    visão por filial.
  - **Indicadores**: os 3 da seção 3.
  - **Evolução Diária**: retratos diários (`historico_carga_parada_diario`).
- **Telas à parte:**
  - Tempo por Setor: dias em cada setor, a partir dos retratos diários
    (`src/lib/tempoPorSetor.ts:1-15`).
  - Visão Executiva: por status (`VisaoExecutiva.tsx:55-83`).
  - Eficiência: aging, IVP = resolvidas ÷ novas, vazão por setor e base
    (`eficiencia-fechar-dia/index.ts:139-148`, `:550-561`, `:731-795`).

## 5. Comprovantes (o que a tela faz)

- **Só leitura** no Pendências: lista as entregas feitas cujo canhoto ainda não foi escaneado.
  A tela não marca escaneado e não envia e-mail (ajuda em `ComprovantesEntrega.tsx`, ~1005-1238).
- **Fonte:** um **segundo projeto Supabase**, com chave fixa no código
  (`src/integrations/supabase-comprovantes/client.ts:5-12`), e as views
  `vw_pendencias_comprovante_entrega`, `vw_comprovantes_entregues`, `vw_resumo_por_base`,
  `vw_resumo_por_placa`, `vw_resumo_por_cliente` e `vw_catalogo_bases_comprovantes`
  (`useComprovantesData.ts:95-495`).
- **Indicadores:** pendências, % = pendências ÷ (entregues + pendências), frete e mercadoria
  pendentes (`useComprovantesData.ts:445-474`).
- **Faixas de idade:** a ajuda usa Em dia 1–3, Atrasada 4–8, Crítica 9–15 e Vencida 16+. Os
  gráficos usam 0–5, 6–10, 11–30 … >150 (`EvolucaoPendenciasCharts.tsx:58-66`).
- **Situação da base:** Melhorando, Piorando ou Estável, pela variação da mercadoria pendente
  sobre o mês anterior. |variação| < 2% é estável (`EvolucaoPendenciasCharts.tsx:83-101`); a
  tabela usa 0,5% (`VariacaoBaseTables.tsx:69-77`).
- **Exclusões:** uma última oc com "RESSARCIMENTO" sai da lista; um CTRC duplicado foi tirado à
  mão (`src/lib/comprovantes/exclusoesPendencia.ts:10-46`).
- **Recortes:** por base (com as 3 placas que mais pesam), ranking de placas, por cliente
  pagador e detalhe (500 linhas). Exporta CSV/XLSX para cobrar a base. Cada pessoa vê só as
  bases dela.

## 6. Fontes e integrações

- **Supabase principal** `ydnakkqqkxvtnsigklbb`: `pendencias`, `ocorrencias_setores`,
  `sla_setores`, `feriados_nacionais`, `unidades_mapeamento`, retratos diários e
  `meta_ciclo_*`.
- **Supabase secundário** `fsswfealkyavtjfaleil`: comprovantes e relatório 043.
- **ETL `etl/notas-ciclo`:** lê o espelho da **455** (MySQL na Hostinger) e a **930** (AWS
  `sis_unificado`, ou a ponte `romaneio.salexpress.com.br/api/ciclo/ocorrencias`). Grava no
  Supabase principal.
- **`etl/localizacao-455`:** corrige a base de devolução e reversa.
- **Importação CSV** (`processar-batch`): o setor sai de `ocorrencias_setores`.
- O Bastão que alimenta a fila da Operação usa os mesmos valores de `responsavel_atual` em
  minúsculas (`operacao`, `relacionamento` …), segundo o filtro `responsavel_atual.eq.operacao`
  de `supabase/functions/_shared/bastao-operacao-client.ts:60-64`. Não foi conferido no banco
  se ele **é** o Pendências ou um parente dele (decisão D-1 no ADR 0042).

## 7. Onde diverge do que o Cockpit já tinha (ADR 0041)

| Peça do ADR 0041 | Pendências | O que muda (ADR 0042) |
|---|---|---|
| `op_regra_unidade_por_oc` (unidade pelo campo do Bastão, por oc) | a base vem de colunas geradas: para REVERSA/DEVOLUÇÃO, a base operacional atual; para o resto, a base de destino | Nada muda na regra de unidade. A regra do Pendências fica como **candidata** para a semente da tabela (decisão da Sal). |
| `operacao_membros.papel_op` (`operador_op`, `supervisor_op`) + `unidades` | 5 papéis + setores + bases | Novo papel **`gerente_op`** (= gerente_filial: as unidades dele, todos os setores, abre a Gestão). Nova coluna **`setores`** (padrão `{OPERACAO}`, nunca RELACIONAMENTO) = `usuario_setor`. |
| Fila = só "da Operação" | 7 setores | `op_setores` + `op_setor_por_oc` (mig 441). A fila entra por **setores na fila**; por padrão, só a Operação (comportamento idêntico). Agendamento, Devolução, Ressarcimento, Perdas e Cliente ficam prontos, desligados. O Relacionamento é proibido por CHECK. |
| Famílias do kanban (`familias.ts`: o que fazer, pela oc) | setor (quem é dono, pela oc) | São eixos diferentes e convivem: a família agrupa as colunas, o setor recorta quem vê. As famílias do Caio (PR #42) não foram tocadas. |
| `op_codigos_lancaveis` (vazia; trigger só aceita responsabilidade 'Operação' do dicionário; proibidos 49, 54, 59, 33, 44, 6, 9, 16) | não lança no SSW | Nada muda. Os proibidos batem com o mapa: 49 é do Relacionamento, 54/59 do Cliente, 33 do Ressarcimento, 44 da Devolução, 6/9/16 de Perdas. |
| Sugestões (regra → regra aprendida → agente; encaminhar ao Relacionamento) | sem sugestão | A nota vai ao setor dono pelo código. A sugestão de encaminhar continua **só para o Relacionamento** (espelho). Encaminhar para outro setor da Operação fica como decisão D-4. |
| Separação por RLS (Operação × Relacionamento) | RLS por setor e por base | A mig 441 põe uma policy RESTRICTIVE em `op_itens`: o `operador_op` vê só os seus setores; supervisão, gerente e gestor veem todos. Triggers barram assumir, lançar ou encaminhar fora do setor (`fora_do_seu_setor`). |
| Sem prazo por setor | `sla_setores`, régua, carga parada | Viram regras puras no front (`regua.ts`), usadas na aba Gestão. |
| Sem comprovantes | tela só leitura sobre o projeto secundário | Aba Comprovantes. A fonte fica **a definir** (D-3); na demonstração, dados fictícios mais as notas reais com oc 12. |

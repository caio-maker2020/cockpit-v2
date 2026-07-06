# Lovable — Kanban EXTRAVIOS: remover D5, criar coluna "AUTÔNOMO NÃO RODOU"

## Contexto
A aba EXTRAVIOS é um kanban por dias úteis, alimentado pela view `v_extravios_kanban`
(Supabase, RLS por operador via `security_invoker` — operador já vê só os cards dele).
Estamos ligando um agente autônomo que, no **4º dia útil**, lança a oc 49 no SSW. Por
isso o kanban muda.

## O que mudar

1. **Remover a coluna `D5` ("5+ DIAS ÚTEIS").** Ela não existe mais.
2. **A coluna `D4` agora é "4+ DIAS ÚTEIS"** (absorve tudo de 4 dias pra cima). O label
   da coluna D4 deve virar **"D4 · 4+ DIAS ÚTEIS"**.
3. **Criar uma coluna nova "🤖 AUTÔNOMO NÃO RODOU"** ao lado da D4.

## Como o backend entrega (a view já está pronta e deployada)

A view `v_extravios_kanban` agora retorna, além dos campos atuais, estes campos NOVOS:
- `coluna_kanban` — valores possíveis: `'D1'`, `'D2'`, `'D3'`, `'D4'`, **`'NAO_RODOU'`** (novo).
  Use ele pra bucketizar as colunas (não recalcule dias no front).
- `agente_extravio_status` — `null` | `'recomendado'` | `'nao_rodou'` | `'lancou'`.
- `agente_extravio_motivo` — texto (preenchido só quando `nao_rodou`): a explicação do
  agente do PORQUÊ não lançou a 49.
- `agente_extravio_oc_achada` — int (a ocorrência que o agente achou no SSW, quando `nao_rodou`).
- `agente_extravio_checado_em` — timestamptz (quando o agente conferiu no SSW).

## Comportamento das colunas

- **D1, D2, D3, D4** → como hoje (cards por `coluna_kanban`).
- **🤖 AUTÔNOMO NÃO RODOU** → todos os cards com `coluna_kanban = 'NAO_RODOU'`.
  Em cada card desta coluna, mostrar com destaque o campo **`agente_extravio_motivo`**
  (ex: *"Não lancei a oc 49: o SSW já mostra a ocorrência 20 (EXTRAVIO LOCALIZADO)
  lançada em 23/06 10:30 por L.CHALUB — depois do extravio. Verifique e reporte."*).
  Esses cards estão parados aguardando o operador verificar — não somem sozinhos.

## Detalhe visual opcional (bom ter)
- Cards na D4 com `agente_extravio_status = 'recomendado'` podem ganhar um selo discreto
  tipo **"agente recomenda lançar oc 49"** (o agente já conferiu o SSW e está pronto).
- O botão **"Reportar"** nos cards da coluna NÃO RODOU será ligado num próximo passo
  (vou te mandar o RPC). Por ora pode deixar o card só exibindo o motivo.

## Importante
- Não filtrar/ordenar por dias no front — usar `coluna_kanban` da view.
- RLS já isola por operador (a view é `security_invoker`); não precisa filtrar por operador no front.

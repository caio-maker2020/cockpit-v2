# ADR 0004 — Cockpit é work queue exclusiva do Relacionamento; Bastão é fonte de verdade

**Data:** 2026-04-28
**Status:** Aceito

## Contexto

A Sal Express tem múltiplas áreas que tocam NFs durante o ciclo de vida da
carga: Relacionamento, Devolução, Ressarcimento, Perdas, Agendamento, e
Operação. Cada área tem fluxos, ferramentas e responsabilidades próprias.

Hoje:
- **Cockpit v1** atende exclusivamente o time de **Relacionamento** (mensagens
  WhatsApp/e-mail dos clientes, tratativas de oc 54 etc.).
- **Bastão** é uma plataforma própria da Sal Express (Supabase + Lovable) com
  **todas as pendências** indexadas — cada NF / CTRC com a `cod_ultima_ocorrencia`
  atualizada, área responsável, pagador, base destino, atraso, etc.
- Quem trabalha no Relacionamento vive **entre Cockpit + Bastão**.
- As outras áreas (Devolução, Ressarcimento, Perdas, Agendamento) usam SSW
  direto ou ferramentas próprias.

A planilha interna [`Ocor_respon.xlsx`] classifica os 58 códigos de ocorrência
em 7 áreas:

| Área           | Códigos                                               |
|----------------|-------------------------------------------------------|
| Operação       | 1, 2, 4, 5, 7, 12-15, 21, 22, 24, 25, 27, 29, 32, 34, 36-41, 45, 48, 50, 55-57 |
| Relacionamento | 3, 8, 10, 11, 17, 19, 20, 23, 26, 28, 35, 43, 49, 52, 58 |
| Cliente        | 54                                                    |
| Perdas         | 6, 9, 16                                              |
| Ressarcimento  | 18, 33, 42, 46, 47                                    |
| Devolução      | 30, 44, 53                                            |
| Agendamento    | 31                                                    |

Caio decidiu: o Cockpit v2 atende **apenas o Relacionamento**. Outras áreas
ganharão suas próprias plataformas / agentes em projetos paralelos quando
chegar a hora.

## Decisão

**Cockpit v2 é a work queue exclusiva do time de Relacionamento.**

**Bastão é a fonte de verdade de todas as pendências.**

### Regras concretas

1. **Sync periódico Bastão → Cockpit** importa apenas cargas cuja
   `cod_ultima_ocorrencia` está numa lista canônica de **16 ocorrências**
   (15 de categoria "Relacionamento" + 54 "Aguardando retorno cliente pagador").
   Lista no código em `lib/bastao-rules.ts`.

2. **Mensagem do cliente puxa qualquer NF** — quando o vinculador encontra
   NF X numa mensagem entrante e não há card ativo no Cockpit, ele consulta
   Bastão e importa, **sem filtro por ocorrência**. O fato do cliente estar
   perguntando É a razão pra relacionamento agir, mesmo se a ocorrência atual
   for operacional (ex.: cliente cobra status 2 dias após oc 21 lançada).

3. **Cards saem do Cockpit quando a ação é confirmada via Bastão** — operador
   aprova lançamento de ocorrência → executor faz no SSW → sync Bastão detecta
   nova `cod_ultima_ocorrencia` → se a nova ocorrência **saiu** da lista das
   16+54, o sync grava `OcorrenciaSSWConfirmada` + `DevolvidoParaOperacao` e
   transiciona `card.state = RESOLVIDO`. O card sai do Inbox default.

4. **Outras áreas NÃO usam o Cockpit v2.** Devolução, Ressarcimento, Perdas e
   Agendamento ficam em suas ferramentas atuais (ou ferramentas a construir
   em projetos separados). Quando uma carga muda pra ocorrência dessas áreas
   e ainda não há sinal do cliente cobrando, sai do Cockpit (regra 3).

5. **Reabertura** — card no Cockpit em estado `RESOLVIDO` que recebe nova
   `MensagemEntrante` com NF/CTRC associada volta pra `EM_TRIAGEM` (não cria
   card novo). Mantém histórico contínuo.

## Lista canônica de ocorrências do Cockpit

| Cód | Descrição                                          | Categoria       |
|-----|----------------------------------------------------|-----------------|
| 3   | Avaria na coleta                                   | Relacionamento  |
| 8   | Avaria na transferência                            | Relacionamento  |
| 10  | Recusa total da entrega                            | Relacionamento  |
| 11  | Entrega impossibilitada: problemas com endereço    | Relacionamento  |
| 17  | Avaria na entrega                                  | Relacionamento  |
| 19  | Entrega realizada com falta de volumes             | Relacionamento  |
| 20  | Extravio localizado                                | Relacionamento  |
| 23  | Problemas com documentação                         | Relacionamento  |
| 26  | Conjunto de comprovantes incompletos               | Relacionamento  |
| 28  | Retenção de carga pela fiscalização pública        | Relacionamento  |
| 35  | Entrega realizada com recusa parcial               | Relacionamento  |
| 43  | Manutenção perecível realizada                     | Relacionamento  |
| 49  | Tratativa de relacionamento                        | Relacionamento  |
| 52  | Finalização do processo de destroca                | Relacionamento  |
| 58  | Volume da destroca coletado                        | Relacionamento  |
| 54  | Aguardando retorno cliente pagador                 | Cliente         |

Total: **16 ocorrências disparam sync periódico Bastão → Cockpit**.

## Alternativas consideradas

### Alternativa 1 — Cockpit unificado (todas as áreas)

Construir uma plataforma que atende Relacionamento + Devolução + Ressarcimento
+ Perdas + Agendamento.

- **Pró:** uma só ferramenta interna.
- **Contra:** cada área tem fluxo próprio; misturar tudo aumenta ruído visual,
  exige RBAC fino por área, complica RLS, e atrasa o MVP. Time de Relacionamento
  veria notificações de Devolução que não são da conta dele.
- **Rejeitada.** Cada área evolui em projeto próprio, na sua cadência, com
  suas regras. Quando convergir, repensar.

### Alternativa 2 — Sem sync periódico do Bastão

Card só nasce quando cliente manda mensagem (WhatsApp/email).

- **Pró:** simplicidade — um único caminho de criação.
- **Contra:** perde o "discovery automático" de oc 54. Time deixaria de
  reagir proativamente quando cliente NÃO cobra mas a carga está parada
  aguardando retorno do cliente pagador.
- **Rejeitada.** Sync periódico de 16+54 tem signal-to-noise alto.

### Alternativa 3 — Substituir o Bastão pelo Cockpit

Migrar todas as pendências pro Cockpit, descontinuar Bastão.

- **Pró:** uma fonte só.
- **Contra:** Bastão atende áreas que não usam Cockpit. Substituí-lo é
  projeto à parte, escopo maior, risco operacional.
- **Rejeitada por enquanto.** Pode ser reconsiderada quando ≥3 áreas
  estiverem em ferramentas tipo Cockpit e fizer sentido convergir.

## Consequências

**Aceitas:**
- Dependência operacional do Bastão — se cair, sync periódico para. Mitigação:
  cards via mensagem do cliente seguem funcionando (vinculador puxa Bastão
  on-demand; se Bastão totalmente fora, vinculador degrada pra criar card só
  com dados extraídos da mensagem).
- Lista de 16 ocorrências precisa ser revisada se a operação mudar (movimento
  raro). Atualizar = mudar `lib/bastao-rules.ts` + commit revisável.
- Quando Devolução / Ressarcimento / Perdas tiverem suas plataformas
  próprias, vão precisar consultar Bastão também — ok, é fonte de verdade
  pra todo mundo.

**Ganhas:**
- UX clara pra operador: tudo que aparece é responsabilidade dele.
- Cockpit fica focado e simples no MVP.
- Outras áreas podem evoluir suas ferramentas sem afetar Cockpit.
- Decisão de escopo registrada pra qualquer pessoa que ler o repo.

## Como aplicar (regras pra desenvolvedor)

1. **`lib/bastao-rules.ts`** exporta a constante `OCORRENCIAS_DE_RELACIONAMENTO`
   (Set<number>) com os 16 códigos. Toda lógica de filtro de sync usa essa
   constante. Não duplicar a lista em outros arquivos.

2. **`sync-bastao` Edge Function** roda em pg_cron, faz 3 passes:
   - **Pass A — discover:** Bastão.pendencias com
     `cod_ultima_ocorrencia ∈ OCORRENCIAS_DE_RELACIONAMENTO` → garante card
     no Cockpit.
   - **Pass B — release:** cards Cockpit ativos onde
     Bastão.cod_ultima_ocorrencia saiu do set → grava
     `DevolvidoParaOperacao` + state='RESOLVIDO'.
   - **Pass C — verify:** cards com `todos.status='executando'` → checa se
     a `cod_ultima_ocorrencia` esperada apareceu → confirma ou marca timeout.

3. **Vinculador** — quando precisar puxar NF que não tem card ativo, consulta
   Bastão via `lib/bastao-client.ts` **sem filtro por ocorrência**.

4. **Documentar áreas externas** — se um agente especialista do Cockpit
   detecta que o caso é de outra área (ex.: avaria com seguro vira
   Ressarcimento), ele escala humano (`event_type=EscaladoHumano`,
   `payload.area_destino='ressarcimento'`). UI mostra qual área deve
   continuar a tratativa.

## Quando reconsiderar

Reabrir este ADR quando:

- ≥3 áreas tiverem agentes/automações próprios e fizer sentido unificar UI.
- A operação centralizar áreas (ex.: Relacionamento + Devolução virarem mesmo
  time).
- Bastão for descontinuado, substituído, ou mudar de schema.
- A lista de 16 ocorrências do Relacionamento mudar (revisão da planilha
  `Ocor_respon.xlsx`).

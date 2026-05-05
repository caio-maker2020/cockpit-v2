# Cockpit v2 — Kanban v2 (6 colunas + lock + tratativa)

Cole esse prompt inteiro no Lovable. Substitui o anterior. Banco já atualizado (migration 023).

## Mudanças no Kanban

Reordenando e adicionando colunas. Total = **6 colunas**.

| # | Coluna (label) | Filtro PostgREST / supabase-js | O que aparece |
|---|---|---|---|
| 1 | **PARA FAZER** | `state IN ('AGUARDANDO_AGENTE','AGUARDANDO_CONTEXTO','AGUARDANDO_VINCULACAO','EM_TRIAGEM') AND aprovacao_modo IS NULL AND lock_aguardando_validacao = false` | Cards do Bastão sem agente atuando + cards com agente trabalhando |
| 2 | **AGUARDANDO VALIDAÇÃO HUMANA** | `state = 'AGUARDANDO_VALIDACAO_HUMANA'` | Agente puxou pra Larissa decidir. **Card fica TRAVADO aqui** até ela clicar Aprovar/Rejeitar |
| 3 | **AGUARDANDO CLIENTE** | `state = 'AGUARDANDO_CLIENTE' AND lock_aguardando_validacao = false` | oc 54 esperando retorno do cliente |
| 4 | **AÇÃO EXECUTADA** | `aprovacao_modo = 'humana' AND state NOT IN ('CANCELADO','TRANSFERIDO','RESOLVIDO')` | Larissa aprovou, ocorrência lançada (sai daqui no próximo sync se mudar de setor) |
| 5 | **AÇÃO AUTÔNOMA** | `aprovacao_modo = 'autonoma' AND state NOT IN ('CANCELADO','TRANSFERIDO','RESOLVIDO')` | Agente lançou sozinho |
| 6 | **TRATATIVA PENDENTE** | `state = 'TRATATIVA_PENDENTE'` | Card já saiu pra outro setor (operação/devolução/etc) e cliente cobrou de novo |

Cards em `state IN ('TRANSFERIDO','RESOLVIDO','CANCELADO')` **somem do Kanban principal** (Larissa não vê — só aparecem se ela for numa aba "Histórico" / "Resolvidos" secundária).

```ts
// Em supabase-js, exemplos das 6 colunas:

// 1. PARA FAZER
.from("cards").select("...")
  .in("state", ["AGUARDANDO_AGENTE","AGUARDANDO_CONTEXTO","AGUARDANDO_VINCULACAO","EM_TRIAGEM"])
  .is("aprovacao_modo", null)
  .eq("lock_aguardando_validacao", false)

// 2. AGUARDANDO VALIDAÇÃO HUMANA
.from("cards").select("...").eq("state", "AGUARDANDO_VALIDACAO_HUMANA")

// 3. AGUARDANDO CLIENTE
.from("cards").select("...")
  .eq("state", "AGUARDANDO_CLIENTE")
  .eq("lock_aguardando_validacao", false)

// 4. AÇÃO EXECUTADA
.from("cards").select("...")
  .eq("aprovacao_modo", "humana")
  .not("state", "in", "(CANCELADO,TRANSFERIDO,RESOLVIDO)")

// 5. AÇÃO AUTÔNOMA
.from("cards").select("...")
  .eq("aprovacao_modo", "autonoma")
  .not("state", "in", "(CANCELADO,TRANSFERIDO,RESOLVIDO)")

// 6. TRATATIVA PENDENTE
.from("cards").select("...").eq("state", "TRATATIVA_PENDENTE")
```

## Coluna nova: `cards.lock_aguardando_validacao` (bool)

Garante que card que o agente puxou pra validação humana **não volte automaticamente** pra AGUARDANDO_CLIENTE no próximo sync (mesmo que oc 54 ainda esteja no Bastão). Só destrava via aprovação ou rejeição da Larissa.

UI **não precisa setar** essa flag — backend cuida (vinculador seta, RPCs `aprovar_e_executar` e `rejeitar_acao` destravam). Só precisa **incluir nos filtros das colunas 1 e 3** conforme tabela acima.

## Coluna nova: `cards.state` agora aceita 2 estados novos

- `TRANSFERIDO` — card saiu pra outro setor (operação/devolução/indenização). **Some do Kanban principal.**
- `TRATATIVA_PENDENTE` — estava transferido, cliente cobrou de novo, voltou pro Larissa.

Atualize os tipos TS gerados do Supabase pra incluir esses valores em `Database['public']['Tables']['cards']['Row']['state']`.

## Detalhe do card aberto

### Tag de setor responsável (novo)

Quando card está `TRANSFERIDO` ou tem evento `DevolvidoParaSetor` na timeline, mostra uma tag visível:

```
Transferido pra: 🏢 Operação   (ou Devolução / Indenização / etc)
```

Lê do último card_event `DevolvidoParaSetor`, campo `payload.setor_destino` (texto: 'Operação' | 'Devolução' | 'Ressarcimento' | 'Perdas' | 'Agendamento' | 'Cliente' | 'Relacionamento').

### Botão Rejeitar — comportamento atualizado

Quando Larissa clica **Rejeitar** (com motivo obrigatório), o backend agora chama `rejeitar_acao(p_todo_id, p_motivo)` que:
- Destrava o lock
- Move o card pro state coerente com a oc atual:
  - oc 54 (Cliente) → `AGUARDANDO_CLIENTE`
  - oc de Relacionamento → `AGUARDANDO_AGENTE`
  - oc de outro setor → `TRANSFERIDO`
- Grava evento `RejeicaoOperador` com motivo + new_state

UI continua chamando o RPC `rejeitar_acao(p_todo_id, p_motivo)` igual antes — mudança é só no servidor.

### Botão Aprovar — sem mudança visível

Continua chamando `aprovar_e_executar(p_todo_id)`. Backend agora destrava o lock, marca `aprovacao_modo='humana'`, state vai pra `EXECUTANDO_ACAO`.

## Timeline de eventos novos

Adicionar render dos seguintes event_types:

- **`DevolvidoParaSetor`** (sync-bastao detectou que oc saiu de relacionamento)
  > 🔄 **Transferido pra Operação** — última oc lançada saiu do escopo do relacionamento
  > Payload: `{setor_destino, previous_cod, new_cod, new_descricao_instrucao}`

- **`RetornoCobrancaCliente`** (cliente cobrou de novo card que estava transferido)
  > ⚠️ **Cliente cobrou novamente** — card retornou da operação/setor anterior pra tratativa
  > Payload: `{previous_state, new_state, canal, remetente}`

- **`RejeicaoOperador`** (Larissa rejeitou proposta do agente)
  > ❌ **Proposta rejeitada por Larissa** — motivo: "{motivo}"
  > Payload: `{motivo, new_state, cod_ultima_ocorrencia, responsabilidade_oc}`

## Indicação visual do lock (opcional)

Cards em `AGUARDANDO_VALIDACAO_HUMANA` com `lock_aguardando_validacao=true` (sempre que estão nessa coluna, na prática) podem ter um pequeno cadeado 🔒 ou borda destacada na coluna pra reforçar que **só sai daqui via decisão humana**. Não é obrigatório, mas ajuda a Larissa entender por que o card não some sozinho.

## Resumo do que o backend faz agora (pro contexto)

1. **sync-bastao** (5min, cron): puxa pendências do Bastão da Larissa → cria/atualiza cards. Quando oc sai do escopo → state=TRANSFERIDO + evento DevolvidoParaSetor.
2. **Lock**: card em AGUARDANDO_VALIDACAO_HUMANA fica travado até aprovar/rejeitar — sync-bastao não mexe.
3. **Reabertura por cobrança**: vinculador detecta mensagem em card TRANSFERIDO → muda pra TRATATIVA_PENDENTE.
4. **Auto-aprovação** (regra teste, NF allowlist): card vai direto pra EXECUTANDO_ACAO sem passar por AGUARDANDO_VALIDACAO_HUMANA.

Mais nada muda no fluxo do operador — botões Aprovar/Rejeitar continuam chamando os mesmos RPCs.

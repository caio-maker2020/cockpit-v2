# Lovable — Aba Auditoria: só autônomo (FILTRO JÁ NO BACKEND) + refresh ao lançar

## Status: a filtragem já foi resolvida no backend — NÃO precisa mudar query
A aba Auditoria já lê as views `v_ressarc54_auditoria` e `v_agente_extravio_auditoria`.
Essas views foram alteradas (migração 274) pra retornar **somente** as ações 100% autônomas:
- `v_ressarc54_auditoria` → só `RessarcRelancar54Lancou` autônomo (exclui recomendou,
  não-rodou e lançou-por-operador).
- `v_agente_extravio_auditoria` → só `AgenteExtravioLancou49`.

> Ou seja: **mantendo as queries atuais**, ao recarregar a tela as linhas azuis (RECOMENDOU)
> e laranjas (NÃO RODOU) somem sozinhas. Não mexa nas colunas — o shape continua o mesmo
> (event_id, card_id, nf, operador, event_type, tier, descricao, created_at, …).

Se em algum componente você trocou a fonte pra `v_auditoria_acoes_autonomas` (prompt anterior),
**reverta pra `v_ressarc54_auditoria` + `v_agente_extravio_auditoria`** — essa view foi removida.

## O que ainda falta no front: atualizar a lista quando o agente lança (realtime)
O Caio quer que **toda vez que um agente lança autônomo, a aba Auditoria atualize na hora**.

Implementar refresh automático da lista da aba Auditoria:
1. **Realtime (preferido):** subscription do Supabase em `card_events` (INSERT). Quando chegar um
   evento com `event_type IN ('RessarcRelancar54Lancou','AgenteExtravioLancou49')`, refazer o
   fetch das views da aba (invalidar a query / refetch). Não precisa montar o item do payload do
   realtime — só usar como gatilho pra re-buscar das views (que já entregam o texto pronto e
   respeitam RLS).
   ```ts
   supabase.channel('auditoria-autonomas')
     .on('postgres_changes',
         { event: 'INSERT', schema: 'public', table: 'card_events' },
         (p) => {
           const t = p.new?.event_type;
           if (t === 'RessarcRelancar54Lancou' || t === 'AgenteExtravioLancou49') refetchAuditoria();
         })
     .subscribe();
   ```
2. **Fallback:** se realtime não estiver habilitado pra `card_events`, refazer o fetch a cada
   tick de SYNC (o mesmo "Atualizado HH:MM" do topo) e ao focar a aba.

## Critério de aceite
- Aba Auditoria mostra **apenas** linhas verdes "LANÇOU … · AUTÔNOMO" (nada de azul/laranja).
- Quando um agente lança autônomo, a nova linha aparece no topo sem reload manual.
- Filtro "VENDO APENAS: LARISSA" continua valendo (as views são `security_invoker` → RLS).

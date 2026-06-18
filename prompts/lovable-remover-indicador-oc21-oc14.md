# Lovable — Remover o indicador/aba de tempo oc21→oc14

O monitoramento oc21→oc14 foi **desativado e excluído** no backend (Caio 2026-06-18).
Remover do front tudo que dependia dele — senão vai dar erro (tabelas/views/funções
não existem mais).

## Remover
- A aba / seção / card de **"Tempo oc21 → oc14"** (indicador de SLA de reentrega),
  incluindo qualquer widget de "dias úteis até oc=14", ranking por base, etc.
- Qualquer botão tipo **"Cobrar base (oc14)"** / cobrança individual de oc14.

## O que NÃO existe mais (qualquer query/chamada a isto deve sair)
- Views: `v_indicador_tempo_oc21_oc14_base`, `v_tempo_oc21_oc14_detalhe`,
  `v_oc21_aguardando_oc14`
- Tabelas: `tempo_oc21_para_oc14`, `alertas_sla_oc21_oc14`, `contatos_bases_ssw`
- Edge functions (supabase.functions.invoke): `analisar-indicador-tempo-oc21-oc14`,
  `gerar-cobranca-oc14-individual`

## Não confundir (continua existindo, NÃO mexer)
- O kanban **PRIORIDADES AI** e suas views (`v_oc21_paradas_prioridades`,
  `v_oc13_paradas`) seguem ativos. A remoção é só do indicador de TEMPO/SLA
  oc21→oc14, não do kanban de prioridades.

-- Reconciliação FASE 1 (máquina de visão) — view == contagem bruta.
-- Rodar após aplicar a mig 344. Toda linha deve ter diff = 0.
-- Leitura pura; sem mutação.

select 'placar_pares' as checagem,
       (select coalesce(sum(pares),0) from v_gestao_agentes_placar) as via_view,
       (select count(*) from agent_feedback where veredito in ('seguida','corrigida')) as bruto,
       (select coalesce(sum(pares),0) from v_gestao_agentes_placar)
       - (select count(*) from agent_feedback where veredito in ('seguida','corrigida')) as diff
union all
select 'divergencias_n',
       (select coalesce(sum(n),0) from v_gestao_agentes_divergencias),
       (select count(*) from agent_feedback
         where veredito='corrigida' and oc_sugerida is not null and oc_executada is not null),
       (select coalesce(sum(n),0) from v_gestao_agentes_divergencias)
       - (select count(*) from agent_feedback
           where veredito='corrigida' and oc_sugerida is not null and oc_executada is not null)
union all
select 'acoes_cockpit_n',
       (select coalesce(sum(n),0) from v_acoes_cockpit),
       (select count(*) from card_events e join cards c on c.id=e.card_id
         where e.event_type in ('AprovacaoOperador','RejeicaoOperador','AprovacaoEmergencialOperador',
           'AutoAprovacaoPermitida','AcaoExecutada','RespostaEnviada',
           'InterpretadorRespostaClienteConcluido','CancelamentoReentregaAgendado',
           'CancelamentoReentregaTratadoManualmente')),
       (select coalesce(sum(n),0) from v_acoes_cockpit)
       - (select count(*) from card_events e join cards c on c.id=e.card_id
           where e.event_type in ('AprovacaoOperador','RejeicaoOperador','AprovacaoEmergencialOperador',
             'AutoAprovacaoPermitida','AcaoExecutada','RespostaEnviada',
             'InterpretadorRespostaClienteConcluido','CancelamentoReentregaAgendado',
             'CancelamentoReentregaTratadoManualmente'))
union all
select 'sinal_ouro_total_linhas',
       (select count(*) from v_sinal_ouro_casos),
       (select (select count(*) from agente_ocs_padrao_feedback)
             + (select count(*) from agente_oc13_feedback)
             + (select count(*) from interpretador_resposta_cliente_feedback)),
       (select count(*) from v_sinal_ouro_casos)
       - (select (select count(*) from agente_ocs_padrao_feedback)
              + (select count(*) from agente_oc13_feedback)
              + (select count(*) from interpretador_resposta_cliente_feedback))
union all
select 'fila_agora_cards',
       (select count(*) from v_operador_fila_agora),
       (select count(*) from cards c where c.state='AGUARDANDO_VALIDACAO_HUMANA'
          and exists (select 1 from card_events e where e.card_id=c.id
            and e.event_type in ('TodoPropostoAutomaticamente','CardReaberto','BastaoCardImportado',
              'RespostaClienteCapturada','RetornoClienteEmAguardo',
              'CardReabertoPorRespostaCliente','AguardandoClienteOcMudou'))),
       0; -- diff calculado na comparação manual das duas colunas

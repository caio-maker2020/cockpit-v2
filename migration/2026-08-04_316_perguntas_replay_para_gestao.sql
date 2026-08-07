-- 2026-08-04_316 — Perguntas do agente-chefe pra gestão (rodada pós-replay)
--
-- Origem: replay v3 das 3 regras que a Isadora ensinou em 24-27/07.
--   • interpretador:sug54 (comprovante ilegível → 56) ....... +10 pts, 0 dano → APROVADA
--   • agente-sugere-ocs-padrao:sug56 (GPS distante) ......... +5 pts MAS -16,7 de dano
--   • interpretador:sug56 (5 casos de NF) ................... -31,5 pts
-- As duas últimas não são regras ruins: falta precisão pra virar regra segura.
-- Estas 5 perguntas fecham exatamente os buracos que o teste expôs.
--
-- Também tira da fila de aprovadas as 2 propostas reprovadas no replay — senão
-- o /f6-aplicar-melhorias tentaria aplicar regra que o teste já reprovou.
-- Dados, não schema: aparecem pra gestão sem precisar de deploy.

BEGIN;

-- ============================================================
-- 1. As reprovadas saem da fila de execução (viram observação)
-- ============================================================
UPDATE public.learning_log
SET status = 'observacao',
    motivo_decisao = 'Replay v3 (04/08): melhora o padrão (+5 pts) mas causa dano '
      || 'colateral (-16,7 pts) em casos que já davam certo. Aguardando as respostas '
      || 'da gestão sobre corte de distância, ausência de GPS e foto que valida.'
WHERE tipo = 'ajuste_sugerido'
  AND detalhes->>'chave_padrao' = 'agente-sugere-ocs-padrao:sug56'
  AND status = 'aprovado';

UPDATE public.learning_log
SET status = 'observacao',
    motivo_decisao = 'Replay v3 (04/08): -31,5 pts. O material são 5 casos concretos '
      || '(NFs 114945, 1121711, 1228, 1523366, 1070019), não uma regra geral — '
      || 'aplicado como diretriz, empurra o agente pro lado errado. Aguardando a '
      || 'gestão dizer o que generaliza e o que é exceção.'
WHERE tipo = 'ajuste_sugerido'
  AND detalhes->>'chave_padrao' = 'interpretador-resposta-cliente:sug56'
  AND status = 'aprovado';

-- ============================================================
-- 2. As 5 perguntas novas
-- ============================================================

-- Casos reais citados pela gestão, pra aparecerem dentro da pergunta
CREATE TEMP VIEW _casos AS
SELECT nf,
       jsonb_build_object(
         'nf', nf,
         'card_id', id,
         'quando', coalesce(created_at, now()),
         'oc_card', cod_ultima_ocorrencia,
         'oc_executada', NULL,
         'operador', responsavel_relacionamento,
         'cliente', empresa_cliente,
         'motivo_correcao', NULL,
         'por_que_ia', jsonb_build_object(
           'observacao', 'Caso citado por você na resposta anterior.',
           'motivo_extraido', NULL, 'confianca', NULL,
           'foto_classificacao', NULL, 'ressalva_texto', NULL)
       ) AS caso
FROM public.cards
WHERE nf IN ('371193','6258','9418','49254','734296',
             '114945','1121711','1228','1523366','1070019');

-- ---------- P1: corte de distância ----------
INSERT INTO public.learning_log
  (agente, tipo, severidade, titulo, resumo, status, agente_alvo, detalhes)
SELECT 'agente-aprendizado', 'pergunta', 'info',
  'Régua do GPS: a partir de quantos km o lançamento vira improcedente?',
  'Você ensinou que ocorrência lançada muito longe do endereço não é confiável — '
  || 'citou "mais de 16 km" num caso e "aproximadamente 20 km" em outro. Testei a '
  || 'regra contra 20 casos reais: ela ajuda no bolsão certo, mas do jeito que está '
  || 'o agente também aplica onde não devia e erra casos que já davam certo. Com um '
  || 'número exato eu transformo isso numa regra segura.',
  'aberto', 'agente-sugere-ocs-padrao',
  jsonb_build_object(
    'chave_padrao', 'agente-sugere-ocs-padrao:sug56',
    'topico', 'gps-corte',
    'origem', 'replay-2026-08-04',
    'pergunta', 'A partir de quantos quilômetros entre o GPS do motorista e o endereço de entrega o lançamento deve ser considerado improcedente?',
    'o_que_sugiro', 'Com o número fechado, essa vira uma regra automática e confiável — o agente para de aplicar "no olho".',
    'opcoes_v2', jsonb_build_array(
      jsonb_build_object('id','16km','rotulo','16 km ou mais'),
      jsonb_build_object('id','20km','rotulo','20 km ou mais'),
      jsonb_build_object('id','outro','rotulo','Outro número (digo abaixo)',
        'followup', jsonb_build_object(
          'pergunta','Qual é o corte oficial?',
          'opcoes', jsonb_build_array(),
          'permite_texto', true,
          'texto_rotulo','Escreva só o número em km (ex.: 12).')),
      jsonb_build_object('id','nao_e_fixo','rotulo','Não é uma distância fixa — depende de outra coisa',
        'followup', jsonb_build_object(
          'pergunta','O que decide, então?',
          'opcoes', jsonb_build_array(
            jsonb_build_object('id','tipo_oc','rotulo','Depende do tipo de ocorrência'),
            jsonb_build_object('id','zona','rotulo','Depende da região (capital x interior)'),
            jsonb_build_object('id','cliente','rotulo','Depende do cliente'),
            jsonb_build_object('id','outro','rotulo','Outro fator (explico abaixo)')),
          'multi', true, 'permite_texto', true,
          'texto_rotulo','Descreva em 1 frase como decidir.'))),
    'casos_detalhe', coalesce((SELECT jsonb_agg(caso) FROM _casos WHERE nf IN ('371193','6258','9418')), '[]'::jsonb),
    'numeros', jsonb_build_object('casos_testados', 20, 'efeito_no_padrao_pts', 5, 'dano_colateral_pts', -17)
  );

-- ---------- P2: quando não há GPS ----------
INSERT INTO public.learning_log
  (agente, tipo, severidade, titulo, resumo, status, agente_alvo, detalhes)
SELECT 'agente-aprendizado', 'pergunta', 'info',
  'E quando o caso não tem GPS nenhum? (acontece em 8 de cada 10)',
  'Olhei os dados: só cerca de 2 em cada 10 casos têm a distância do GPS gravada. '
  || 'Preciso saber o que o agente faz nos outros 8 — se ele ignora a regra ou se '
  || 'a ausência do GPS também é sinal de alerta.',
  'aberto', 'agente-sugere-ocs-padrao',
  jsonb_build_object(
    'chave_padrao', 'agente-sugere-ocs-padrao:sug56',
    'topico', 'gps-ausente',
    'origem', 'replay-2026-08-04',
    'pergunta', 'Quando não existe o dado de GPS no caso, a regra da distância simplesmente não se aplica e o agente decide normalmente pela evidência — confirma?',
    'o_que_sugiro', 'É o que evita o agente ficar desconfiado de tudo e errar onde hoje acerta.',
    'opcoes_v2', jsonb_build_array(
      jsonb_build_object('id','ignora','rotulo','Sim — sem GPS, ignora essa regra e decide pela evidência normal'),
      jsonb_build_object('id','suspeito','rotulo','Não — sem GPS também trate o lançamento como suspeito',
        'followup', jsonb_build_object(
          'pergunta','E aí, o que o agente deve fazer?',
          'opcoes', jsonb_build_array(
            jsonb_build_object('id','21','rotulo','Lançar 21 com cancelamento da reentrega'),
            jsonb_build_object('id','56','rotulo','Pedir informação à operação (56)'),
            jsonb_build_object('id','54','rotulo','Notificar o cliente (54)')),
          'permite_texto', true)),
      jsonb_build_object('id','depende','rotulo','Depende (explico abaixo)',
        'followup', jsonb_build_object('pergunta','Como decidir sem GPS?', 'opcoes', jsonb_build_array(),
          'permite_texto', true, 'texto_rotulo','1 ou 2 frases já bastam.'))),
    'numeros', jsonb_build_object('casos_com_gps_pct', 19, 'casos_sem_gps_pct', 81)
  );

-- ---------- P3: a foto que salva o lançamento ----------
INSERT INTO public.learning_log
  (agente, tipo, severidade, titulo, resumo, status, agente_alvo, detalhes)
SELECT 'agente-aprendizado', 'pergunta', 'info',
  'Qual foto "salva" um lançamento feito longe do endereço?',
  'Você ensinou duas saídas para a mesma situação: GPS distante SEM evidência vira '
  || '21 com cancelamento; mas GPS distante COM foto da tentativa vira 54 (aguardar '
  || 'o cliente). Hoje o agente não sabe diferenciar "a foto certa" — e por isso erra '
  || 'para os dois lados. Preciso do critério.',
  'aberto', 'agente-sugere-ocs-padrao',
  jsonb_build_object(
    'chave_padrao', 'agente-sugere-ocs-padrao:sug56',
    'topico', 'foto-que-valida',
    'origem', 'replay-2026-08-04',
    'pergunta', 'Serve qualquer foto anexada, ou tem que ser especificamente uma foto que mostre a tentativa de localizar o endereço?',
    'o_que_sugiro', 'Este é o critério que mais vale: é ele que decide entre cancelar a reentrega e notificar o cliente.',
    'opcoes_v2', jsonb_build_array(
      jsonb_build_object('id','qualquer','rotulo','Qualquer foto anexada já basta',
        'followup', jsonb_build_object('pergunta','Só pra confirmar: mesmo foto de canhoto ou de mercadoria conta?',
          'opcoes', jsonb_build_array(
            jsonb_build_object('id','sim','rotulo','Sim, qualquer uma'),
            jsonb_build_object('id','nao','rotulo','Não — só as que mostram o local')),
          'pede_imagem', true, 'permite_texto', true,
          'texto_rotulo','Se puder, anexe uma foto que CONTA e uma que NÃO CONTA — é o melhor exemplo de treino.')),
      jsonb_build_object('id','so_tentativa','rotulo','Só foto que mostre a tentativa (fachada, portaria, local fechado)',
        'followup', jsonb_build_object('pergunta','Como o agente reconhece essa foto?',
          'opcoes', jsonb_build_array(
            jsonb_build_object('id','fachada','rotulo','Aparece a fachada/portaria do endereço'),
            jsonb_build_object('id','placa','rotulo','Aparece placa, número ou nome da rua'),
            jsonb_build_object('id','local_fechado','rotulo','Mostra o local fechado/sem acesso'),
            jsonb_build_object('id','outro','rotulo','Outro sinal (explico abaixo)')),
          'multi', true, 'pede_imagem', true, 'permite_texto', true,
          'texto_rotulo','Anexe um print de exemplo se tiver — ajuda muito.')),
      jsonb_build_object('id','depende_oc','rotulo','Depende da ocorrência (na 11 vale, em outras não)',
        'followup', jsonb_build_object('pergunta','Em quais ocorrências a foto salva o lançamento?',
          'opcoes', jsonb_build_array(
            jsonb_build_object('id','oc10','rotulo','10 — recusa total'),
            jsonb_build_object('id','oc11','rotulo','11 — problema com endereço'),
            jsonb_build_object('id','oc19','rotulo','19 — falta de volumes'),
            jsonb_build_object('id','oc35','rotulo','35 — recusa parcial')),
          'multi', true, 'permite_texto', true))),
    'casos_detalhe', coalesce((SELECT jsonb_agg(caso) FROM _casos WHERE nf IN ('6258','9418','371193')), '[]'::jsonb)
  );

-- ---------- P4: evidência inválida ----------
INSERT INTO public.learning_log
  (agente, tipo, severidade, titulo, resumo, status, agente_alvo, detalhes)
SELECT 'agente-aprendizado', 'pergunta', 'info',
  'Evidência de insucesso inválida: é sempre 21 com cancelamento da reentrega?',
  'Nas NFs 114945 e 1070019 você lançou 21 com cancelamento porque a evidência do '
  || 'insucesso não era válida. Testei isso como regra geral e o agente piorou 31 '
  || 'pontos — sinal de que falta o critério do que torna uma evidência inválida.',
  'aberto', 'interpretador-resposta-cliente',
  jsonb_build_object(
    'chave_padrao', 'interpretador-resposta-cliente:sug56',
    'topico', 'evidencia-invalida',
    'origem', 'replay-2026-08-04',
    'pergunta', 'Sempre que a evidência do insucesso for inválida a saída é 21 com cancelamento da reentrega, ou depende de mais alguma coisa?',
    'o_que_sugiro', 'Com o critério do que invalida uma evidência, o agente passa a reconhecer sozinho esses casos.',
    'opcoes_v2', jsonb_build_array(
      jsonb_build_object('id','sempre21','rotulo','Sempre 21 com cancelamento da reentrega',
        'followup', jsonb_build_object(
          'pergunta','O que torna a evidência do insucesso INVÁLIDA? (marque quantas valerem)',
          'opcoes', jsonb_build_array(
            jsonb_build_object('id','foto_nao_mostra','rotulo','A foto não mostra o local/fachada da entrega'),
            jsonb_build_object('id','sem_ressalva','rotulo','Não há ressalva escrita, só a foto'),
            jsonb_build_object('id','motivo_generico','rotulo','O motivo é genérico ("cliente ausente" sem detalhe)'),
            jsonb_build_object('id','gps_longe','rotulo','O lançamento foi feito longe do endereço'),
            jsonb_build_object('id','sem_foto','rotulo','Não há foto nenhuma')),
          'multi', true, 'pede_imagem', true, 'permite_texto', true,
          'texto_rotulo','Se tiver print de uma evidência que você considera inválida, anexe.')),
      jsonb_build_object('id','depende_cliente','rotulo','Depende — só quando o cliente não pediu outra coisa',
        'followup', jsonb_build_object('pergunta','E quando o cliente já pediu algo?',
          'opcoes', jsonb_build_array(
            jsonb_build_object('id','vale_cliente','rotulo','O pedido do cliente sempre prevalece'),
            jsonb_build_object('id','depende_pedido','rotulo','Depende do que ele pediu (explico)')),
          'permite_texto', true)),
      jsonb_build_object('id','outro','rotulo','Depende de outro fator (explico abaixo)',
        'followup', jsonb_build_object('pergunta','O que decide?', 'opcoes', jsonb_build_array(),
          'permite_texto', true, 'texto_rotulo','Complete: "QUANDO ___, o certo é ___".'))),
    'casos_detalhe', coalesce((SELECT jsonb_agg(caso) FROM _casos WHERE nf IN ('114945','1070019')), '[]'::jsonb),
    'numeros', jsonb_build_object('efeito_medido_pts', -31)
  );

-- ---------- P5: última decisão do cliente ----------
INSERT INTO public.learning_log
  (agente, tipo, severidade, titulo, resumo, status, agente_alvo, detalhes)
SELECT 'agente-aprendizado', 'pergunta', 'info',
  'A última decisão do cliente no e-mail sempre prevalece?',
  'Na NF 1121711 o cliente autorizou a devolução no fim da conversa e você ensinou '
  || 'que o agente deve ler todo o histórico do e-mail, porque a decisão final pode '
  || 'estar nas últimas mensagens. Preciso saber se isso vale sempre ou só para '
  || 'autorização de devolução.',
  'aberto', 'interpretador-resposta-cliente',
  jsonb_build_object(
    'chave_padrao', 'interpretador-resposta-cliente:sug56',
    'topico', 'ultima-decisao',
    'origem', 'replay-2026-08-04',
    'pergunta', 'Ler todo o histórico e valer a ÚLTIMA decisão do cliente é regra geral para qualquer caso, ou vale só quando ele autoriza devolução?',
    'o_que_sugiro', 'Se for regra geral, é uma das mudanças mais valiosas: hoje o agente costuma parar na primeira mensagem.',
    'opcoes_v2', jsonb_build_array(
      jsonb_build_object('id','geral','rotulo','Regra geral — a última decisão do cliente sempre prevalece',
        'followup', jsonb_build_object(
          'pergunta','Tem alguma exceção em que a mensagem ANTERIOR é que vale?',
          'opcoes', jsonb_build_array(
            jsonb_build_object('id','sem_excecao','rotulo','Não, sem exceção'),
            jsonb_build_object('id','tem_excecao','rotulo','Tem sim (descrevo abaixo)')),
          'permite_texto', true, 'texto_rotulo','Se tiver exceção, descreva em 1 frase.')),
      jsonb_build_object('id','so_devolucao','rotulo','Só quando ele autoriza devolução',
        'followup', jsonb_build_object('pergunta','Nos outros assuntos, o que vale?',
          'opcoes', jsonb_build_array(
            jsonb_build_object('id','primeira','rotulo','A primeira decisão dele'),
            jsonb_build_object('id','operadora','rotulo','O julgamento da operadora, caso a caso')),
          'permite_texto', true)),
      jsonb_build_object('id','depende','rotulo','Depende (explico abaixo)',
        'followup', jsonb_build_object('pergunta','Como decidir?', 'opcoes', jsonb_build_array(),
          'permite_texto', true))),
    'casos_detalhe', coalesce((SELECT jsonb_agg(caso) FROM _casos WHERE nf IN ('1121711','1228','1523366')), '[]'::jsonb)
  );

COMMIT;

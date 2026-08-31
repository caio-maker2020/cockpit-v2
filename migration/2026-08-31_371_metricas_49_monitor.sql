-- =============================================================================
-- 2026-08-31_371 — métricas da 49 no monitor (Caio: 'garanta as métricas')
-- =============================================================================
-- monitor_sombra_oc49 ganha 'metricas_49': baseline congelada (50,5% sem
-- sugestão, 30d pré-mudanças) + série diária de 21 dias (% sem sugestão) +
-- contagem dos casos novos em 7d. Só o monitor token-gated. Idempotente.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.monitor_sombra_oc49(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.monitor_tokens
                  WHERE token = p_token AND escopo = 'oc49_sombra') THEN
    RAISE EXCEPTION 'token invalido';
  END IF;

  SELECT jsonb_build_object(
    'placar', (SELECT jsonb_build_object(
        'total',            count(*),
        'divergem',         count(*) FILTER (WHERE diverge = true),
        'concordam',        count(*) FILTER (WHERE diverge = false),
        'ia_falhou',        count(*) FILTER (WHERE diverge IS NULL),
        'vereditos_ia',     count(*) FILTER (WHERE veredito = 'ia'),
        'vereditos_codigo', count(*) FILTER (WHERE veredito = 'codigo'),
        'vereditos_empate', count(*) FILTER (WHERE veredito = 'empate'),
        'vereditos_ambos_errados', count(*) FILTER (WHERE veredito = 'ambos_errados'),
        'tokens_in',        coalesce(sum(custo_tokens_in), 0),
        'tokens_out',       coalesce(sum(custo_tokens_out), 0)
      ) FROM public.oc49_sombra),
    'casos', (SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', s.id, 'nf', s.nf, 'card_id', s.card_id,
        'em', to_char(s.created_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI'),
        'codigo', s.decisao_codigo, 'ia', s.decisao_ia,
        -- Caio 27/08: 'real' = o que foi FEITO na realidade depois da leitura —
          -- 1º lançamento SSW confirmado do card após a sombra (fonte mais
          -- confiável: acoes_executadas_ssw), ou o 'aguardar' autônomo
          -- (que não passa pelo SSW). Null = nada aconteceu ainda.
        'real', COALESCE(
            (SELECT jsonb_build_object('oc', x.codigo_oc,
                     'em', to_char(x.iniciado_em AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI'))
               FROM public.acoes_executadas_ssw x
              WHERE x.card_id = s.card_id AND x.sucesso = true
                AND x.iniciado_em >= s.created_at
              ORDER BY x.iniciado_em LIMIT 1),
            (SELECT jsonb_build_object('aguardar', true,
                     'em', to_char(e.created_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI'))
               FROM public.card_events e
              WHERE e.card_id = s.card_id AND e.event_type = 'AutoAprovacaoPermitida'
                AND (e.payload->>'acao_key') LIKE 'ignorar%'
                AND e.created_at >= s.created_at
              ORDER BY e.created_at LIMIT 1)
          ),
        'diverge', s.diverge, 'veredito', s.veredito,
        'tokens_in', s.custo_tokens_in, 'tokens_out', s.custo_tokens_out
      ) ORDER BY s.created_at DESC), '[]'::jsonb)
      FROM (SELECT * FROM public.oc49_sombra ORDER BY created_at DESC LIMIT 200) s),
    -- Caio 31/08: métrica-mãe do agente da 49 — % sem sugestão por dia.
    -- BASELINE congelada (30d pré-mudanças, medida 28/08): 1.291/2.557 = 50,5%.
    'metricas_49', jsonb_build_object(
      'baseline_pct', 50.5,
      'baseline_janela', '30d ate 28/08 (1291 nao_reconhecido / 2557 decisoes)',
      'serie_diaria', (SELECT coalesce(jsonb_agg(jsonb_build_object(
          'dia', dia, 'total', total, 'sem_sugestao', sem_sug,
          'pct', CASE WHEN total > 0 THEN round(100.0 * sem_sug / total, 1) ELSE NULL END
        ) ORDER BY dia), '[]'::jsonb)
        FROM (
          SELECT to_char(ce.created_at AT TIME ZONE 'America/Sao_Paulo', 'MM-DD') AS dia,
                 count(*) AS total,
                 count(*) FILTER (WHERE ce.payload->'decisao'->>'caso_oc49' = 'nao_reconhecido') AS sem_sug
            FROM public.card_events ce
           WHERE ce.event_type = 'AgenteOcsPadraoDecisao'
             AND ce.payload->'decisao'->>'caso_oc49' IS NOT NULL
             AND ce.created_at > now() - interval '21 days'
           GROUP BY 1) t),
      'casos_novos_7d', (SELECT coalesce(jsonb_object_agg(caso, n), '{}'::jsonb)
        FROM (SELECT ce.payload->'decisao'->>'caso_oc49' AS caso, count(*) n
                FROM public.card_events ce
               WHERE ce.event_type = 'AgenteOcsPadraoDecisao'
                 AND ce.payload->'decisao'->>'caso_oc49' IN
                     ('3_tentativas','3_tentativas_nao_confirmadas','custo_dedicado',
                      'custo_isento_ovd_fg','carona_pos54','cobranca_retorno_59',
                      'seguir_entrega_relancado','relancamento_indenizacao')
                 AND ce.created_at > now() - interval '7 days'
               GROUP BY 1) t)
    ),
    'feedbacks', jsonb_build_object(
      'total', (SELECT count(*) FROM public.oc49_feedbacks),
      'por_categoria', (SELECT coalesce(jsonb_object_agg(categoria, n), '{}'::jsonb)
        FROM (SELECT categoria, count(*) n FROM public.oc49_feedbacks GROUP BY categoria) t),
      'por_recorrencia', (SELECT coalesce(jsonb_object_agg(recorrencia, n), '{}'::jsonb)
        FROM (SELECT recorrencia, count(*) n FROM public.oc49_feedbacks GROUP BY recorrencia) t),
      'match_ia', (SELECT jsonb_build_object('comparaveis', count(*),
          'bateram', count(*) FILTER (WHERE
            (f.categoria = 'cobranca_retorno'          AND s.decisao_ia->>'origem_da_49' = 'cobranca_de_retorno') OR
            (f.categoria = 'pendencia_docs_indenizacao' AND s.decisao_ia->>'origem_da_49' = 'indenizacao') OR
            (f.categoria = 'instrucao_operacional'      AND s.decisao_ia->>'origem_da_49' = 'operacao') OR
            (f.categoria = 'devolucao_retorno'          AND s.decisao_ia->>'origem_da_49' = 'devolucao')))
        FROM public.oc49_feedbacks f
        JOIN LATERAL (SELECT decisao_ia FROM public.oc49_sombra s
                       WHERE s.card_id = f.card_id ORDER BY s.created_at DESC LIMIT 1) s ON true
        WHERE f.categoria <> 'outro' AND f.categoria <> 'oc_lancada_errada'),
      'ultimos', (SELECT coalesce(jsonb_agg(jsonb_build_object(
          'nf', f.nf, 'categoria', f.categoria, 'categoria_outro', f.categoria_outro,
          'recorrencia', f.recorrencia, 'fontes', to_jsonb(f.fontes), 'frase', f.frase,
          'operador', f.operador_nome,
          'em', to_char(f.created_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI')
        ) ORDER BY f.created_at DESC), '[]'::jsonb)
        FROM (SELECT * FROM public.oc49_feedbacks ORDER BY created_at DESC LIMIT 30) f)
    )
  ) INTO v;
  RETURN v;
END $function$

;

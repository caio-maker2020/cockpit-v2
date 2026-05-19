-- ============================================================================
-- Cockpit v2 — DE/PARA oc=57: codigo_api passa de 77 pra 40
-- Data: 2026-05-19
--
-- Caio: "anteriormente pra lancarmos a 57 no ssw tinhamos que lancar a 77 na
-- api. A partir de agora temos que ao inves de lancar a 77 lancar a 40.
-- Sempre q o operador aprovar lancamento de 57 no ssw devemos lancar a 40."
--
-- Estratégia: preserva histórico — marca row antigo (77→57) como ativo=false
-- + adiciona row novo (40→57). A função lookup_codigo_api filtra ativo=true,
-- então o executor automaticamente passa a mandar 40 daqui pra frente.
--
-- Idempotente: re-rodar a migration não duplica nem perde estado.
-- ============================================================================

BEGIN;

-- 1) Desativa o mapeamento antigo (codigo_api=77 → codigo_ssw=57).
--    WHERE ativo=true garante que não toca em row já desativado.
UPDATE public.ocorrencias_dexpara
SET ativo = false,
    observacao = COALESCE(observacao, '') ||
      ' [2026-05-19: substituído por codigo_api=40 — mudança no DE/PARA da SSW API]',
    updated_at = now()
WHERE codigo_api = 77
  AND codigo_ssw = 57
  AND ativo = true;

-- 2) Cria/garante o novo mapeamento (codigo_api=40 → codigo_ssw=57).
--    ON CONFLICT pra ser re-runnable. Se já existir, garante ativo=true
--    e atualiza descrição/observação.
INSERT INTO public.ocorrencias_dexpara (codigo_api, codigo_ssw, descricao, ativo, observacao)
VALUES (40, 57, 'VOLUME DE DESTROCA COLETADO', true,
        'Caio 2026-05-19: substitui codigo_api=77 — mudança no DE/PARA da SSW API. '
        'Operador aprova oc=57 no Cockpit, executor envia codigo_api=40 pra API.')
ON CONFLICT (codigo_api) DO UPDATE
SET codigo_ssw = EXCLUDED.codigo_ssw,
    descricao = EXCLUDED.descricao,
    ativo = true,
    observacao = EXCLUDED.observacao,
    updated_at = now();

-- 3) Smoke test inline: lookup_codigo_api(57) deve retornar 40.
DO $$
DECLARE
  v_codigo_api integer;
BEGIN
  SELECT public.lookup_codigo_api(57) INTO v_codigo_api;
  IF v_codigo_api IS DISTINCT FROM 40 THEN
    RAISE EXCEPTION 'Smoke test falhou: lookup_codigo_api(57) retornou %, esperado 40', v_codigo_api;
  END IF;
END $$;

COMMIT;

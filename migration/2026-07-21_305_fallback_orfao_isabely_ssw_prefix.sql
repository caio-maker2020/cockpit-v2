-- =============================================================================
-- 2026-07-21_305 — "Nada fica órfão": fallback ISABELY + ssw_secret_prefix
-- =============================================================================
-- Diretriz Caio 2026-07-21 (pós mig 304):
--   (1) "Nada deve ficar órfão. Todo card sem cadastro de operador via planilha
--       pode ir para a operadora ISABELY." Caso real: Bastão mandou responsável
--       "KAROL" (pessoa fora do Cockpit, ≠ KAROLINE) → card sem dono/invisível.
--   (2) "Logins de entrada no SSW seguem o padrão que todos usam" — a secret de
--       leitura era derivada do NOME do operador; o rename da mig 304 quebrava
--       o vínculo (ISABELY procuraria SSW_INTERNAL_ISABELY_* inexistente).
--       Nova coluna operadores.ssw_secret_prefix desacopla: ISABELY continua na
--       conta padrão SSW_INTERNAL_ISA_E_KAROL_* (a mesma de sempre).
--
-- O que faz:
--   1. operadores.recebe_cards_orfaos (máx. 1, índice único parcial) — lido
--      pelo Path 4 do operador-resolver.ts (fallback_orfao) e pelo trigger.
--   2. operadores.ssw_secret_prefix — lido por loadSswInternalEnvForCard e
--      criar-card-manual (prefixo da secret quando ≠ nome).
--   3. ISABELY: recebe_cards_orfaos=true + ssw_secret_prefix='ISA_E_KAROL'.
--   4. Trigger resolve_assigned_operator_from_name ganha o fallback: nome sem
--      match → operador padrão (assigned + nome canônico no card, senão o
--      INV-038b acusaria texto defasado).
--
-- O fallback NÃO se aplica (curto-circuitos deliberados, preservados):
--   - carteira_dormente (dono existe, fora do Cockpit — NF 568107);
--   - cnpjs_excluidos_cockpit (blacklist);
--   - ambíguo (CNPJ/segmento em 2 operadores — INV-036 acusa, mig resolve).
-- Por isso o card 68f7a557 (NF 2206263, CNPJ 86392529000466 = SAL EXP. TRANSP,
-- blacklisted 2026-06-27 como own-account fora de escopo) fica como está.
--
-- Idempotente. skill: supabase-postgres-best-practices. Guard: INV-038(c) +
-- operador-resolver.test.ts (fallback_orfao).
-- =============================================================================
BEGIN;

ALTER TABLE public.operadores
  ADD COLUMN IF NOT EXISTS recebe_cards_orfaos boolean NOT NULL DEFAULT false;
ALTER TABLE public.operadores
  ADD COLUMN IF NOT EXISTS ssw_secret_prefix text;

COMMENT ON COLUMN public.operadores.recebe_cards_orfaos IS
  'Operador padrão que recebe cards sem dono resolvível (Path 4 fallback_orfao do operador-resolver + trigger). Máx. 1 (índice único). Caio 2026-07-21: nada fica órfão.';
COMMENT ON COLUMN public.operadores.ssw_secret_prefix IS
  'Prefixo da secret SSW_INTERNAL_<PREFIX>_* de leitura quando difere do nome (rename-proof, mig 304/305). NULL = deriva do nome como sempre.';

-- No máximo UM operador-fallback (índice único parcial em expressão constante)
CREATE UNIQUE INDEX IF NOT EXISTS operadores_um_fallback_orfaos
  ON public.operadores ((1)) WHERE recebe_cards_orfaos;

DO $$
DECLARE
  v_isabely uuid := 'f67db0fc-90ca-4df0-bdd2-a985b64d3d1e';
  v_nome text;
  v_n int;
BEGIN
  SELECT nome INTO v_nome FROM public.operadores WHERE id = v_isabely;
  IF v_nome IS DISTINCT FROM 'ISABELY' THEN
    RAISE EXCEPTION 'STOP: operador % deveria ser ISABELY (mig 304), encontrado %', v_isabely, v_nome;
  END IF;

  UPDATE public.operadores
     SET recebe_cards_orfaos = true, ssw_secret_prefix = 'ISA_E_KAROL'
   WHERE id = v_isabely;

  SELECT count(*) INTO v_n FROM public.operadores
   WHERE recebe_cards_orfaos AND ativo AND cockpit_ativo;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'STOP pos-check: esperado exatamente 1 operador-fallback ativo, achado %', v_n;
  END IF;
END $$;

-- Trigger: match por nome (comportamento original) + fallback pro operador
-- padrão quando o nome não casa. Canoniza o texto do card no fallback (senão
-- INV-038b acusa nome defasado). Dispara só quando assigned_operator_id é NULL
-- — nunca sobrescreve dono. responsavel NULL/vazio continua intocado (cards de
-- blacklist/extravio sem responsável NÃO são capturados).
CREATE OR REPLACE FUNCTION public.resolve_assigned_operator_from_name()
RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_fb_id uuid;
  v_fb_nome text;
BEGIN
  IF NEW.assigned_operator_id IS NULL
     AND NEW.responsavel_relacionamento IS NOT NULL
     AND length(trim(NEW.responsavel_relacionamento)) > 0
  THEN
    SELECT id INTO NEW.assigned_operator_id
    FROM public.operadores
    WHERE upper(nome) = upper(trim(NEW.responsavel_relacionamento))
      AND ativo = true
    LIMIT 1;

    -- Fallback "nada fica órfão" (Caio 2026-07-21, mig 305)
    IF NEW.assigned_operator_id IS NULL THEN
      SELECT id, nome INTO v_fb_id, v_fb_nome
      FROM public.operadores
      WHERE recebe_cards_orfaos AND ativo AND cockpit_ativo
      LIMIT 1;
      IF v_fb_id IS NOT NULL THEN
        NEW.assigned_operator_id := v_fb_id;
        NEW.responsavel_relacionamento := v_fb_nome;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;

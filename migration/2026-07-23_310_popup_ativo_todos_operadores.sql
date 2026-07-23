-- 2026-07-23_310 — Popup de divergência ATIVO pra todos os operadores
-- (ordem do Caio 2026-07-23: "quando fizer o merge já quero o popup ativo").
--
-- Semear agora é INERTE em produção: o código do popup só existe na branch;
-- passa a valer no instante do merge+deploy. A tabela continua sendo o
-- kill-switch por operador (DELETE da linha ou ativo=false desliga).
-- Operadores novos: incluir aqui ao onboardar (ou rodar o INSERT de novo).

BEGIN;

INSERT INTO public.popup_divergencia_config (operador_email, ativo)
SELECT lower(o.email), true
FROM public.operadores o
WHERE o.ativo = true
  AND coalesce(o.cockpit_ativo, true) = true
  AND o.email IS NOT NULL
ON CONFLICT (operador_email) DO UPDATE SET ativo = true;

COMMIT;

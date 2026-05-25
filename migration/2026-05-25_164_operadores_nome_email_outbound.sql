-- =============================================================================
-- 2026-05-25_164 — operadores.nome_email_outbound (display name customizado)
--
-- Caio 2026-05-25: DURAFA é nome interno (pra não confundir com o outro Duilio
-- que opera segmento 014). Mas o operador real se chama DUILIO de Deus. Cliente
-- final que recebe email pra segmento 022 (MOTOBIKE) tem que ver "DUILIO" no
-- From, não "DURAFA".
--
-- Solução: coluna opcional `nome_email_outbound` em operadores. Quando setada,
-- prevalece sobre `nome` no header From dos emails outbound. Quando NULL,
-- continua usando `nome` (comportamento atual pra LARISSA, DUILIO ferramentas).
--
-- Aplicado em:
--   - executor/index.ts (caminho principal — aprovação de proposta com email)
--   - responder-email-cliente/index.ts (caminho operador responde manual)
--   - disparar-cobranca-escalonada/index.ts (cobrança automática)
--   - processar-alertas-sla-oc21-oc14/index.ts (alerta gerente)
--
-- skill: supabase-postgres-best-practices
--   - ADD COLUMN nullable (sem default — não força backfill)
--   - Nenhuma constraint nova (campo livre, pode ser qualquer string)
-- =============================================================================

ALTER TABLE public.operadores
  ADD COLUMN IF NOT EXISTS nome_email_outbound text;

COMMENT ON COLUMN public.operadores.nome_email_outbound IS
  'Display name customizado pro header From dos emails outbound. NULL = usa nome (default). Caio 2026-05-25: DURAFA → "DUILIO" porque é a mesma pessoa do segmento 022 (MOTOBIKE), só com identidade separada no Cockpit pra não conflitar com DUILIO ferramentas.';

-- Setar DURAFA → display "DUILIO"
UPDATE public.operadores
SET nome_email_outbound = 'DUILIO'
WHERE nome = 'DURAFA';

-- =============================================================================
-- operadores: colunas pra Evolution API multi-instance
--
-- Caio 2026-05-20: deploy Evolution no Railway. Cada operador tem sua própria
-- instance WhatsApp (= seu próprio número). Nome derivado: op-<slug(nome)>.
--
-- Convenções:
--   - whatsapp_instance:    nome da instance na Evolution (NULL = não criado)
--   - whatsapp_status:      última leitura do connectionState
--                           ('open'=pareado, 'connecting'=QR pendente,
--                            'close'=desconectado, NULL=nunca tentou)
--   - whatsapp_numero:      MSISDN normalizado retornado pela Evolution após
--                           pareamento (`5535999990000`). Auditoria/UI.
--   - whatsapp_synced_at:   timestamp do último connectionState lido. Operadores
--                           com >24h sem sync ganham banner de "reconectar".
--
-- RLS já existente em operadores cobre estas colunas — sem mudança de policy.
-- =============================================================================

ALTER TABLE public.operadores
  ADD COLUMN IF NOT EXISTS whatsapp_instance  text UNIQUE,
  ADD COLUMN IF NOT EXISTS whatsapp_status    text,
  ADD COLUMN IF NOT EXISTS whatsapp_numero    text,
  ADD COLUMN IF NOT EXISTS whatsapp_synced_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_operadores_whatsapp_instance
  ON public.operadores(whatsapp_instance)
  WHERE whatsapp_instance IS NOT NULL;

COMMENT ON COLUMN public.operadores.whatsapp_instance IS
  'Nome da instance Evolution API (formato: op-<slug>). UNIQUE pra evitar colisão.';
COMMENT ON COLUMN public.operadores.whatsapp_status IS
  'Estado do pareamento: open | connecting | close | error | NULL (nunca pareado)';

-- ============================================================================
-- Cockpit v2 — FK física entre cards.cod_ultima_ocorrencia e
-- ocorrencias_dicionario.codigo
-- Data: 2026-04-29
--
-- Motivo: Supabase Auto-Relationships do PostgREST precisa de FK pra resolver
-- JOINs declarativos do tipo `select('*, ocorrencia:ocorrencias_dicionario(...)')`.
-- Sem FK, Lovable / supabase-js retorna "could not find a relationship" e
-- a Inbox quebra com "ERRO AO CARREGAR CARDS".
--
-- DEFERRABLE INITIALLY DEFERRED: durante uma transação, sync-bastao pode
-- inserir cards com cod_ultima_ocorrencia novo enquanto popula o dicionário —
-- a checagem só acontece no COMMIT. Hoje o dicionário é estático (58 códigos
-- da planilha), então é cinto + suspensório, mas custa nada.
-- ============================================================================

ALTER TABLE public.cards
  ADD CONSTRAINT cards_cod_ultima_ocorrencia_fkey
  FOREIGN KEY (cod_ultima_ocorrencia)
  REFERENCES public.ocorrencias_dicionario(codigo)
  ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED;

-- =============================================================================
-- 2026-05-27_176 — Fix ENTREGA_PARCIAL_APOS_FALTA_VOLUME: remove "sem
-- notificação prévia" do corpo (fato incorreto — a entrega parcial é sempre
-- precedida de notificação).
--
-- Caio 2026-05-27 (citação direta): "Alem disso nao precisamos colocar em
-- nenhum lugar que A ENTREGA PARCIAL SEM NOTIFICAÇÃO PREVIA.. ISSO É ERRADO."
--
-- Texto antigo (mig 170):
--   "Identificamos que a NF {nf} seguiu em entrega parcial SEM NOTIFICAÇÃO
--    PRÉVIA e foi recusada no destino por falta de volume(s)."
--
-- Texto novo:
--   "Identificamos que a NF {nf} foi entregue parcialmente, com recusa de
--    parte da carga no destino por falta de volume(s)."
--
-- Mantém o mesmo ID/assunto. Apenas corrige o corpo.
-- =============================================================================

UPDATE public.templates_email
SET
  corpo_template = $$Olá {primeiro_nome},

Identificamos que a NF {nf} foi entregue parcialmente, com recusa de parte da carga no destino por falta de volume(s).

A evidência registrada pelo motorista pode ser acessada no link: {link_evidencia}

Caso deseje, podemos compartilhar informações detalhadas da recusa (motivo registrado pelo destinatário, ressalva e demais comprovantes) pra avaliar a melhor tratativa.

Ficamos no aguardo de sua orientação: seguir com a devolução, nova tentativa de entrega ou aguardar novas instruções?

{operadora_nome}
Sal Express — Relacionamento$$,
  updated_at = now()
WHERE id = 'ENTREGA_PARCIAL_APOS_FALTA_VOLUME';

-- =============================================================================
-- 2026-05-27_177 — Fix ENTREGA_PARCIAL_APOS_FALTA_VOLUME: remove
-- "por falta de volume(s)" hardcoded do corpo.
--
-- Caio 2026-05-27 (NF 182149 CARLOS): recusa parcial pode ter VÁRIOS motivos
-- (acordo com remetente, divergência produto, qualidade, retirada parcial
-- combinada, etc) — não só "falta de volume". Texto antigo assumia falta
-- de volume sempre.
--
-- Texto antigo: "com recusa de parte da carga no destino POR FALTA DE VOLUME(S)"
-- Texto novo: "com recusa de parte da carga no destino" (sem assumir motivo)
--
-- A ressalva real (interpretada pela IA Vision da foto) já vai no email
-- via {motivo_extraido}, deixando claro pro cliente o que aconteceu.
-- =============================================================================

UPDATE public.templates_email
SET
  corpo_template = $$Olá {primeiro_nome},

Identificamos que a NF {nf} foi entregue parcialmente, com recusa de parte da carga no destino.

A evidência registrada pelo motorista pode ser acessada no link: {link_evidencia}

Caso deseje, podemos compartilhar informações detalhadas da recusa (motivo registrado pelo destinatário, ressalva e demais comprovantes) pra avaliar a melhor tratativa.

Ficamos no aguardo de sua orientação: seguir com a devolução, nova tentativa de entrega ou aguardar novas instruções?

{operadora_nome}
Sal Express — Relacionamento$$,
  updated_at = now()
WHERE id = 'ENTREGA_PARCIAL_APOS_FALTA_VOLUME';

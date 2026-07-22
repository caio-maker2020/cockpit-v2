-- ============================================================================
-- Cockpit v2 — Template EXTRAVIO_PARCIAL_DEVOLVER_PEDIR_ROMANEIO
-- Data: 2026-07-13 (Caio — separação 54/59, Bloco 5: combo 44+59)
-- skill: supabase-postgres-best-practices
--
-- Contexto: extravio PARCIAL em que o cliente respondeu a tratativa (oc 54)
-- escolhendo DEVOLVER. O combo 44+59 lança:
--   - oc 44 (devolução) dos volumes que PERMANECERAM CONOSCO (não extraviados);
--   - oc 59 (RETORNO INDENIZAÇÃO) + este e-mail, pedindo romaneio/valor/descrição
--     dos volumes EXTRAVIADOS pra abrir o ressarcimento.
--
-- Nenhum template existente encaixa (EXTRAVIO_TOTAL diz "todos extraviados";
-- ENTREGUE_COM_FALTA diz "realizamos a entrega"; EXTRAVIO_PARCIAL é pré-decisão
-- "seguir ou devolver?"). Texto validado pelo Caio (2026-07-13), no mesmo tom
-- dos irmãos (prosa corrida, sem lista, fecho "Ficamos no aguardo. Obrigado!").
--
-- Variáveis: {primeiro_nome}, {nf}, {n_volumes_falta}, {operadora_nome}
--
-- skill checklist:
--   - UPSERT idempotente (ON CONFLICT DO UPDATE) ✓
--   - templates_email PK 'id' text, sem FK ✓ (espelha mig 182)
-- ============================================================================

INSERT INTO public.templates_email (id, nome, descricao, assunto, corpo_template, variaveis_esperadas, ativo)
VALUES (
  'EXTRAVIO_PARCIAL_DEVOLVER_PEDIR_ROMANEIO',
  'Extravio parcial — devolução + pedir romaneio (indenização)',
  'Caio 2026-07-13 (separação 54/59, combo 44+59): cliente escolheu DEVOLVER num extravio parcial. Confirma a devolução dos volumes que ficaram conosco (via logística reversa) e pede romaneio/valor/descrição dos extraviados pra abrir o ressarcimento (oc 59).',
  'Devolução dos volumes — NF {nf}',
$body$Olá {primeiro_nome},

Conforme sua orientação, vamos providenciar a devolução dos volumes que permaneceram conosco da NF {nf}. O retorno segue dentro do prazo da nossa logística reversa.

Para darmos sequência ao ressarcimento dos {n_volumes_falta} volume(s) extraviado(s), gentileza encaminhar o romaneio de coleta assinado da NF, o valor e a descrição dos itens a serem indenizados.

Assim que recebermos, abrimos o processo de ressarcimento internamente.

Ficamos no aguardo. Obrigado!

{operadora_nome} Sal Express — Relacionamento$body$,
  ARRAY['primeiro_nome','nf','n_volumes_falta','operadora_nome'],
  true
)
ON CONFLICT (id) DO UPDATE
  SET nome = EXCLUDED.nome,
      descricao = EXCLUDED.descricao,
      assunto = EXCLUDED.assunto,
      corpo_template = EXCLUDED.corpo_template,
      variaveis_esperadas = EXCLUDED.variaveis_esperadas,
      ativo = EXCLUDED.ativo,
      updated_at = now();

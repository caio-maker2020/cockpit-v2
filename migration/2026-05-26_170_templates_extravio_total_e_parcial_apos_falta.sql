-- =============================================================================
-- 2026-05-26_170 — Templates v2: FALTA_DE_VOLUME_TOTAL + ENTREGA_PARCIAL_APOS_FALTA_VOLUME
--
-- Caio 2026-05-26: complementa mig 169. Cria 2 cenários adicionais que Larissa
-- destacou nas "Observações finais" do documento Templates-Email-Tratativa-Entrega.docx.
--
-- 1. FALTA_DE_VOLUME_TOTAL — variante TOTAL do FALTA_DE_VOLUME (Resposta 2 do
--    Template 1 original). Usado quando TODA a carga foi extraviada (não só
--    alguns volumes). Distinção é critica: pra parcial, sugere entrega parcial
--    + ressalva; pra total, sugere reposição imediata + devolução automática
--    quando localizar.
--
-- 2. ENTREGA_PARCIAL_APOS_FALTA_VOLUME — caso descrito por Larissa: entrega que
--    seguiu de forma parcial SEM notificação prévia ao cliente nem ao gestor,
--    e foi recusada no destino por falta de volume. Texto pergunta se cliente
--    quer informações detalhadas da recusa.
--
-- Agente IA agora escolhe entre essas variantes com base em palavras-chave no
-- motivo extraído (heurística textual em agente-sugere-ocs-padrao/index.ts).
--
-- skill: supabase-postgres-best-practices
--   - INSERT idempotente via ON CONFLICT (id) DO UPDATE
--   - Variáveis esperadas em ARRAY pra validação no template renderer
-- =============================================================================

-- Template 6: FALTA_DE_VOLUME_TOTAL (extravio total)
INSERT INTO public.templates_email (id, nome, descricao, assunto, corpo_template, variaveis_esperadas, ativo)
VALUES (
  'FALTA_DE_VOLUME_TOTAL',
  'Extravio Total',
  'Variante do FALTA_DE_VOLUME para casos onde TODA a carga foi extraviada (não só alguns volumes). Sugere reposição imediata + devolução automática se localizar.',
  'Extravio Total — NF {nf}',
  $$Olá {primeiro_nome},

Gostaríamos de informar o extravio total referente à NF {nf}. As buscas internas já foram iniciadas para localização dos volumes.

Para evitar impactos junto ao cliente, orientamos o envio de um novo pedido de reposição. Caso os volumes sejam localizados posteriormente, seguiremos automaticamente com a devolução dos mesmos, de forma isenta.

Seguimos acompanhando o caso com prioridade e permanecemos à disposição.

{operadora_nome}
Sal Express — Relacionamento$$,
  ARRAY['primeiro_nome','nf','operadora_nome'],
  true
)
ON CONFLICT (id) DO UPDATE SET
  assunto = EXCLUDED.assunto,
  corpo_template = EXCLUDED.corpo_template,
  variaveis_esperadas = EXCLUDED.variaveis_esperadas,
  ativo = EXCLUDED.ativo,
  updated_at = now();


-- Template 7: ENTREGA_PARCIAL_APOS_FALTA_VOLUME
-- Caso Larissa 2026-05-26: entrega seguiu parcial sem notificação prévia,
-- foi recusada por falta de volume. Pergunta se cliente quer info detalhada
-- da recusa.
INSERT INTO public.templates_email (id, nome, descricao, assunto, corpo_template, variaveis_esperadas, ativo)
VALUES (
  'ENTREGA_PARCIAL_APOS_FALTA_VOLUME',
  'Entrega Parcial após falta de volume',
  'Entrega que seguiu parcial sem notificação prévia ao cliente nem ao gestor, e foi recusada no destino por falta de volume. Oferece detalhes da recusa.',
  'Recusa após entrega parcial — NF {nf}',
  $$Olá {primeiro_nome},

Identificamos que a NF {nf} seguiu em entrega parcial sem notificação prévia e foi recusada no destino por falta de volume(s).

A evidência registrada pelo motorista pode ser acessada no link: {link_evidencia}

Caso deseje, podemos compartilhar informações detalhadas da recusa (motivo registrado pelo destinatário, ressalva e demais comprovantes) pra avaliar a melhor tratativa.

Ficamos no aguardo de sua orientação: seguir com a devolução, nova tentativa de entrega ou aguardar novas instruções?

{operadora_nome}
Sal Express — Relacionamento$$,
  ARRAY['primeiro_nome','nf','operadora_nome','link_evidencia'],
  true
)
ON CONFLICT (id) DO UPDATE SET
  assunto = EXCLUDED.assunto,
  corpo_template = EXCLUDED.corpo_template,
  variaveis_esperadas = EXCLUDED.variaveis_esperadas,
  ativo = EXCLUDED.ativo,
  updated_at = now();

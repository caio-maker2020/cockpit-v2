-- ============================================================================
-- Cockpit v2 — Templates EXTRAVIO_PARCIAL + EXTRAVIO_TOTAL_PEDIR_ROMANEIO
-- Data: 2026-05-29
-- skill: supabase-postgres-best-practices
--
-- Usados pelo agente-sugere-ocs-padrao em oc=49 Caso 1 (extravio não
-- localizado pelo time de perdas):
--   - PARCIAL: localizamos parte; cliente decide entre seguir parcial ou devolver
--   - TOTAL: tudo perdido; pedimos romaneio assinado pra dar continuidade
--
-- Variáveis:
--   - {primeiro_nome}, {nf}, {qtde_volumes}, {n_volumes_falta}, {operadora_nome}
--   - PARCIAL usa todas; TOTAL não usa {n_volumes_falta} nem {qtde_volumes}
--
-- skill checklist:
--   - UPSERT idempotente (ON CONFLICT DO UPDATE) ✓
--   - templates_email tem PK 'id' text, sem FK em outras tabelas ✓
-- ============================================================================

INSERT INTO public.templates_email (id, nome, descricao, assunto, corpo_template, variaveis_esperadas, ativo)
VALUES (
  'EXTRAVIO_PARCIAL',
  'Extravio parcial — solicitar tratativa',
  'Caio 2026-05-29: quando time de perdas devolve oc=49 sinalizando que parte dos volumes da NF está extraviada e não foi localizada no prazo. Cliente decide entre seguir entrega parcial OU devolver tudo.',
  'Extravio parcial — NF {nf}',
$body$Olá {primeiro_nome},

Identificamos que durante o transporte da NF {nf} houve extravio de {n_volumes_falta} de {qtde_volumes} volumes. Localizamos o restante.

Para prosseguirmos, poderia nos orientar:
(a) seguir com a entrega parcial dos volumes localizados, OU
(b) realizar a devolução total?

Ressaltamos que poderão ser aplicadas cobranças de armazenagem caso aguardemos retorno por longo período.

Atenciosamente,
{operadora_nome}
Sal Express — Relacionamento$body$,
  ARRAY['primeiro_nome','nf','n_volumes_falta','qtde_volumes','operadora_nome'],
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

INSERT INTO public.templates_email (id, nome, descricao, assunto, corpo_template, variaveis_esperadas, ativo)
VALUES (
  'EXTRAVIO_TOTAL_PEDIR_ROMANEIO',
  'Extravio total — pedir romaneio assinado',
  'Caio 2026-05-29: quando time de perdas devolve oc=49 sinalizando extravio TOTAL da NF. Pede romaneio assinado pra dar continuidade ao processo de indenização.',
  'Extravio total — NF {nf}',
$body$Olá {primeiro_nome},

Lamentamos informar que todos os volumes da NF {nf} foram extraviados durante o transporte e não foram localizados dentro do prazo padrão de busca.

Para darmos continuidade ao processo de indenização, solicitamos o envio do romaneio assinado e demais documentos pertinentes.

Ficamos à disposição para esclarecimentos.

Atenciosamente,
{operadora_nome}
Sal Express — Relacionamento$body$,
  ARRAY['primeiro_nome','nf','operadora_nome'],
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

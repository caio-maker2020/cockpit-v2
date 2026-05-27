-- =============================================================================
-- 2026-05-27_173 — Templates email v3 (revisão Caio + template novo oc=19)
--
-- Documento fonte: ~/Downloads/Templates email cockpit atualziado.docx
-- Mudanças:
--   1. FALTA_DE_VOLUME — texto ligeiramente reescrito (parcial)
--   2. FALTA_DE_VOLUME_TOTAL — adicionado pedido de romaneio assinado
--   3. RECUSA_TOTAL — "aguardar novas instruções" → "seguir para reentrega"
--   4. RECUSA_PARCIAL — simplificado pra "podemos seguir para a devolução"
--   5. PROBLEMAS_COM_ENDERECO — mantém igual (já estava OK)
--   6. NOVO: ENTREGUE_COM_FALTA_PEDIR_ROMANEIO — gatilho oc=19 isolada (NF
--      entregue com falta, cliente já autorizou parcial, pedir romaneio +
--      descrição pra futuro oc=33 ressarcimento)
--
-- IMPORTANTE: gatilhos mudam (no agente-sugere-ocs-padrao, fora desta mig):
--   - FALTA_DE_VOLUME: agora gatilho é oc=49 + instrução "PRAZO DE PERDAS/
--     LOCALIZAÇÃO EXPIRADO" (NÃO oc=19 mais)
--   - ENTREGUE_COM_FALTA_PEDIR_ROMANEIO: gatilho oc=19 isolada
--   - FALTA_DE_VOLUME_TOTAL: operador escolhe no dropdown a partir do default
--     PARCIAL (sem heurística textual no agente)
-- =============================================================================

-- 1. FALTA_DE_VOLUME (parcial) — texto final v3
UPDATE public.templates_email
SET
  assunto = 'Extravio Parcial — NF {nf}',
  corpo_template = $$Olá {primeiro_nome},

Gostaria de informar o extravio de {n_volumes_falta} volume(s) referente(s) à NF {nf}.

Podemos seguir com a entrega parcial, coletando a ressalva junto ao destinatário, e posteriormente compartilhar com vocês para a emissão de um novo pedido referente aos volumes faltantes. Caso os volumes sejam localizados, seguiremos com a devolução isenta. Ou, se preferirem, seguir com a devolução dos volumes atualmente em nossa posse?

Ficamos no aguardo de sua orientação para prosseguirmos.

{operadora_nome}
Sal Express — Relacionamento$$,
  variaveis_esperadas = ARRAY['primeiro_nome','nf','n_volumes_falta','operadora_nome'],
  ativo = true,
  updated_at = now()
WHERE id = 'FALTA_DE_VOLUME';


-- 2. FALTA_DE_VOLUME_TOTAL — adiciona pedido de romaneio
UPDATE public.templates_email
SET
  assunto = 'Extravio Total — NF {nf}',
  corpo_template = $$Olá {primeiro_nome},

Gostaríamos de informar o extravio total referente à NF {nf}. As buscas internas já foram concluídas e os volumes não foram localizados.

Para evitar impactos junto ao cliente, orientamos o envio de um novo pedido de reposição. Caso os volumes sejam localizados posteriormente, seguiremos automaticamente com a devolução dos mesmos, de forma isenta.

Poderiam, por favor, nos enviar o romaneio de coleta assinado da NF?

Seguimos acompanhando o caso com prioridade e permanecemos à disposição.

{operadora_nome}
Sal Express — Relacionamento$$,
  variaveis_esperadas = ARRAY['primeiro_nome','nf','operadora_nome'],
  ativo = true,
  updated_at = now()
WHERE id = 'FALTA_DE_VOLUME_TOTAL';


-- 3. RECUSA_TOTAL — "aguardar instruções" → "seguir para reentrega"
UPDATE public.templates_email
SET
  assunto = 'Recusa Total — NF {nf}',
  corpo_template = $$Olá {primeiro_nome},

Ao realizarmos a tentativa de entrega referente à NF {nf}, o cliente recusou integralmente a carga.

A evidência registrada pelo motorista pode ser acessada no link: {link_evidencia}

Para darmos continuidade, poderia, por gentileza, nos orientar quanto à tratativa: seguir com a devolução ou seguir para reentrega?

Ressaltamos que poderão ser aplicadas cobranças de armazenagem.

Ficamos no aguardo para prosseguirmos.

{operadora_nome}
Sal Express — Relacionamento$$,
  variaveis_esperadas = ARRAY['primeiro_nome','nf','operadora_nome','link_evidencia'],
  ativo = true,
  updated_at = now()
WHERE id = 'RECUSA_TOTAL';


-- 4. RECUSA_PARCIAL — simplifica "podemos seguir para a devolução"
UPDATE public.templates_email
SET
  assunto = 'Recusa Parcial — NF {nf}',
  corpo_template = $$Olá {primeiro_nome},

Ao realizarmos a tentativa de entrega referente à NF {nf}, o cliente recusou parte da carga.

A evidência registrada pelo motorista pode ser acessada no link: {link_evidencia}

Para darmos continuidade, poderia, por gentileza, nos orientar se podemos seguir para a devolução?

Ressaltamos que poderão ser aplicadas cobranças de armazenagem.

Ficamos no aguardo para prosseguirmos.

{operadora_nome}
Sal Express — Relacionamento$$,
  variaveis_esperadas = ARRAY['primeiro_nome','nf','operadora_nome','link_evidencia'],
  ativo = true,
  updated_at = now()
WHERE id = 'RECUSA_PARCIAL';


-- 5. ENTREGUE_COM_FALTA_PEDIR_ROMANEIO (NOVO) — gatilho oc=19 isolada
INSERT INTO public.templates_email (id, nome, descricao, assunto, corpo_template, variaveis_esperadas, ativo)
VALUES (
  'ENTREGUE_COM_FALTA_PEDIR_ROMANEIO',
  'Entregue com falta — pedir romaneio',
  'NF entregue parcial (cliente autorizou anteriormente). Pede romaneio assinado + descrição/valor dos itens faltantes pra abrir processo de ressarcimento (futuro oc=33).',
  'Entrega parcial concluída — NF {nf}',
  $$Olá {primeiro_nome},

Realizamos a entrega da NF {nf} no destino final com falta de {n_volumes_falta} volume(s). A ressalva foi coletada junto ao destinatário no momento da entrega.

A evidência registrada pode ser acessada no link: {link_evidencia}

Para darmos sequência ao processo de ressarcimento dos volumes faltantes, gentileza encaminhar o romaneio de coleta assinado da NF e a descrição/valor dos itens faltantes.

Assim que recebermos, abrimos o processo de ressarcimento internamente.

Ficamos no aguardo.

{operadora_nome}
Sal Express — Relacionamento$$,
  ARRAY['primeiro_nome','nf','n_volumes_falta','operadora_nome','link_evidencia'],
  true
)
ON CONFLICT (id) DO UPDATE SET
  assunto = EXCLUDED.assunto,
  corpo_template = EXCLUDED.corpo_template,
  variaveis_esperadas = EXCLUDED.variaveis_esperadas,
  ativo = EXCLUDED.ativo,
  updated_at = now();

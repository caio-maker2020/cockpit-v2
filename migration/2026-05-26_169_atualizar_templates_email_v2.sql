-- =============================================================================
-- 2026-05-26_169 — Atualiza templates de email com textos finais do Caio
--
-- Documento fonte: Templates-Email-Tratativa-Entrega.docx
-- 5 templates fixos + assinatura padrão. Usados por TODOS os operadores
-- (LARISSA, DUILIO, DURAFA, futuros) — fromName resolvido em runtime via
-- operadores.nome_email_outbound (mig 164).
--
-- Operador continua podendo EDITAR antes de enviar via texto_email_customizado
-- nos extras da aprovação — Cockpit usa o texto editado como prioridade.
--
-- skill: supabase-postgres-best-practices
--   - UPDATE com WHERE id explícito (sem risco de side-effects)
--   - Cada template inclui variaveis_esperadas atualizado
--   - COBRANCA_LEMBRETE_4DIAS + COBRANCA_LEMBRETE_8DIAS criadas como novos rows
-- =============================================================================

-- Template 1: FALTA_DE_VOLUME (versão Extravio Parcial — versão A do documento)
-- Versão B (Extravio Total) NÃO criada como template separado por ora — agente IA
-- usa só FALTA_DE_VOLUME. Caio pode pedir FALTA_DE_VOLUME_TOTAL depois.
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
  ativo = true
WHERE id = 'FALTA_DE_VOLUME';


-- Template 2: PROBLEMAS_COM_ENDERECO (oc=11 — endereço divergente)
UPDATE public.templates_email
SET
  assunto = 'Insucesso na entrega — NF {nf}',
  corpo_template = $$Olá {primeiro_nome},

Ao realizarmos a tentativa de entrega referente à NF {nf}, não foi possível localizar o endereço informado. Poderia confirmar se o endereço está correto?

Segue evidência registrada pelo motorista, que pode ser acessada através do link: {link_evidencia}

Para darmos continuidade com a entrega, poderia, por gentileza, confirmar/corrigir os dados de endereço? Caso necessário, solicitamos também o envio de uma CCe.

Ficamos no aguardo de sua orientação para prosseguirmos com a reentrega o quanto antes.

{operadora_nome}
Sal Express — Relacionamento$$,
  variaveis_esperadas = ARRAY['primeiro_nome','nf','operadora_nome','link_evidencia'],
  ativo = true
WHERE id = 'PROBLEMAS_COM_ENDERECO';


-- Template 3: RECUSA_TOTAL (oc=10 — cliente recusou tudo)
UPDATE public.templates_email
SET
  assunto = 'Recusa Total — NF {nf}',
  corpo_template = $$Olá {primeiro_nome},

Ao realizarmos a tentativa de entrega referente à NF {nf}, o cliente recusou integralmente a carga.

A evidência registrada pelo motorista pode ser acessada no link: {link_evidencia}

Para darmos continuidade, poderia, por gentileza, nos orientar quanto à tratativa: seguir com a devolução ou aguardar novas instruções?

Ressaltamos que poderão ser aplicadas cobranças de armazenagem.

Ficamos no aguardo para prosseguirmos.

{operadora_nome}
Sal Express — Relacionamento$$,
  variaveis_esperadas = ARRAY['primeiro_nome','nf','operadora_nome','link_evidencia'],
  ativo = true
WHERE id = 'RECUSA_TOTAL';


-- Template 4: RECUSA_PARCIAL (oc=35 — recusa de parte da carga)
UPDATE public.templates_email
SET
  assunto = 'Recusa Parcial — NF {nf}',
  corpo_template = $$Olá {primeiro_nome},

Ao realizarmos a tentativa de entrega referente à NF {nf}, o cliente recusou parte da carga.

A evidência registrada pelo motorista pode ser acessada no link: {link_evidencia}

Para darmos continuidade, poderia, por gentileza, nos orientar quanto à tratativa: seguir com a devolução ou aguardar novas instruções?

Ressaltamos que poderão ser aplicadas cobranças de armazenagem.

Ficamos no aguardo para prosseguirmos.

{operadora_nome}
Sal Express — Relacionamento$$,
  variaveis_esperadas = ARRAY['primeiro_nome','nf','operadora_nome','link_evidencia'],
  ativo = true
WHERE id = 'RECUSA_PARCIAL';


-- Template 5A: COBRANCA_LEMBRETE_4DIAS (primeira cobrança — 4 dias sem resposta)
INSERT INTO public.templates_email (id, nome, descricao, assunto, corpo_template, variaveis_esperadas, ativo)
VALUES (
  'COBRANCA_LEMBRETE_4DIAS',
  'Cobrança 4 dias',
  'Primeira cobrança ao cliente que não respondeu em 4 dias. Mantém assunto da thread original.',
  'Aguardando retorno — NF {nf}',
  $$Olá {primeiro_nome},

Conforme comunicado anterior, registramos uma ocorrência na tentativa de entrega referente à NF {nf}. Até o momento, já se passaram 4 dias desde a nossa notificação, e seguimos no aguardo de sua orientação para continuidade.

Ressaltamos que poderão ser aplicadas cobranças de armazenagem.

A evidência registrada pelo motorista pode ser acessada no link: {link_evidencia}

Pedimos, por gentileza, seu retorno para que possamos prosseguir com a tratativa.

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


-- Template 5B: COBRANCA_LEMBRETE_8DIAS (segunda cobrança — 8 dias, aplicação efetiva)
INSERT INTO public.templates_email (id, nome, descricao, assunto, corpo_template, variaveis_esperadas, ativo)
VALUES (
  'COBRANCA_LEMBRETE_8DIAS',
  'Cobrança 8 dias (final)',
  'Segunda cobrança ao cliente que não respondeu em 8 dias. Informa que armazenagem passa a ser aplicada.',
  'Aviso de cobrança de armazenagem — NF {nf}',
  $$Olá {primeiro_nome},

Conforme comunicado anterior, registramos uma ocorrência na tentativa de entrega referente à NF {nf}. Após 4 dias, realizamos a notificação sobre a possibilidade de cobrança de armazenagem e, neste momento, já se passaram 8 dias sem retorno para definição.

Dessa forma, informamos que a cobrança de armazenagem passa a ser aplicada a partir de agora e será faturada ao final do desfecho da ocorrência, seja no momento da devolução ou da entrega efetiva.

A evidência registrada pelo motorista pode ser acessada no link: {link_evidencia}

Reforçamos a necessidade de seu retorno para prosseguirmos com a tratativa.

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


-- Mantém COBRANCA_LEMBRETE antigo (se existir) apontando pro 4DIAS pra
-- compatibilidade — qualquer caller legado continua funcionando.
INSERT INTO public.templates_email (id, nome, descricao, assunto, corpo_template, variaveis_esperadas, ativo)
SELECT 'COBRANCA_LEMBRETE', 'Cobrança (alias 4 dias)', 'Alias do COBRANCA_LEMBRETE_4DIAS pra compat',
  assunto, corpo_template, variaveis_esperadas, true
FROM public.templates_email WHERE id = 'COBRANCA_LEMBRETE_4DIAS'
ON CONFLICT (id) DO UPDATE SET
  assunto = EXCLUDED.assunto,
  corpo_template = EXCLUDED.corpo_template,
  variaveis_esperadas = EXCLUDED.variaveis_esperadas,
  ativo = EXCLUDED.ativo,
  updated_at = now();

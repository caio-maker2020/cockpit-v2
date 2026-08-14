-- ============================================================================
-- Cockpit v2 — R1 Würth ganha E-MAIL: devolução por silêncio agora NOTIFICA
-- Data: 2026-08-14 (Caio, na sequência da mig 341)
--
-- Pedido do Caio: além de sugerir a oc 44 pelos 10 dias de silêncio, enviar
-- e-mail à Würth sinalizando que, pela falta de retorno, a devolução seguirá.
-- O e-mail vai NA MESMA THREAD do e-mail já enviado (que ficou sem resposta)
-- e pro MESMO destinatário — o executor já continua a thread da tratativa por
-- padrão (carregarThreadDaTratativaAtual + In-Reply-To); o robô semeia
-- args.email_destino com o to_email do último outbound do card.
-- Fallback (caso real NF 677019 — 54 lançada por fora, sem e-mail no Cockpit):
-- sem outbound anterior → destinatário do cadastro (resolver padrão) + thread
-- nova. O modal SEMPRE mostra o destinatário pra Ingrid conferir.
-- ============================================================================

INSERT INTO public.templates_email (id, nome, descricao, assunto, corpo_template, variaveis_esperadas, ativo)
VALUES (
  'WURTH_DEVOLUCAO_SEM_RETORNO',
  'Würth — devolução por falta de retorno (10 dias)',
  'R1 Würth (Caio 2026-08-14): oc 11 notificada (54 + intranet) e 10 dias corridos sem NENHUM retorno → devolução autorizada por processo. E-mail informativo enviado na mesma thread da notificação original.',
  'Devolução por falta de retorno — NF {nf} — {empresa}',
  E'Olá, {primeiro_nome}!\n\nNotificamos anteriormente a dificuldade na entrega referente à NF {nf} (problema com endereço) e seguimos aguardando orientação.\n\nDecorridos 10 dias sem retorno — por e-mail ou pela intranet —, conforme o processo acordado, a devolução da mercadoria está autorizada e seguirá o prazo de logística reversa.\n\nQualquer informação adicional, estamos à disposição.\n\nObrigado!\n\n{operadora_nome} Sal Express — Relacionamento',
  ARRAY['primeiro_nome', 'nf', 'empresa', 'operadora_nome']::text[],
  true
)
ON CONFLICT (id) DO NOTHING;

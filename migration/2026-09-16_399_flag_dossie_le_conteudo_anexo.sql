-- ============================================================================
-- 399 — Carlos 2026-09-16: o interpretador passa a ABRIR o conteúdo dos anexos
-- do cliente (PDF, JPG/JPEG e PNG) para achar descrição e valor dos itens, e
-- passa a enxergar anexo de mensagem ANTERIOR do mesmo card.
--
-- CAUSA RAIZ: interpretador-resposta-cliente/index.ts entregava ao modelo só
-- "filename, mime_type, size_bytes" e filtrava pela mensagem atual
-- (.eq("message_inbox_id", body.message_id)). Resultado: descrição e valor só
-- eram reconhecidos quando ESCRITOS NO CORPO do e-mail; dentro de um arquivo
-- ficavam ausentes, o dossiê ficava incompleto, o to-do nascia com
-- proposta_payload.meta.gate_oc33.bloqueada = true e a trava da RPC
-- aprovar_e_executar recusava a oc 33 (OC33_DOSSIE_INCOMPLETO). A operadora
-- via isso como botão cinza.
--
-- MEDIDO EM 15/09: 737 cards extravio parcial caso 1 com dossiê incompleto;
-- 679 travados por descrição ou valor; 514 com anexo inbound no card; 136 com
-- romaneio já validado E arquivo legível vivo no balde (a primeira leva).
-- ÂNCORA: NF 431734 — o PDF "NFE-433174 (1).pdf" (NF de ressarcimento, tem o
-- valor) chegou em 2026-08-07; a resposta reprocessada em 2026-09-10 só trouxe
-- PNGs; o valor segue presente=false.
--
-- ESTA MIGRATION NÃO MUDA COMPORTAMENTO NENHUM. A chave nasce FALSE e o
-- interpretador segue exatamente como hoje — mesma consulta, mesmo prompt,
-- mesma chamada, mesmo texto no SSW. O flip é um UPDATE SEPARADO (TIPO B, com
-- --autorizado-por) depois da janela de observação e da amostra conferida.
--
-- NÃO AFROUXA NADA: a trava da oc 33 continua existindo e a exigência das três
-- provas (romaneio + descrição + valor) fica intacta. Não existe botão de
-- "lançar mesmo assim". Se o agente abrir o arquivo e NÃO achar a informação,
-- ela continua FALTANDO e a Sal segue cobrando o cliente — ordem expressa do
-- Carlos em 15/09.
--
-- NÃO ENCOSTA no seed do romaneio (seed_romaneio_v2_enabled, em medição de
-- sombra desde 04/09): por código, a leitura de arquivo só pode marcar
-- descrição e valor, nunca romaneio.
--
-- skill supabase-postgres-best-practices: INSERT idempotente em tabela de
-- CONFIGURAÇÃO. Sem DDL, sem índice novo, sem função, sem SECURITY DEFINER,
-- RLS inalterada. Não há risco de lock: uma linha, ON CONFLICT DO NOTHING.
--
-- TIPO A (aditiva, reversível, nasce desligada).
-- Rollback: DELETE FROM public.feature_flags WHERE key = 'dossie_le_conteudo_anexo_enabled';
--
-- Ver ADR 0029 e INV-154.
-- ============================================================================
INSERT INTO public.feature_flags (key, enabled, description)
VALUES (
  'dossie_le_conteudo_anexo_enabled',
  false,
  'Extravio parcial caso 1: o interpretador ABRE o conteudo dos anexos do cliente (PDF/JPG/PNG; teto de 6 arquivos, 2 PDFs, 12MB somados; piso de 20KB por imagem) para achar DESCRICAO e VALOR dos itens, e enxerga anexo de mensagem ANTERIOR do card. NAO le romaneio (isso e do seed deterministico) e NAO muda oc_sugerida. OFF = comportamento de hoje, byte a byte. Ancora NF 431734. Ver ADR 0029 e INV-154.'
)
ON CONFLICT (key) DO NOTHING;

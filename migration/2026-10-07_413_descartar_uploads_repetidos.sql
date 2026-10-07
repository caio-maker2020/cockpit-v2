-- =============================================================================
-- 2026-10-07_413_descartar_uploads_repetidos.sql
--
-- Carlos 07/10 (NF 941225): a oc 33 da NF 941225 não subia nem a 1ª página —
-- "Limite de 20 anexos enviados por você neste card". As 20 vagas
-- (`_shared/limite-anexos.ts`) estavam ocupadas por CÓPIAS: os modais da oc 33
-- sobem todas as páginas do PDF convertido a cada clique em Confirmar, antes
-- do `aprovar_e_executar`; cada recusa da parede (mig 365) deixava as páginas
-- pendentes e o clique seguinte subia outra cópia. 4 cliques em 27/08 + 1 em
-- 28/09 = 20 registros de só 6 arquivos distintos. A rotina de limpeza de 24h
-- (`cleanup_email_anexos_orfaos`, mig 063) nunca foi agendada (mig 373) — e
-- NÃO deve ser ligada: ela não filtra origem e apagaria anexo do cliente.
--
-- O código para de criar cópia (upload-anexo-email + reaproveitar-upload.ts,
-- INV-172). Esta migration limpa o que já acumulou: dá baixa (deletado_em) nas
-- CÓPIAS EXATAS, mantendo a mais recente de cada arquivo. Nada que a operadora
-- preparou se perde — sobra sempre 1 cópia de cada.
--
-- Cópia exata = mesmo card + mesmo to-do + mesmo nome + mesmo tamanho + mesma
-- impressão digital do conteúdo (`storage.objects.metadata->>'eTag'`, o hash
-- que o Storage grava no upload). Cercas, todas medidas em 07/10:
--   - só origem 'outbound' (o que a operadora subiu; arquivo do cliente nunca);
--   - só pendente (enviado_em e deletado_em nulos);
--   - preservar = false (INV-124: prova fiscal em uso nunca é baixada);
--   - só to-do 'pendente' ou 'cancelado' (em execução/executado fica de fora:
--     34 cópias em to-dos 'executando' não são tocadas);
--   - só cópia com mais de 24h (nenhuma janela aberta agora segura esses ids);
--   - arquivo sem registro no Storage (sem eTag) não entra.
-- Prévia em 07/10: 124 cópias em 26 cards; NF 941225 vai de 20 para 6 vagas
-- usadas; 119865 e 240766 também saem do teto.
--
-- O arquivo das cópias fica no bucket (SQL não apaga objeto do Storage; o
-- mesmo de hoje — não piora). Registro: 1 linha por card em audit_log (não em
-- card_events, para não mexer no last_event_at/relógio dos cards).
--
-- TIPO B (dado de produção). Um statement, atômico e idempotente: rodar de
-- novo não acha mais cópia (deletado_em já preenchido) e não grava nada. Sem
-- BEGIN/COMMIT (padrão do projeto). Não toca cron/trigger/função.
-- Autorização: Carlos 07/10 ("autorizado abrir a branch de correção"; aplicar
-- só na publicação, com a autorização dele no --autorizado-por).
-- =============================================================================

WITH base AS (
  SELECT a.id, a.card_id, a.todo_id, a.filename, a.size_bytes, a.uploaded_at,
         o.metadata->>'eTag' AS etag
  FROM public.email_anexos a
  JOIN public.todos t ON t.id = a.todo_id
  JOIN storage.objects o
    ON o.bucket_id = 'email_anexos' AND o.name = a.storage_path
  WHERE a.origem = 'outbound'
    AND a.enviado_em IS NULL
    AND a.deletado_em IS NULL
    AND a.preservar IS FALSE
    AND t.status IN ('pendente', 'cancelado')
    AND o.metadata->>'eTag' IS NOT NULL
),
ranqueado AS (
  SELECT b.*,
         row_number() OVER (
           PARTITION BY card_id, todo_id, filename, size_bytes, etag
           ORDER BY uploaded_at DESC, id DESC
         ) AS rn
  FROM base b
),
descartar AS (
  SELECT id
  FROM ranqueado
  WHERE rn > 1
    AND uploaded_at < now() - interval '24 hours'
),
marcados AS (
  UPDATE public.email_anexos a
     SET deletado_em = now()
    FROM descartar d
   WHERE a.id = d.id
     AND a.deletado_em IS NULL
  RETURNING a.id, a.card_id
)
INSERT INTO public.audit_log
  (card_id, action_type, actor_type, actor_id, external_system,
   idempotency_key, request_payload, status)
SELECT m.card_id,
       'anexos_repetidos_descartados',
       'system',
       'mig-413',
       'internal',
       'mig413:' || m.card_id::text || ':' || to_char(now(), 'YYYYMMDDHH24MISS'),
       jsonb_build_object(
         'motivo', 'cópias exatas de upload pendente (mesmo to-do, nome, tamanho e eTag); mantida a mais recente',
         'caso_ancora', 'NF 941225',
         'qtd', count(*),
         'anexo_ids', jsonb_agg(m.id ORDER BY m.id)
       ),
       'success'
FROM marcados m
GROUP BY m.card_id;

-- Caio 2026-05-12: operadora pediu visibilidade do TIPO CT-e (NORMAL/REVERSA/DEVOLUCAO/etc)
-- e da QUANTIDADE DE VOLUMES da NF no header do card. Dados já vivem no Bastão
-- (pendencias.tipo_documento + pendencias.qtd_volumes). Adicionamos as colunas em
-- cards e populamos via vinculador (criação) + sync-bastao Pass A (update).

ALTER TABLE cards ADD COLUMN IF NOT EXISTS tipo_cte text;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS qtde_volumes integer;

COMMENT ON COLUMN cards.tipo_cte IS
  'Tipo do documento CT-e (NORMAL, REVERSA, DEVOLUCAO, COMPLEMENTAR, ...). Fonte: pendencias.tipo_documento do Bastão.';
COMMENT ON COLUMN cards.qtde_volumes IS
  'Quantidade de volumes da NF. Fonte: pendencias.qtd_volumes do Bastão.';

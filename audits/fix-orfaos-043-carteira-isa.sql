-- ============================================================================
-- fix-orfaos-043-carteira-isa.sql  —  Correção dos 11 cards órfãos 043 (snapshot 2026-06-27)
-- ----------------------------------------------------------------------------
-- Raiz: clientes Curva F (043) entram via full-pull do segmento, mas o CNPJ não
-- está em nenhuma carteira; o fallback por segmento está MORTO ([R1] — hint é o
-- rótulo "043 - CURVA F" vs operadores.segmentos código "043"). Resultado: sem
-- dono → invisíveis exceto gestor (ver AUDIT_CARD_ROUTING_2026-06-27.md §4).
--
-- Fix DURÁVEL (não revertido pelo sync): cadastrar os CNPJs na carteira da ISA
-- E KAROL. Aí resolveOperadorDoCard devolve via='carteira_cnpj' → ISA, e como o
-- nome canônico ("ISA E KAROL") passa a diferir do nome cru gravado ("KAROL E
-- ISA"), precisaEscrever vira true e o PRÓPRIO sync-bastao reatribui os 11 com
-- card_events normais (event-sourcing intacto). NÃO toca em `cards` direto.
--
-- Idempotente: re-rodar não duplica (array distinct). Append-only na carteira.
-- A trigger legada cards_resolve_operator NÃO interfere (só age se assigned é
-- NULL, e aqui não tocamos cards).
--
-- APÓS aplicar: invocar sync-bastao (ou aguardar o cron) p/ efetivar a atribuição.
-- ============================================================================

BEGIN;

-- 8 clientes normais (decisão pendente sobre a SAL EXP — ver bloco comentado abaixo).
UPDATE operadores
SET carteira = (
  SELECT array(SELECT DISTINCT unnest(
    carteira || ARRAY[
      '32768944000108',  -- MAXTURBO COMERCIO DE ADITIVOS  (NF 12635)
      '55847057002409',  -- FORT LUB PRODUTOS              (NF 453640)
      '02415741000169',  -- DELIO ARAUJO                   (NF 5570657)
      '09601946000188',  -- AUTO PCS MEC                   (NF 1023206)
      '06133273000190',  -- BRASQUIMICA PROD QUIMICOS      (NF 30016)
      '18081748000121',  -- VETCLEAN COMERCIO              (NF 4345)
      '49816918000100',  -- DOUGLAS AUTO CENTER            (NF 656363)
      '31893116000120'   -- BHZ EPI DISTRIBUIDORA          (NF 28472)
    ]
  ))
)
WHERE nome = 'ISA E KAROL';

-- ⚠ SAL EXP (CNPJ interno da própria transportadora? 3 cards: NF 206261/206262/2206263).
-- Descomente SÓ se Caio confirmar que esses cards devem ser da ISA E KAROL:
-- UPDATE operadores
-- SET carteira = (SELECT array(SELECT DISTINCT unnest(carteira || ARRAY['86392529000466'])))
-- WHERE nome = 'ISA E KAROL';

-- Conferência dentro da transação (rollback se algo estranho):
-- SELECT nome, array_length(carteira,1) FROM operadores WHERE nome='ISA E KAROL';

COMMIT;

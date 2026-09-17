-- ============================================================================
-- 402 — Carlos 2026-09-16: a operadora pode CONFIRMAR, na tela, que o cliente
-- mandou a descrição/valor dos itens dentro de um anexo, e digitar o conteúdo.
-- Confirmando, o dossiê fecha e o botão da oc 33 libera.
--
-- REGRA, nas palavras dele:
--   "a opção tem q estar liberado desde q ela confirme q o dossiê está completo
--    e anexado / qdo ela tentar lançar neste caso deve abrir um popup
--    questionando que a descrição de itens não foi identificada e questionando
--    se o cliente informou via anexo / se ela marcar SIM, libera lançar a 33
--    confirmando que o dossiê está completo / se ela marcar NÃO, não libera a 33
--    pois o dossiê está incompleto"
--
-- POR QUE ISSO EXISTE: a leitura de anexo (mig 401 / INV-154) resolve quando o
-- agente CONSEGUE ler o arquivo. Quando não consegue — PDF escaneado torto,
-- foto ruim, planilha (fora desta rodada) — a informação está lá, a operadora
-- está olhando para ela, e não havia nenhuma saída: o botão ficava cinza e o
-- robô seguia cobrando um cliente que já respondeu.
--
-- O QUE A CHAVE LIGA: a edge function `confirmar-dossie-oc33`. Ela grava
-- card_event, escreve a evidência no dossiê com fonte='operador' + operador_id +
-- visto_em, e RECARIMBA os to-dos de oc 33 abertos do card.
--
-- O QUE NÃO MUDA (limites que o Carlos fixou):
--   - ROMANEIO continua obrigatório e NÃO é perguntado. Card sem romaneio segue
--     bloqueado — sem ele o SSW reverte a 33 (NF 660746).
--   - Marcar NÃO não libera nada (registra Oc33ConfirmacaoOperadorRecusada).
--   - SIM em branco não vale: ela DIGITA (opção "a" dele). Piso de 3 caracteres.
--   - Só aparece em card COM anexo do cliente.
--   - Combo 33+44 fora desta rodada.
--   - NÃO libera execução autônoma: veto-elegibilidade.ts:68 lê o mesmo carimbo,
--     então o robô continua barrado. Libera o BOTÃO, como ele determinou.
--
-- ALCANCE MEDIDO EM 16/09: 38 cards com to-do de oc 33 aberto, romaneio já
-- validado e só descrição/valor faltando (Karoline 8, Felipe 8, Maria 7,
-- Duilio 6, Isabely 4, Ingrid 2, Victor 2, Larissa 1). Os outros ~460 cards
-- travados também não têm romaneio e este pop-up NÃO os resolve.
--
-- ESTA MIGRATION NÃO MUDA COMPORTAMENTO NENHUM. A chave nasce FALSE; com ela
-- desligada a edge function recusa toda chamada (403 flag_off) e a tela nunca
-- oferece o pop-up. O flip é um UPDATE separado (TIPO B, com --autorizado-por).
--
-- IRREVERSIBILIDADE CONHECIDA: mergeEvidencia é monotônico — `presente` nunca
-- volta para false. Um SIM errado marca o card como completo para sempre e o
-- robô para de cobrar aquele cliente. Por isso operador_id + visto_em entram na
-- evidência E no card_event.
--
-- skill supabase-postgres-best-practices: INSERT idempotente em tabela de
-- CONFIGURAÇÃO. Sem DDL, sem índice novo, sem função, sem SECURITY DEFINER,
-- RLS inalterada. Uma linha, ON CONFLICT DO NOTHING — sem risco de lock.
--
-- TIPO A (aditiva, reversível, nasce desligada).
-- Rollback: DELETE FROM public.feature_flags WHERE key = 'popup_confirma_dossie_oc33_enabled';
--
-- Ver ADR 0030 e INV-155.
-- ============================================================================
INSERT INTO public.feature_flags (key, enabled, description)
VALUES (
  'popup_confirma_dossie_oc33_enabled',
  false,
  'Extravio parcial caso 1: quando so DESCRICAO e/ou VALOR faltam, o romaneio ja esta validado e o card tem anexo do cliente, a tela abre um pop-up perguntando se o cliente informou por anexo. SIM + texto digitado grava a evidencia no dossie com fonte=operador e libera o BOTAO da oc 33 (nunca lancamento autonomo). NAO pergunta romaneio, nao vale para combo 33+44, SIM em branco nao vale. OFF = comportamento de hoje, botao cinza. Alcance medido 16/09: 38 cards. Ver ADR 0030 e INV-155.'
)
ON CONFLICT (key) DO NOTHING;

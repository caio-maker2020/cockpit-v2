# Onboarding MARIA EDUARDA — 10/08/2026

Segmentos 040 (Operador Logístico) + 042 (Transportador) · 24 CNPJs na carteira.
Plano aprovado pelo Caio 10/08 (decisões travadas: e-mail maria.ferreira@salexpress.com.br,
senha temporária sal123456, Gmail conectado no dia da ativação, caixa nova sem forward).

## A exceção AGV (única do onboarding)
Cliente AGV (5 CNPJs pagadores) + 3PL (1 CNPJ): o contato do e-mail depende do
REMETENTE da NF. Estrutura: `contatos_cliente.cnpj_remetente` (mig 320) +
`resolver_email_cobranca_cliente(pagador, uso, remetente)` com preferência pela
linha específica. Seed: mig 322 (GERADA por scripts/import_contatos_maria.py da
planilha "Contatos clientes - Operador e transportador (1) (1).xlsx").
Correções do Caio na planilha: OURO FINO=20258278000685; GLENMARK=44363661000580;
VIRBAC/SYNTEC=2 CNPJs (56921166000790, 02177011000177); NOXON mantém 03982656000307.
1ª pessoa do bloco = TO default (ordem da planilha).
AGV NÃO tem contato geral: NF de remetente fora da lista → modal exige o e-mail
(comportamento combinado). Demais 22 clientes: contatos gerais (aba 2), fluxo clássico.

## Ordem executada
1. mig 320 — estrutura por remetente (asserts de zero-regressão)  ✔
2. backend (9 chamadores) + front (5 pickers, filtro+badge)        ✔
3. mig 322 — seed (guardas + 4 asserts: ZOETIS×5, AGV-sem-rem=NULL, LEXMARK, Penske) ✔
4. login via Admin API + UPDATE operadores (user_id/email)
5. mig 323 — ativação (cockpit_ativo, email_relacionamento, retroativo esperado 0)
6. merge com aval + deploy das functions consumidoras + paridade
7. HUMANO: Maria loga → troca senha → Configurações → Conectar Gmail

## Verificação de aceite
- `resolver_email_cobranca_cliente('02905424001879','logistico','01770356000177')` = luis.folli@agv.com.br
- Card AGV real: modal de e-mail mostra só gerais + os do remetente do card (badge 📌)
- INV-036/038/048 verdes; sync passa a puxar os 24 CNPJs no 1º ciclo pós-ativação

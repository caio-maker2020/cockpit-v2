# Onboarding INGRID ALVES — runbook (branch `onboarding-ingrid`)

Plano aprovado pelo Caio em 11/08/2026. **3 grupos de clientes** (11 CNPJs na
carteira): Stanley Black & Decker, Dimensional+Nortel, Würth.

## Exceções construídas

### Black & Decker (SBD)
1. **oc 13**: card aparece no Cockpit (espelho O.V.D.) — `cliente_config_oc13`,
   mig 329 bloco 1.
2. **Extravio TOTAL**: fluxo padrão (59 + e-mail pedindo romaneio). Sem código.
3. **Extravio PARCIAL**: PROIBIDO pedir romaneio ao cliente. Trilho
   romaneio-interno (mesmo da PRATI) com duas diferenças, ambas config
   (`cliente_config`, mig 329 bloco 2):
   - `romaneio_escopo='so_parcial'` — só ativa em card parcial;
   - `romaneio_busca_chave='numero_remessa_danfe'` — o executor resolve o
     **Nº Remessa** nos Dados Adicionais da NF-e (SSW 101 → DANFEs → **XML NF**;
     o PDF do "Impr" é imagem pura, inextraível) e busca na plataforma por ele.
   - E-mail informativo do parcial sai igual PRATI (confirmado pelo Caio).
   - Falhas viram evidência sintética + `card_event` e a 33 sobe (processo atual):
     `RemessaDanfeNaoExtraida` quando o XML não dá o número.

### Dimensional + Nortel (resposta em thread nova)
O sistema do cliente (b2c.srv.br) responde SEMPRE num e-mail novo, NF no corpo.
- `contatos_cliente.responde_em_thread_nova` marca os remetentes (planilha).
- `gmail-poll` admite e-mail não-casado DESSES remetentes no pipeline normal
  (flag `resposta_thread_nova_enabled`, nasce OFF). Triador extrai a NF do
  corpo → vinculador acha o card ativo → fonte única (INV-067). Vale em todo
  ciclo. Dedupe global por Message-ID cobre caixa da Ingrid + alias Ferramentas.

### Würth — CONSTRUÍDA (vídeos da Ingrid 11/08 + decisões do Caio)
- **Extravios = trilho PRATI puro** (config mig 331): romaneio buscado na nossa
  plataforma POR NF, template que não pede romaneio, respostas na MESMA thread.
- **Robô da intranet** (`robo-intranet-wurth`, flag `wurth_intranet_enabled`
  OFF): cron 08h/16h BRT + botão "🔎 Buscar intranet Würth" no card. Logins da
  Ingrid (secrets `WURTH_INTRANET_SAL_*` / `WURTH_INTRANET_AMPLA_*` — setar no
  cofre na fase de teste). Prefixo CTRC → login: AMB/WTB=ampla, WTC/ARP=sal.
  Consulta com Incluídos E Tratadas 01/01→hoje, Solucionado Würth; parser por
  cabeçalho (a coluna É a Nota Fiscal). Efeitos: Reentrega→sugere 21 com a Obs;
  Devolver→sugere 44 (modal padrão volumes/base/motivo); CCE→aguarda o e-mail.
  Dedupe `wurth_retornos_processados` (nf+data_solucao+solucao). SUGERE, nunca
  lança (INV-071).
- **CCE**: e-mail novo (porta thread-nova; contatos Würth marcados) → anexo no
  card + proposta 21 RECOMENDADA com aviso "corrigir endereço no SSW antes".
  Correção de endereço MANUAL — automação aguarda vídeo do Caio.
- **Contatos** (mig 331, tabela do Caio): SBD 6, Würth 4×4 CNPJs (thread-nova),
  Sonepar 8×6 CNPJs Dim/Nortel (thread-nova).
- **VALIDAR AO VIVO na fase de teste** (com as credenciais reais): login/forms
  da intranet (nomes de campos foram deduzidos — heurística defensiva com
  categorias de falha) e a consulta ponta-a-ponta.

## Sequência do merge final (só com aval expresso)

1. Chegar planilha padrão → gerar seed de contatos (padrão
   `scripts/import_contatos_maria.py`): CNPJs por grupo, contatos SBD,
   contatos b2c com `responde_em_thread_nova=true`. Atualizar
   `cliente_config_oc13` se vierem mais CNPJs SBD.
2. Implementar + testar Würth (vídeos).
3. **Validação ao vivo na branch** (pendências técnicas conhecidas):
   - `resolverNumeroRemessaViaDanfe` contra o CTRC real SBD492185-2 — os
     seletores de link das telas DANFEs/XML foram escritos defensivamente a
     partir dos prints; a tela real pode divergir (categorias de falha prontas).
   - E-mail b2c real re-injetado casando com card da NF.
4. Criar auth user: Admin API, `ingrid.alves@salexpress.com.br` / `sal123456`,
   `email_confirm: true`.
5. Aplicar mig **330** (ativação — guardas G1-G5; falha limpa se 1-4 faltarem).
6. Ligar `resposta_thread_nova_enabled` (nomeada pelo Caio).
7. Deploy: `executor`, `gmail-poll-inbox` (+ o que a Würth tocar). Paridade,
   apagar branch, memória + INVs verdes.
8. **Pós-humano**: Ingrid loga → troca senha → **conecta o Gmail**
   (pré-requisito da exceção Dimensional/Nortel) → avisar que os cards dos 3
   grupos passam a nascer no Cockpit dela.

## Âncoras de teste
- NF `23/002467883` / CTRC `SBD492185-2` → Nº Remessa `1262024921` (DANFE real).
- Delivery `1261962099` encontrado na plataforma de romaneio (print 18/07).
- E-mail b2c: assunto `DIFICULDADE DE ENTREGA DO CLIENTE: (COBB VANTRESS BRASIL
  LTDA) OCORRÊNCIA: 6500`, corpo `Nota fiscal: 1599966 - Romaneio: 150876`.
- SSW da Ingrid: domínio SEP, usuário `ingrid.a` (humano) — o Cockpit usa
  `ai.salex` (INV-063), nada por operador.

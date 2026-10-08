# Pedido ao time do Cockpit: Operação + baixa do motorista

**Para:** Caio e o Claude do Caio. **De:** Matheus (Preceptor), com o Claude do roteirizador.
**Branch:** `matheuscastro12-eng/operacao-e-motorista` (PR #41), com o `master` **6c56a78** já integrado por merge em 08/10.
**Data:** 07/10/2026, atualizado em 08/10/2026.

> **Claude do Caio:** leia este arquivo inteiro antes de qualquer coisa. Nada nesta branch foi
> aplicado no banco, publicado como edge function, ligado por flag ou posto em cron. Tudo
> nasce **desligado**. Cada passo abaixo é uma decisão do Caio, pelo trilho de vocês
> (`--autorizado-por`, horário calmo, prova de pulso). Revise, rode as suítes, e faça um passo
> por vez; pare e pergunte ao Caio onde estiver escrito **[decisão do Caio]**.

## O que a branch traz

| Peça | ADR | Migrations | O que faz |
|---|---|---|---|
| Ponte v2 renumerada | 0038, 0039 | 417–419 | A ponte com o roteirizador (painel da operação). Renumerada duas vezes: 410–412 → 414–416 (07/10) → **417–419** (08/10, porque o master aplicou as migs 414/415/416 da oc 13). O invariante dela é o **INV-175** (antes INV-161, depois INV-173). |
| Baixa do motorista | 0040 | 420–421 | O roteirizador manda a baixa do motorista (`ponte-baixa-entrega`); um worker serial grava a 01/insucesso no SSW pela `ai.salex`, em ritmo da INV-159, conferindo antes se já está no SSW (`ja_no_ssw`). |
| Operação no Cockpit | 0041 | 430–440 | Área própria da Operação: fila (do Bastão), lançamento com prévia e 1 clique, sugestões (regra aprendida → agente Haiku 5.5), "aguardar", encaminhar ao Relacionamento (hoje vai para um **espelho**), separação total entre os dois lados. |
| Tela da Operação | 0041 | — | `/operacao` e `/operacao/espelho` no cockpit-web, kanban por tipo de problema, modo demonstração isolado do build de produção. |

Documentos para ler, nesta ordem: `docs/decisions/0041-operacao-no-cockpit.md` (seção
"Como ligar"), `docs/OPERACAO-SEPARACAO-RLS.md`, `docs/OPERACAO-TELA.md`,
`docs/decisions/0040-baixa-do-motorista.md`, `docs/decisions/0039-painel-operacao-tratativa-e-pedidos.md`.

## O que mudou com o master de 08/10 (merge, sem rebase)

- O master (6c56a78) trouxe a oc 13 (VIA RURAL/JA, medição completa), o diagnóstico do
  reaproveitamento de página e as migs **414/415/416**, já aplicadas em produção, com os
  **INV-172/173/174**. Tudo isso foi mantido como está no master.
- Para não colidir, só os NOSSOS números mudaram (commit `chore(ponte/operacao): renumera…`):
  - migs da ponte `414_ponte_roteirizador` → **417**, `415_ponte_operacao` → **418**,
    `416_cron_processar_pedidos_operacao` → **419** (o setting `cockpit.mig415_nascimento`
    virou `cockpit.mig418_nascimento`);
  - **INV-173..177 → INV-175..179** (pedido da operação = 175; baixa do motorista = 176–179),
    em INVARIANTES, `/verify-cockpit` (variáveis `INV17x_`), AGENTS, ADRs 0039/0040, testes;
  - o pino byte a byte em `ponte-operacao-flags-off.test.ts` foi repinado só para
    `sync-roteirizador-ponte/index.ts` (comentário "mig 417") e para a mig 417 (nome e cabeçalho).
- Sem colisão: migs 420–421 e 430–440, ADRs 0038–0041 (o master vai até 0037) e INV-180..189.
- Único conflito textual: `docs/INVARIANTES_COCKPIT.md` (INV-173/174 do master primeiro, os
  nossos depois, com nota de renumeração no INV-175).

## Estado dos testes nesta branch (08/10, offline, sem banco)

Rodados num checkout limpo (fora da pasta com `package.json` no diretório pai, que quebra o
type-check do deno) e comparados com o `master` 6c56a78 puro, na mesma máquina:

- `deno test --no-check -A supabase/functions/`: **1860 passaram, 2 falharam**. O master puro dá
  1539/2 com **as mesmas 2 falhas** (`regras-auto-acao.sem-email-54` "gêmeo 59" e
  `tools-registrados-no-front` "enviar_email_template"). Não são desta branch.
- Suítes da branch + as do master que tocam o mesmo terreno (`operacao-*`, `ponte-operacao-*`,
  `baixa-motorista-*`, `lancar-ssw-baixa*`, `oc13-*`, `reaproveitar-upload`,
  `ssw-internal-client-data-hora-evento`, `sync-roteirizador-ponte-core`): **309/309**; o pino
  `ponte-operacao-flags-off` com type-check: **3/3**.
- `/verify-cockpit` fase 8 (sem credencial de banco): **164 PASS, 31 FAIL, 3 SKIP**; o master
  puro dá **145 PASS, 32 FAIL, 3 SKIP**. Nenhum FAIL é novo: todos falham igual no master
  (a maioria depende de banco/credencial). **INV-013 PASS**; INV-160, INV-175..179 e
  INV-180..189 **todos PASS**.
- cockpit-web: `npm run typecheck` **ok**; vitest **527/528** — a única falha é
  `src/lib/confirmacaoOc33.test.ts`, que **também falha no master 6c56a78**.
- SQL: `supabase/tests/operacao/rodar-local.sh` (Postgres local descartável, migs
  430/431/418/434–440 duas vezes + testes SQL) **ok**.

## PRs abertos e esta branch (merge de teste local em 08/10, nada empurrado)

- **#42** (Caio, `op/familias-caio-e-tipo-cte`, base = esta branch): **conflita** — 4 arquivos.
  Ele saiu de um ponto anterior à tela nova: `components/operacao/FiltrosFilaOperacao.tsx` foi
  **removido** aqui (a barra de topo única, `BarraOperacao.tsx`, absorveu os filtros) e o #42 o
  altera; `lib/operacao/familias.ts` (1 bloco: as famílias novas do Caio — Redespacho/40 com
  relógio de 2 dias, Agendamento/29, 14 passiva — contra a "Transferência / Redespacho" antiga),
  `pages/operacao/Operacao.tsx` (1 bloco) e `Operacao.test.tsx` (12 blocos). As migs 430–440 que
  ele toca não mudaram de número. **A regra do Caio vence nas famílias**; o filtro por tipo de
  CT-e precisa ir para a `BarraOperacao`. Não foi mergeado aqui: decisão de quem conduz o #42.
- **#44** (`feat/torre-gestao-agentes`, base master): **merge limpo** com esta branch; typecheck
  ok; vitest 534/536 (a do `confirmacaoOc33` do master + `Operacao.test.tsx` por tempo sob
  carga — sozinho passa 37/37, duas vezes, com e sem o #44).
- **#36** (ponte v1 antiga, base master): **substituído por esta branch** (que traz a ponte
  renumerada 417, ADR 0038). Conflita em 20 arquivos se mergeado; pode ser fechado por quem o
  abriu quando o #41 entrar.

## O que precisa ser feito pelo time do Cockpit

### 1. Segurança — antes de qualquer login da Operação (P1)
A mig 431 corrige um furo (qualquer usuário logado podia se inserir em `operadores` como
gestor). Ficam abertos, **fora do escopo desta branch** — detalhes em `docs/OPERACAO-SEPARACAO-RLS.md`:
- `operadores_update_self` deixa um operador se promover a gestor.
- Edges que qualquer usuário logado chama: `atualizar-card-via-portal-ssw`,
  `puxar-historico-ssw-card`, `enviar-retificacao-evidencia`, `cobrar-cliente-aguardando`,
  `send-whatsapp-message`.
- A RPC `resolver_email_cobranca_cliente` devolve e-mail de cliente a qualquer logado.

### 2. Ponte v2 (para o painel da operação do roteirizador)
Seguir "Ativação da v2" no ADR 0039: migs 417–419, `PONTE_OPERACAO_TOKEN`, flags na ordem.
**[decisão do Caio]** ordem de entrada da ponte em relação ao resto.

### 3. Baixa do motorista (ADR 0040)
1. **Teste fiscal — o maior risco do app único [decisão do Caio + Sal]:** lançar uma 01 de
   teste num CTRC real pela opção 101 (e, se possível, pela WebAPI `ocorrenciaParceiro`) e
   conferir se gera o **Comprovante de Entrega do CT-e na SEFAZ**, como o SSW Mobile gera
   ("Comprovante registrado no SEFAZ-XX - Protocolo"). Se nenhum dos dois gerar, a baixa
   pelo app não pode substituir o SSW Mobile.
2. Escolher o canal (`baixa_motorista_config.canal` = `portal101` ou `webapi`) e responder:
   a credencial da WebAPI pode ser a `ai.salex`? Até quantos dias a 101 aceita data retroativa?
3. Aceitar no contrato o que o app novo já manda (opcional, compatível): até **2 evidências**
   por baixa (foto + assinatura, JPEG), `recebedor.parentesco` e `volumesFaltantes`, e
   incluí-los no "mesmo conteúdo" da idempotência. O contrato está no roteirizador em
   `docs/PONTE-COCKPIT.md`, seção "Ponte v3: baixa do motorista" (A2).
4. Lista de códigos de insucesso e piloto (base/motorista) **[decisão do Caio + Sal]**. No
   histórico aparecem pelo SSW Mobile: 10, 11, 13, 19, 35.
5. Migs 420 → deploy → 421 (cron) com prova de pulso; flags na ordem do ADR.

### 4. Operação (ADR 0041, "Como ligar")
1. Migs 430 e 431 (horário calmo, `lock_timeout`), depois deploys e 432–433 com prova de pulso.
2. **Realtime:** a mig 430 não põe `op_itens`/`op_lancamentos` na publicação
   `supabase_realtime`; até isso entrar, a tela recarrega a cada 60 s.
3. Cadastro de membros da Operação, unidades e supervisores **[decisão da Sal]**; regras
   oc → unidade (`op_regra_unidade_por_oc`).
4. Códigos que a Operação pode lançar (`op_codigos_lancaveis`, nasce vazia), um por
   migration com dono **[decisão do Caio + Operação]**.
5. Sugestões: carregar as regras aprendidas (o roteirizador gera o `regras.json`; formato no
   cabeçalho da mig 440 e validado por `validarRegrasAprendidas`), aplicar 434/435/439/440,
   rodar a eval ao vivo do agente (Haiku 5.5, `evals/agente-operacao.ts`) e só então ligar
   `operacao_sugestao_ia`.
6. Encaminhar ao Relacionamento: **fica no modo `espelho`** (mig 438). Decisão do Matheus:
   nada vai ao Relacionamento de verdade por enquanto. Passar a `real` só com migration
   `--autorizado-por` e ordem explícita dele; e o modo real depende da ponte (mig 418/419).
7. Atualizar no `CLAUDE.md` a linha "Cockpit é apenas pro time de Relacionamento" quando o
   ADR 0041 for aceito.

## O que NÃO fazer
- Não ligar nenhuma flag, cron ou modo real sem a decisão do Caio e do Matheus.
- Não rodar as migrations no banco de produção fora do trilho, nem dry-run em horário de pico
  (tabela `cards` é quente).
- Não lançar nada no SSW em lote: a `ai.salex` é única (INV-159).

## Contato
Dúvidas sobre a intenção do produto: Matheus. Dúvidas sobre o lado do roteirizador: o repo
`PRECEPTORST/roteirizador-inteligente` (`docs/PONTE-COCKPIT.md`, `docs/SUGESTOES-OPERACAO.md`).

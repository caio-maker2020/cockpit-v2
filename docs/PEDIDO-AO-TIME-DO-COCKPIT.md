# Pedido ao time do Cockpit: Operação + baixa do motorista

**Para:** Caio e o Claude do Caio. **De:** Matheus (Preceptor), com o Claude do roteirizador.
**Branch:** `matheuscastro12-eng/operacao-e-motorista` (sobre o `master` 178dcf8).
**Data:** 07/10/2026.

> **Claude do Caio:** leia este arquivo inteiro antes de qualquer coisa. Nada nesta branch foi
> aplicado no banco, publicado como edge function, ligado por flag ou posto em cron. Tudo
> nasce **desligado**. Cada passo abaixo é uma decisão do Caio, pelo trilho de vocês
> (`--autorizado-por`, horário calmo, prova de pulso). Revise, rode as suítes, e faça um passo
> por vez; pare e pergunte ao Caio onde estiver escrito **[decisão do Caio]**.

## O que a branch traz

| Peça | ADR | Migrations | O que faz |
|---|---|---|---|
| Ponte v2 renumerada | 0038, 0039 | 414–416 | A ponte com o roteirizador (painel da operação), rebaseada no master e renumerada (antes 410–412; o master já usa 411–413). INV-161 da ponte virou INV-173. |
| Baixa do motorista | 0040 | 420–421 | O roteirizador manda a baixa do motorista (`ponte-baixa-entrega`); um worker serial grava a 01/insucesso no SSW pela `ai.salex`, em ritmo da INV-159, conferindo antes se já está no SSW (`ja_no_ssw`). |
| Operação no Cockpit | 0041 | 430–440 | Área própria da Operação: fila (do Bastão), lançamento com prévia e 1 clique, sugestões (regra aprendida → agente Haiku 5.5), "aguardar", encaminhar ao Relacionamento (hoje vai para um **espelho**), separação total entre os dois lados. |
| Tela da Operação | 0041 | — | `/operacao` e `/operacao/espelho` no cockpit-web, kanban por tipo de problema, modo demonstração isolado do build de produção. |

Documentos para ler, nesta ordem: `docs/decisions/0041-operacao-no-cockpit.md` (seção
"Como ligar"), `docs/OPERACAO-SEPARACAO-RLS.md`, `docs/OPERACAO-TELA.md`,
`docs/decisions/0040-baixa-do-motorista.md`, `docs/decisions/0039-painel-operacao-tratativa-e-pedidos.md`.

## Estado dos testes nesta branch (rodados offline, sem banco)

- `deno test --no-check --allow-read --allow-env` nas suítes `operacao-*`, `ponte-operacao-*`,
  `baixa-motorista-*`, `lancar-ssw-baixa*`: **263 passaram, 0 falharam**.
- Guard INV-013 do `/verify-cockpit` (com os dois envelopes novos): **PASS**.
- cockpit-web: `npm run typecheck` **ok**; vitest **509/510** — a única falha é
  `src/lib/confirmacaoOc33.test.ts`, que **já falha no master 178dcf8** (o backend ganhou
  `"romaneio_interno"` e o teste não acompanhou). Não é desta branch.
- SQL das migrations testado só num Postgres local descartável (`supabase/tests/operacao/rodar-local.sh`).

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
Seguir "Ativação da v2" no ADR 0039: migs 414–416, `PONTE_OPERACAO_TOKEN`, flags na ordem.
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
   `--autorizado-por` e ordem explícita dele; e o modo real depende da ponte (mig 415/416).
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

---
title: "Processo: Tratativa de Problema de Entrega — Larissa"
subtitle: "Estado atual codificado no Cockpit (2026-05-01) — Larissa valida / corrige / expande"
---

# Processo: Tratativa de Problema de Entrega

> **Como usar este documento**: este é o desenho do processo **como já
> está codificado e rodando no Cockpit hoje** (2026-05-01). Larissa, lê
> com atenção e:
>
> 1. Marca o que está **errado / incompleto** (corrige direto no doc)
> 2. Adiciona o que está **faltando** (casos, decisões, escaladas)
> 3. Responde nas seções com `> resposta:` (frequência, problemas, dúvidas)
>
> Quanto mais detalhe, melhor o agente IA fica. Não economize palavras.

---

## 1. Nome do processo

**Tratativa de Problema de Entrega**
_(toda situação em que o motorista chegou no destino e a entrega não rolou — recusa, endereço errado, limitação do cliente — até resolver em entrega ou devolução)_

> Dono: **Larissa** (Relacionamento Farmacêutico)
> Áreas envolvidas: Relacionamento, Operação (motorista), eventual escalada pra Devolução / Indenização

## 2. Resumo em 1 frase

Garantir que toda carga que falhou na 1ª tentativa de entrega chegue a um desfecho — entrega bem-sucedida (oc=01) ou devolução formalizada (oc=55) — mantendo o cliente informado em cada passo.

## 3. ⭐ MAPA MENTAL DO PROCESSO

```
                  ┌──────────────────────────────────────┐
                  │  GATILHOS DE INÍCIO                  │
                  └──────────────────┬───────────────────┘
                                     │
       ┌──────────┬──────────┬───────┴──────────┬──────────────┐
       ▼          ▼          ▼                  ▼              ▼
   oc=10      oc=11      oc=13               oc=35       (resp. cliente
   recusa     endereço   limitação           recusa       em card 54)
   total                 cliente             parcial
       │          │          │                  │              │
       │   ┌──────┴───┐      │           ┌──────┴───┐          │
       │   ▼          ▼      │           ▼          ▼          │
       │  oc=21    oc=54+    │          oc=21    oc=54+        │
       │ (reent.)  email     │         (reent.) email          │
       │           c/ link   │                  c/ link        │
       │           evidência │                  evidência      │
       │                     │                                 │
       │           ┌─────────┴──────────────────┐              │
       │           │ (lock — aguarda Larissa    │              │
       │           │  validar antes de mandar)  │              │
       │           └────────────────────────────┘              │
       │                                                       │
       └──────────────────┬────────────────────────────────────┘
                          │
                          ▼
                  ┌─────────────────────────┐
                  │  Cliente responde?      │
                  └────┬────────────────────┘
                       │
                  ┌────┴────────────┬────────────┐
                  ▼                 ▼            ▼
             autorizou         autorizou      desistiu/
             reentrega         devolução      sumiu (4d)
                  │                 │            │
                  ▼                 ▼            ▼
             oc=21 SSW         oc=55 SSW     re-cobra
             (motorista        (devolução    em D+4
              volta)            formalizada) (até resp.)
                  │                 │
                  ▼                 ▼
        ┌────────────────┐    ┌────────────┐
        │ oc=01 entregue │    │ FIM:       │
        │   = FIM feliz  │    │ devolução  │
        │                │    └────────────┘
        │ ou oc=11/10/35 │
        │ de novo (loop, │
        │ até 3x)        │
        └────────────────┘
```

**Transições típicas em texto:**

- **oc=10** (recusa total) → opção mais comum: lançar oc 54 + email com `{link_evidencia}` (cliente vê NFD) → cliente responde → na maioria autoriza devolução → lançar oc=55 → FIM.
- **oc=11** (endereço) → 2 caminhos comuns: (a) já sei o endereço novo → lançar oc=21 direto; (b) preciso confirmar com cliente → lançar oc=54 + email com `{link_evidencia}` (cliente vê foto SSWMobile do endereço errado) → cliente confirma → lançar oc=21.
- **oc=13** (limitação cliente) → comportamento varia por CNPJ. Para a maioria é responsabilidade da Operação. Para clientes específicos (Larissa lista quais), exige autorização do cliente antes de reentregar — vira mesmo fluxo de oc=11.
- **oc=35** (recusa parcial) → lançar oc=21 (entregar parte aceita) + oc=54 + email com `{link_evidencia}` (cliente vê NF com ressalva, decide o que fazer com a parte recusada).
- **Loop**: mesma NF pode passar por oc=11 várias vezes. Após 3ª oc=11/10, NÃO lançamos oc=21 — escala pra "Devolução autorizada".
- **FIM**: oc=01 (entrega bem-sucedida) ou oc=55 (devolução formalizada).

> **Larissa, validar:** mapa está correto? Falta caminho? Tem ramificação que esqueci?

## 4. GATILHOS — quando começa

- [X] Pendência no Bastão com **oc=10** (recusa total)
- [X] Pendência no Bastão com **oc=11** (problemas com endereço)
- [X] Pendência no Bastão com **oc=13** (limitação cliente — CNPJs específicos da lista da Larissa)
- [X] Pendência no Bastão com **oc=35** (recusa parcial)
- [X] Cliente manda WhatsApp/email pedindo nova tentativa, mesmo sem oc nova (raro mas acontece)

**Detalhamento por gatilho:**

- **oc=10** — motorista chegou e cliente recusou tudo. Geralmente sem aviso prévio. Significa que o destino tem objeção (endereço errado, comprou errado, falta de espaço).
- **oc=11** — chegou na cidade certa, endereço não bateu. Motorista lança no SSWMobile junto com foto do local.
- **oc=13** — motorista chegou mas cliente tinha limitação (horário fechado, sem ninguém pra receber). Maioria é "Operação" trata. Mas Larissa cobra cliente antes de reentregar **só pra estes CNPJs específicos**:

> **Larissa, lista os CNPJs aqui:**




- **oc=35** — entregou parte, parte foi recusada. Motorista anota na NF (NF com ressalva) qual parte voltou.

## 5. ⭐ MATRIZ GATILHO → AÇÕES

### Bloco 1 — oc=11 (problemas com endereço)

```
┌────────────────────────────────────────────────────────────────────┐
│ GATILHO: oc=11 (PROBLEMAS COM ENDERECO)                            │
│ Quando: motorista chegou e endereço estava errado/incompleto       │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│ 🔵 OPÇÃO A — Reentregar direto (cliente já confirmou endereço)     │
│   • Falar com cliente?  [X] não                                    │
│   • Lançar oc no SSW?   [X] sim → oc 21 (reentrega solicitada)     │
│   • Cobrar responsável? [ ] não                                    │
│   • Pós-ação:           [X] AGUARDANDO_VALIDACAO_HUMANA + lock     │
│   • Validação humana?   [X] sim — Larissa confirma antes           │
│                                                                    │
│ 🔵 OPÇÃO B — Confirmar endereço com cliente antes                  │
│   • Falar com cliente?  [X] sim — email                            │
│       Template: PROBLEMAS_COM_ENDERECO                             │
│       Link de evidência?  [X] sim (foto SSWMobile)                 │
│   • Lançar oc no SSW?   [X] sim → oc 54 (aguardar cliente)         │
│   • Cobrar responsável? [ ] não                                    │
│   • Pós-ação:           [X] AGUARDANDO_CLIENTE                     │
│   • Validação humana?   [X] sim — Larissa aprova o disparo         │
│                                                                    │
│ 🔘 Quando escolher A vs B?                                         │
│   "Se cliente já tinha mandado mensagem confirmando o endereço     │
│    novo (ex: 'esqueci, é tal rua, nº 200'), vai A direto.          │
│    Se nada chegou ainda, B (cliente confirma vendo a foto)."       │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

### Bloco 2 — oc=10 (recusa total)

```
┌────────────────────────────────────────────────────────────────────┐
│ GATILHO: oc=10 (RECUSA TOTAL)                                      │
│ Quando: motorista chegou e cliente recusou TODA a carga            │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│ 🔵 OPÇÃO A — Tentar uma 2ª entrega em outro endereço               │
│   • Falar com cliente?  [ ] não                                    │
│   • Lançar oc no SSW?   [X] sim → oc 21 (reentrega)                │
│   • Cobrar responsável? [ ] não                                    │
│   • Pós-ação:           [X] AGUARDANDO_VALIDACAO_HUMANA + lock     │
│   • Validação humana?   [X] sim                                    │
│   • Quando usar:        cliente já mandou mensagem dizendo que     │
│                         quer tentar de novo em outro endereço      │
│                                                                    │
│ 🔵 OPÇÃO B — Aguardar autorização do cliente (caminho normal)      │
│   • Falar com cliente?  [X] sim — email                            │
│       Template: RECUSA_TOTAL                                       │
│       Link de evidência?  [X] sim (NFD — Nota Fiscal de Devolução) │
│   • Lançar oc no SSW?   [X] sim → oc 54                            │
│   • Cobrar responsável? [ ] não                                    │
│   • Pós-ação:           [X] AGUARDANDO_CLIENTE                     │
│   • Validação humana?   [X] sim                                    │
│                                                                    │
│ 🔘 Quando escolher A vs B?                                         │
│   "B na maioria absoluta. A só se cliente já se manifestou."       │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

### Bloco 3 — oc=13 (limitação cliente — CNPJs específicos)

```
┌────────────────────────────────────────────────────────────────────┐
│ GATILHO: oc=13 (LIMITACAO CLIENTE)                                 │
│ Quando: motorista chegou mas cliente tinha limitação (horário      │
│         fechado, recebimento bloqueado, etc).                      │
│                                                                    │
│ ⚠️ SÓ PRA CNPJS ESPECÍFICOS da lista da Larissa.                  │
│    Demais CNPJs: NÃO é processo de relacionamento — Operação trata.│
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│ 🔵 OPÇÃO ÚNICA — Pedir autorização do cliente pra reentregar       │
│   • Falar com cliente?  [X] sim — email                            │
│       Template: PROBLEMAS_COM_ENDERECO (mesmo template, msg muda)  │
│       Link de evidência?  [X] sim                                  │
│   • Lançar oc no SSW?   [X] sim → oc 54                            │
│   • Cobrar responsável? [ ] não                                    │
│   • Pós-ação:           [X] AGUARDANDO_CLIENTE                     │
│   • Validação humana?   [X] sim                                    │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

> **Larissa, validar:** lista de CNPJs sujeitos a oc=13 — preencha na seção 4. Template a usar é `PROBLEMAS_COM_ENDERECO` mesmo ou prefere criar um específico (ex: `LIMITACAO_CLIENTE`)?

### Bloco 4 — oc=35 (recusa parcial)

```
┌────────────────────────────────────────────────────────────────────┐
│ GATILHO: oc=35 (RECUSA PARCIAL)                                    │
│ Quando: parte da carga foi entregue, parte foi recusada            │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│ 🔵 OPÇÃO COMBINADA — fazer A + B (sempre as duas)                  │
│                                                                    │
│ A) Concluir parte aceita (oc 21 com volume parcial):               │
│   • Lançar oc no SSW?   [X] sim → oc 21                            │
│   • Falar com cliente?  [ ] não nessa primitiva                    │
│   • Pós-ação:           [X] AGUARDANDO_VALIDACAO_HUMANA + lock     │
│                                                                    │
│ B) Pedir orientação do cliente sobre a parte recusada:             │
│   • Falar com cliente?  [X] sim — email                            │
│       Template: RECUSA_PARCIAL                                     │
│       Link de evidência?  [X] sim (NF com ressalva do motorista)   │
│   • Lançar oc no SSW?   [X] sim → oc 54                            │
│   • Pós-ação:           [X] AGUARDANDO_CLIENTE                     │
│                                                                    │
│ 🔘 Quando escolher?                                                │
│   "Sempre as duas — uma resolve a parte aceita, a outra resolve    │
│    a parte recusada."                                              │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

### Bloco 5 — Cliente respondeu em card AGUARDANDO_CLIENTE

Esse não é uma oc do SSW, é gatilho derivado. Quando cliente responde
qualquer coisa via email/whatsapp num card que estava em AGUARDANDO_CLIENTE,
o card vira AGUARDANDO_VALIDACAO_HUMANA + lock e Larissa decide:

- 🔵 Cliente confirmou endereço novo → lançar **oc 21**
- 🔵 Cliente autorizou devolução → lançar **oc 55**
- 🔵 Cliente respondeu inconclusivo ("ok", "vou ver") → "Voltar p/ AGUARDANDO_CLIENTE" + reagenda cobrança D+4
- 🔵 Resposta totalmente fora de escopo → "Voltar p/ To-Do" + Larissa trata manual

## 6. Onde Larissa olha

**SSW (módulo de carga):**
- Filtra por NF
- Olho: oc atual, base atual, motorista designado, histórico de oc, observação última
- Print do SSWMobile (pra ver foto da oc=11)

**WhatsApp (instância sal-express):**
- Histórico de conversa do cliente — últimos 7 dias
- Pra ver se cliente já confirmou endereço novo antes da minha pergunta

**Bastão:**
- Filtro: minha carteira (Larissa)
- Olho: data da última oc, prazo de retorno, dias atraso

**Email (relacionamento.farmaceutico@salexpress.com.br):**
- Threads com o cliente
- Anexos (cliente às vezes manda foto do endereço, comprovante)

> **Larissa, validar:** falta algum sistema/tela que você consulta?

## 7. Heurísticas de decisão

### Pergunta 1: Cliente já me deu o endereço/decisão sem eu pedir?
- Como descubro: olho últimas mensagens WhatsApp/email do cliente.
- Se sim: vai direto pra Opção A (lançar oc 21 ou oc 55).
- Se não: Opção B (aguardar via oc 54 + email).

### Pergunta 2: Já é a Nª oc=10/11/35 dessa NF?
- Como descubro: histórico SSW.
- Se 1ª/2ª: trato normal.
- Se 3ª+: NÃO insisto. Aviso cliente que vai pra devolução. Escalo se ele recusa.

### Pergunta 3: Cliente está bravo/ameaçando?
- Como descubro: tom da mensagem ("absurdo", "Procon", "vou processar").
- Se sim: trato manual sem automação. Cópia gestor.
- Se não: fluxo normal.

### Pergunta 4: Carga é perecível ou alto valor?
- Como descubro: campo "tipo" no CTRC ou tag interna.
- Se sim: prioridade alta, ligo motorista pessoalmente.

> **Larissa, validar:** essas 4 perguntas cobrem? Tem outra que você se faz mentalmente que não está aqui?

## 8. Ações em ordem (caso típico oc=11 → oc=54 → resposta → oc=21)

| # | Ação | Onde | Tempo | Observação |
|---|---|---|---|---|
| 1 | Vejo oc=11 nova no Cockpit | Cockpit | 10s | sistema já sugeriu opções |
| 2 | Olho histórico WhatsApp do cliente | WhatsApp | 30s | já respondeu? |
| 3 | Aprovo proposta "lançar 54 + email" no Cockpit | Cockpit | 5s | sistema lança SSW + dispara email com link |
| 4 | (Sistema espera resposta cliente) | — | 4d max | re-cobra em D+4 se sumir |
| 5 | Cliente responde — Cockpit move card pra VALIDAÇÃO | Cockpit | — | sistema tira lock |
| 6 | Leio resposta, decido oc 21 ou oc 55 | Cockpit | 30s | botão dinâmico |
| 7 | Aprovo lançamento da oc | Cockpit | 5s | sistema lança SSW |
| 8 | (Aguardo motorista executar) | — | 1-2 dias | |
| 9 | oc=01 ou oc=11 de novo aparece | SSW | — | sistema detecta e atualiza card |

## 9. Mensagens

(O texto final dos templates está em [Templates-Email-Tratativa-Entrega.docx](Templates-Email-Tratativa-Entrega.docx). Larissa preenche.)

## 10. Casos especiais

- **Cliente quer mudar endereço pra outra cidade**: peço autorização do pagador (quem emitiu a NF) antes. Vira sub-processo.
- **Cliente diz que mudou número de celular**: peço pra confirmar pelo email cadastrado pra evitar fraude.
- **Carga perecível com >2 dias parada**: aviso gestor + começo processo de devolução.
- **Vários CTRCs com a mesma NF (cliente faz coleta consolidada)**: trato cada CTRC separado.

> **Larissa, validar:** falta caso especial? O que aparece com frequência que não está aqui?

## 11. ⭐ QUANDO O PROCESSO TERMINA

### 11.1 Fim feliz (caso resolvido)

- [X] **oc=01** (Entrega Realizada) aparece no SSW. Sistema fecha card automático.
- [X] **oc=33** (Entrega realizada parcialmente) — para casos de oc=35 que terminaram sem reentregar a parte recusada.

### 11.2 Fim infeliz (sem entrega)

- [X] **oc=55** (Devolução autorizada) — cliente desistiu, NFD emitida.
- [X] Após 3ª tentativa frustrada + cliente não autoriza nova: encaminha pra processo "Devolução com sinistro".

### 11.3 Pode reabrir?

- [X] Sim, se motorista voltar com a carga (oc=11/10/35 nova após oc=21). Cria card novo, conta no histórico de tentativas.
- [X] Não, se já fechou em oc=01 ou oc=55. Caso terminou.

### 11.4 Quem é o último a tocar antes do fim

- **Fim oc=01**: motorista (lança no SSWMobile) → sistema detecta e fecha sozinho.
- **Fim oc=55**: Larissa confirma a NFD antes de marcar resolvido. Validação humana exigida.

### 11.5 Prazo máximo

- 4 dias sem resposta do cliente → re-cobra automaticamente (sistema).
- 8 dias sem resposta → marca como "inconclusivo" + Larissa trata manual.
- 15 dias sem qualquer evolução → escala pra gestor.

> **Larissa, validar:** prazos batem com a sua prática? Tem algum cenário de fim que esqueci?

## 12. Escalada pra fora do processo

| Situação | Pra onde / qual processo | Encaminhamento |
|---|---|---|
| 3ª oc=11/10/35 negada | Vira processo "Devolução com sinistro" | "NF X — 3ª recusa, autorizar perdas" |
| Cliente ameaça Procon | Gestor relacionamento + jurídico | Print da mensagem |
| Carga perecível >2d parada | Aciona gestor de operação | "Perecível NF Y, X dias parada" |
| Cliente quer indenização | Vira processo "Indenização" | Anexar histórico tratativa |
| Pagador (cliente NF) não responde 15 dias | Vira processo "Cobrança jurídica" | ... |

## 13. Frequência

- **Volume**: ~30 cards/dia da Larissa, sendo ~80% nesse processo (Tratativa de Problema de Entrega).
- **Tempo médio ativo**: 3-5min/card (sem contar espera de cliente).
- **Pico**: segunda de manhã (cargas que tentaram entregar sexta).
- **% que resolve sem escalar**: ~85%.

> **Larissa, validar:** os números batem? Quantos cards por dia de verdade?

## 14. O que dá problema

- Cliente que responde "ok obrigado" sem responder o que perguntei (vira "inconclusivo" — relógio reinicia).
- Cliente que mistura várias NFs na mesma mensagem (sistema às vezes vincula a NF errada).
- Carga que pousa em base errada (motorista não avisa, descubro tarde).
- Cliente que muda número de celular sem avisar.

> **Larissa, adiciona:** o que mais te dá retrabalho hoje?

## 15. Glossário

| Termo | Significa |
|---|---|
| Bastão | sistema interno de pendências (não é o SSW; é separado) |
| Tratativa | atendimento ativo de um caso (oposto de "encerrado") |
| Carteira | conjunto de clientes que cada operadora atende |
| Pousar | ficar parada numa base sem dar saída |
| Dar saída | sair pra entrega (oc=14) |
| NFD | Nota Fiscal de Devolução |
| NF com ressalva | NF original assinada pelo destinatário com anotação do que foi recusado |
| SSWMobile | app que motorista usa pra registrar foto/comprovante na rua |
| Pagador | quem paga o frete (geralmente o remetente, dono da carga) |

## 16. Dúvidas

- Quando cliente fala "tô quase chegando aí busca" — é retirada na base ou mudança de endereço? **Não tenho regra fixa, decido na hora.**
- Quando passar caso pra outra operadora? Hoje fica com quem pegou primeiro, não tem regra.
- oc=13 — quais CNPJs exatamente exigem tratativa? **Larissa lista na seção 4.**

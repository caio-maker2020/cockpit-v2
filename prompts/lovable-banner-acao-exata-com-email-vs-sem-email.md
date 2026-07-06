# Lovable — Banner mostra EXATAMENTE a ação; "54 + e-mail" e "54 SEM e-mail" são ações OPOSTAS

## Problema (NF 463457)
O banner de "ação recomendada" destacava a opção casando pelo **número da oc** (`proposta_destacada = 54`). Existem **dois todos diferentes com `codigo_ssw = 54`**: um que **lança a oc 54 E envia e-mail ao cliente** e outro que **lança SÓ a oc 54 SEM e-mail (não notifica)**. O banner mostrava "54 + e-mail (com template)" mas o clique acionava a "54 SEM e-mail" → a oc foi lançada e o cliente **nunca foi notificado**.

Essas duas são **ações completamente opostas** (tão diferentes quanto lançar 54 vs lançar 33). Nunca podem ser tratadas como a mesma coisa nem identificadas pelo número.

## Regra geral (inegociável)
**O banner/destaque e o botão devem SEMPRE refletir e executar EXATAMENTE a mesma ação.** Identifique cada ação pela `acao_key`, **nunca** pelo número `codigo_ssw`. Nunca faça merge/dedupe de dois todos só porque têm o mesmo `codigo_ssw`.

## Dados do backend (já no ar)

### Tabela `cards` (colunas jsonb)
- `analise_padrao_resultado.proposta_destacada` — número (54 | 56 | null) — **NÃO usar pra casar o destaque**.
- `analise_padrao_resultado.proposta_destacada_acao` — **NOVO** — string com a identidade PRECISA da ação recomendada, ex.: `"lancar_oc_e_enviar_email:54"`, `"lancar_ocorrencia:54"`, `"lancar_ocorrencia:56"`, ou `null`.
- `aviso_alteracao_oc.proposta_destacada_acao` — mesmo valor (o banner pode ler de qualquer um dos dois).
- `analise_padrao_resultado.template_email_sugerido` / `.corpo_email_sugerido` — já usados; continuam.

### Tabela `todos` (`proposta_payload` jsonb) — cada opção
- `proposta_payload.acao_key` — **NOVO** — identidade única da ação, formato `"<tool>:<codigo_ssw>"`.
- `proposta_payload.tool` — `"lancar_oc_e_enviar_email"` | `"lancar_ocorrencia"` | `"lancar_oc33_solo_portal"` | `"enviar_email_e_lancar_33_romaneio_interno"` | …
- `proposta_payload.meta.modo` — `"completo"` (ENVIA e-mail) | `"sem_email"` (NÃO envia).
- `proposta_payload.meta.sem_email_explicito` — `true` quando é a ação DELIBERADA "lançar a oc SEM notificar o cliente".
- `proposta_payload.meta.precisa_email_destino` — `true` quando é "+ e-mail" mas o cliente não tem contato cadastrado (operadora deve informar o destinatário no envio).
- `proposta_payload.recomendada` — `true` na ação recomendada do romaneio interno (já existente).
- `proposta_payload.descricao` (campo `descricao` do todo) — texto exato da ação.
- `proposta_payload.args.codigo_ssw` / `.template_id` / `.email_destino`.

## O que implementar

### 1. Escolher a ação destacada no banner (precedência)
1. Se algum todo pendente tem `proposta_payload.recomendada === true` → é esse (caso romaneio interno).
2. Senão, o todo pendente cujo `proposta_payload.acao_key === card.analise_padrao_resultado.proposta_destacada_acao` → é esse.
3. Senão → não há recomendação (operadora escolhe na lista, sem banner de "recomendada").

> Em (2), case por **string exata** `acao_key`. **Nunca** procure "o todo com codigo_ssw = proposta_destacada".

### 2. O banner mostra a ação exata
- Texto do banner = `descricao` do todo destacado, **literal**.
- Mostre o selo de e-mail conforme a regra abaixo.
- O botão "Aprovar/Executar" do banner deve disparar **aquele `todo.id`** (o mesmo todo destacado). Nada de re-resolver por número depois.

### 3. Renderização e aprovação de CADA opção da lista
Para cada todo pendente, determine o tipo pela `proposta_payload`:

- **Envia e-mail** (`meta.modo === 'completo'`):
  - Selo verde/azul: **"✉️ + E-MAIL AO CLIENTE"**.
  - Ao aprovar: abrir o **composer/preview de e-mail** (template `args.template_id`, destinatário `args.email_destino`).
  - Se `meta.precisa_email_destino === true`: **exigir** o destinatário antes de habilitar o botão de envio.

- **SEM e-mail deliberado** (`meta.sem_email_explicito === true`):
  - Selo âmbar/vermelho, visualmente distinto: **"🚫 SEM E-MAIL — o cliente NÃO será notificado"**.
  - Ao aprovar: **NÃO abrir o composer**. Mostrar uma **confirmação obrigatória**:
    > "Esta ação lança a oc {codigo_ssw} no SSW mas **NÃO envia e-mail**. O cliente **NÃO será notificado**. Confirmar?"
  - Só executa após o "Confirmar".

- **Lançamento simples sem e-mail** (demais, ex. oc 21/55/44/56 — `meta.modo === 'sem_email'` e **sem** `sem_email_explicito`):
  - Sem selo de e-mail. Aprovar lança direto (sem composer, sem confirmação de "não notifica").

### 4. As duas opções de oc 54 são DUAS linhas distintas
Quando o card tiver as duas (`lancar_oc_e_enviar_email:54` e `lancar_ocorrencia:54`), renderize **duas linhas separadas**, cada uma com sua `descricao`, seu selo e seu botão (vinculado ao seu próprio `todo.id` / `acao_key`). **Nunca** colapse, agrupe ou faça uma virar a outra. Sugestão de ordem: a recomendada em destaque no topo; a "SEM e-mail" abaixo e visualmente discreta (é uso de exceção).

### 5. Banner do Ressarcimento (se aplicável)
No banner de "ressarcimento pediu pra relançar a 54" (campos `ressarc54_*`), a ação recomendada é a **"54 SEM e-mail"** (cliente já foi notificado) — `acao_key = "lancar_ocorrencia:54"`, `meta.origem = "ressarcimento_relancar_54"`. Vincule o botão a esse todo específico (por `acao_key`/`origem`), também sem casar por número.

## Critério de aceite
- Clicar no que o banner mostra executa **exatamente** aquela ação (com-e-mail manda e-mail; sem-e-mail não manda e pede confirmação).
- Em cards com as duas opções de 54, é impossível clicar numa achando que é a outra.
- O selo de e-mail de cada linha bate com o comportamento real ao aprovar.

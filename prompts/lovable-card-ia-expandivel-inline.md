# Lovable — Card "RECOMENDADO PELO AGENTE IA" expandível inline

## Objetivo

Hoje o card de sugestão IA mostra só um resumo. Pra aprovar, o operador precisa pular pro painel direito (modal de oc=54+email), preencher template/email/anexos e aprovar. **Quebra o fluxo.**

Mudança: o próprio card IA ganha um botão **EXPANDIR** que abre INLINE tudo que aparece no painel direito (preview de email editável, anexos, validação de evidência). O botão "Aprovar oc=54+email" no card já dispara tudo — email + lançamento da oc — sem precisar tocar no painel direito.

**Outras opções** (oc=21/33/55/56 etc.) **mantêm o comportamento atual**: clique em "Ver outras opções →" abre o painel direito como hoje. Só a sugestão IA ganha tratamento inline.

## Backend: nada muda

Tudo já está pronto:
- RPC `aprovar_e_executar(p_todo_id, p_extras)` aceita `extras.email_destinatarios`, `extras.assunto_override`, `extras.template_id_override`, `extras.texto_email_customizado`, `extras.anexos_ids`, `extras.skip_email`.
- Executor faz email primeiro (atomicidade), depois lança oc=54.
- `cards.aviso_alteracao_oc` (quando `tipo='ia_sugestao_ocs_padrao'`) traz proposta_destacada, template_email_sugerido, motivo_extraido — já lido pelo front pra renderizar o card colapsado de hoje.

## Estados visuais

### Estado COLAPSADO (default — igual ao print atual)

```
┌──────────────────────────────────────────────────────────────────┐
│ ✨ RECOMENDADO PELO AGENTE IA                                    │
│                                                                  │
│ Lançar oc=54 + email — Falta de volume                           │
│ [Confiança: alta (85%) ✓]                                        │
│                                                                  │
│ │ "Eu, Sofia de Oliveira Rezende, mat 7213, recebi no dia        │
│ │ 26/05/26 as mercadorias, faltando 8 volumes da nota 424876..." │
│                                                                  │
│ oc=19 com motivo escrito identificado (instrução do motorista). │
│ Evidência boa — sugere notificar cliente (oc=54 + FALTA_..).    │
│                                                                  │
│  [✓ Aprovar oc=54+email]   [▾ Expandir]  Ver outras opções →    │
│                                       ✓ IA acertou · ✗ IA errou │
└──────────────────────────────────────────────────────────────────┘
```

Diferenças do print atual:
- Botão `[▾ Expandir]` novo, entre "Aprovar" e "Ver outras opções".
- Clique no botão "Aprovar" colapsado **continua disparando o aprovar com TODOS os defaults** (email do template original, destinatário sugerido, sem edição). Workflow rápido pra quando o operador confia 100% na IA.

### Estado EXPANDIDO (clica no `▾ Expandir`)

```
┌──────────────────────────────────────────────────────────────────┐
│ ✨ RECOMENDADO PELO AGENTE IA                          [▴ Recolher]│
│                                                                  │
│ Lançar oc=54 + email — Falta de volume                           │
│ [Confiança: alta (85%) ✓]                                        │
│                                                                  │
│ │ "Eu, Sofia... faltando 8 volumes da nota 424876..."            │
│ oc=19 com motivo escrito identificado. Evidência boa — ...       │
│                                                                  │
│ ─── EMAIL ──────────────────────────────────────────────────────  │
│                                                                  │
│ De:     LARISSA SAL EXPRESS <larissa@salexpress.com.br>          │
│                                                                  │
│ Para:   [contato@cliente.com.br ▾]   (default = resolver_email)  │
│ Cc:     [+ adicionar contato] (multi-select de contatos_cliente) │
│                                                                  │
│ Template: [FALTA_DE_VOLUME ▾]   (default = IA sugeriu)           │
│   • FALTA_DE_VOLUME (sugerido pela IA)                           │
│   • RECUSA_TOTAL                                                 │
│   • RECUSA_PARCIAL                                               │
│   • PROBLEMAS_COM_ENDERECO                                       │
│   • outros...                                                    │
│                                                                  │
│ Assunto: [Aguardando retorno — NF 424876________________]        │
│                                                                  │
│ Corpo:                                                           │
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │ Olá Carlos,                                                  │ │
│ │                                                              │ │
│ │ O destinatário da NF 424876 confirmou recebimento mas        │ │
│ │ registrou falta de volumes. Anotação do recebedor: "Eu,      │ │
│ │ Sofia de Oliveira Rezende, mat 7213, recebi no dia           │ │
│ │ 26/05/26 as mercadorias, faltando 8 volumes da nota          │ │
│ │ 424876, não sabendo se são pacotes com 46,25 ou 7 unidades." │ │
│ │                                                              │ │
│ │ Pode confirmar pra gente como deseja prosseguir — abertura   │ │
│ │ de RPA, ressarcimento, ou outra orientação?                  │ │
│ │                                                              │ │
│ │ A evidência registrada pelo motorista pode ser acessada      │ │
│ │ no link: <link_evidencia>                                    │ │
│ └──────────────────────────────────────────────────────────────┘ │
│   (totalmente editável)                                          │
│                                                                  │
│ Anexos: [📎 Adicionar arquivo] (até 5, 10MB cada)                │
│   (lista de uploads com [x] pra remover)                         │
│                                                                  │
│ [ ] Marcar como já enviado manualmente pelo Gmail                │
│     (pula envio, só lança a oc no SSW)                           │
│                                                                  │
│ ─── EVIDÊNCIA ───────────────────────────────────────────────────  │
│                                                                  │
│ IA Vision (oc=19): confiança 0.97                                │
│ Classificação: destinatario_com_ressalva ✓                       │
│ "Declaração manuscrita assinada pela destinatária Sofia de O.    │
│  Rezende, Almoxarifado Central da Secretaria de Saúde..."        │
│                                                                  │
│ [📷 Ver Foto] [🔄 Revalidar evidência]                            │
│                                                                  │
│ ─── AÇÃO ───────────────────────────────────────────────────────   │
│                                                                  │
│  [✓ Aprovar oc=54 + Email]      Ver outras opções →              │
│                                       ✓ IA acertou · ✗ IA errou │
└──────────────────────────────────────────────────────────────────┘
```

## Comportamento detalhado

### Botão `[▾ Expandir]` / `[▴ Recolher]`

- Estado padrão = colapsado.
- Transição com animação suave (height: max-content / overflow).
- Estado expandido persiste no navegador por card (localStorage) — se operador expandiu e navegou pra outra aba, volta expandido.

### Bloco EMAIL — defaults

- **De:** sempre `operadores.nome_email_outbound + email do Gmail OAuth` do operador logado. Read-only.
- **Para:** chama `supabase.rpc('resolver_email_cobranca_cliente', { p_documento_cliente: <cnpj>, p_tipo_uso: 'logistico' })` no carregamento. Resultado vira o default. Dropdown lista todos os contatos do cliente (`contatos_cliente` filtrado por CNPJ) pra trocar.
- **Cc:** multi-select de contatos. Vazio por default.
- **Template:** dropdown lista templates ativos de `templates_email` (filtra os ≠ COBRANCA_LEMBRETE_*). Default = `aviso_alteracao_oc.template_email_sugerido`. Marcar com badge "(sugerido pela IA)" o que veio do agente.
- **Assunto:** vem de `templates_email.assunto` com `{nf}` substituído. Editável.
- **Corpo:** vem de `templates_email.corpo_template` com placeholders renderizados:
  - `{primeiro_nome}` → primeiro nome do contato TO atual
  - `{nf}` → NF do card
  - `{operadora_nome}` → operadores.nome do operador logado
  - `{link_evidencia}` → URL Vercel `/r?t=<token>` (mesmo padrão atual)
  - Se for template `FALTA_DE_VOLUME` E houver `aviso_alteracao_oc.motivo_extraido` → injeta o motivo entre as primeiras linhas (igual ao `corpo_email_sugerido` que a IA já preparou em `analise_padrao_resultado.corpo_email_sugerido` — USE esse texto direto se existir, é mais inteligente que renderizar o template cru).

### Trocar template re-renderiza o corpo

- Se operador trocar o template no dropdown, mostra confirm: "Trocar o template vai substituir o texto atual. Continuar?" (só se já editou).
- Re-renderiza corpo + assunto com novo template.

### Anexos

- Mesma rotina atual do upload (`upload-anexo-email` edge function). Endpoint retorna UUID, lista local mostra `[nome.pdf] (1.2 MB) [x]`.

### Bloco EVIDÊNCIA

- Mostra `cards.ia_sugestao_evidencia[<codUltimaOc>]` se existir: confiança, classificação, descrição_imagem, transcrição manuscrita.
- Botão **Ver Foto**: chama edge function `foto-oc-card` (existente) e abre modal/dropdown com a imagem.
- Botão **Revalidar evidência**: chama edge function `verificar-evidencia-card` (existente).
- Se `cards.evidencia_status='ausente'` ou `'invalida'`, mostra banner amarelo com `cards.evidencia_diagnostico`.

### Bloco AÇÃO — comportamento do "Aprovar oc=54 + Email"

Quando operador clica:

```ts
const extras: Record<string, unknown> = {};

// Email
if (!skipEmailMarcado) {
  if (destinatarioMudou) extras.email_destinatarios = [destinatarioAtual];
  if (ccList.length > 0) extras.email_cc = ccList;
  if (templateMudou) extras.template_id_override = templateAtual;
  if (assuntoMudou) extras.assunto_override = assuntoAtual;
  if (corpoEditado) extras.texto_email_customizado = corpoAtual;
  if (anexosIds.length > 0) extras.anexos_ids = anexosIds;
} else {
  extras.skip_email = true;
}

await supabase.rpc('aprovar_e_executar', {
  p_todo_id: todoIdDaProposta54,  // da lista de todos pendentes, pega o oc=54
  p_extras: extras,
});
```

O executor faz o resto (atomicidade email→oc no SSW). Sem precisar abrir o painel direito.

### Erro / Feedback

- Após clicar Aprovar: botão vira spinner "Enviando email e lançando oc...".
- Toast de sucesso quando RPC retorna ok: "Email enviado pro cliente + oc=54 lançada no SSW".
- Erro: toast vermelho com motivo + manter card expandido pra operador ajustar e retentar.

### Outras opções (NÃO mexer)

- "Ver outras opções →" continua abrindo o painel direito como hoje. Sem mudança.

### Feedback IA acertou/errou (footer)

- "✓ IA acertou" / "✗ IA errou" continua igual ao print atual (clique grava em `agente_ocs_padrao_feedback`).
- Não substitui o feedback implícito que o backend já registra quando operador aprova oc diferente da sugerida (memory `feedback` no executor).

## Quando renderizar este card expandível

Mostrar o card "RECOMENDADO PELO AGENTE IA" (colapsado ou expandido) quando:

- `cards.aviso_alteracao_oc.tipo === 'ia_sugestao_ocs_padrao'`
- E existe um todo `pendente` com `proposta_payload.args.codigo_ssw === aviso_alteracao_oc.proposta_destacada` (= 54 hoje)

Se algum dos dois faltar, esconde o card (mantém só o painel direito atual com as propostas listadas).

## Smoke test

1. NF 424876 (oc=19, LARISSA) — abrir o card. Verificar que card IA aparece colapsado com texto "Lançar oc=54 + email — Falta de volume".
2. Clicar `▾ Expandir` → bloco completo aparece com email pré-preenchido com transcrição da Sofia, template `FALTA_DE_VOLUME` selecionado, anexo vazio.
3. Editar 1 palavra no corpo. Trocar template pra `RECUSA_TOTAL` → modal confirma sobrescrita.
4. Clicar `[✓ Aprovar oc=54 + Email]` → spinner → toast sucesso.
5. Conferir no DB: `card_events` tem `RespostaEnviada` (email) + `AcaoExecutada` (oc=54). Card state = `ACAO_EXECUTADA`.
6. Em outro card sem sugestão IA (ex: oc=49) — card IA NÃO aparece, painel direito como hoje.

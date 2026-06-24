# Lovable — oc 44 (devolução) SEMPRE pede volumes + motivo, inclusive pelo banner

## Contexto / bug

Quando a operadora lança a **oc 44** (retorno de carga → setor de Devolução), o
Cockpit precisa coletar **quantidade de volumes** e **motivo da devolução** num modal,
porque essa info vai pro SSW e é o que o setor de Devolução lê pra tratar.

Hoje, quando a oc 44 vem como **sugestão do agente no banner** (topo do card), a
operadora consegue clicar e **aprovar direto pelo banner**, sem o modal aparecer — e o
lançamento vai sem (ou com) os dados de forma inconsistente. Caso real: **NF 59299**
(Larissa) — aprovada direto pelo banner.

O backend já foi blindado: **a oc 44 NÃO é mais lançada sem `quantidade_volumes` +
`motivo`** — o executor rejeita o todo com erro claro. Mas pra UX não dar erro, o
**front precisa garantir que o modal SEMPRE apareça** antes de aprovar qualquer oc 44.

## O que mudar

**Regra única:** qualquer caminho de aprovação de uma ação cujo
`proposta_payload.args.codigo_ssw === 44` (ou `tool === 'lancar_combo_33_44'`)
DEVE abrir o **modal de devolução** antes de submeter — **nunca** lançar direto.

Isso vale para os dois pontos de entrada:

1. **Lista "Ações propostas / sugeridas"** no detalhe do card — provavelmente já abre o
   modal hoje. Manter.
2. **Banner de sugestão do agente** (topo do card, "IA sugeriu: ..."). Hoje o botão de
   aprovar do banner lança direto. Para oc 44, ele **NÃO pode aprovar direto** — tem que
   **abrir o mesmo modal de devolução** (reaproveitar o componente do ponto 1). Só
   depois que a operadora preenche e confirma é que o todo é aprovado/executado.

   - Se o banner tiver um botão genérico "Aprovar", para `codigo_ssw === 44` troque o
     comportamento por "abrir modal de devolução" (mesmo handler do item da lista).
   - Para as demais ocs, o banner segue como está.

## Modal de devolução — campos

- **Quantidade de volumes** — `quantidade_volumes` — **obrigatório** (número, ≥ 1).
- **Motivo da devolução** — `motivo` — **obrigatório** (texto).
- **Filial** — `filial` — opcional.

O botão de confirmar do modal fica **desabilitado** enquanto `quantidade_volumes` ou
`motivo` estiverem vazios (validação no front, espelhando o backend).

## Shape do payload ao aprovar

Mandar os campos em `extras` (mesma estrutura de hoje), via
`supabase.functions.invoke(...)` da aprovação:

**oc 44 standalone:**
```jsonc
{
  "tool": "lancar_ocorrencia",
  "args": {
    "codigo_ssw": 44,
    "extras": {
      "quantidade_volumes": "2",       // obrigatório
      "motivo": "DESACORDO COMERCIAL", // obrigatório
      "filial": "POA"                  // opcional
    }
  }
}
```

**combo 33+44** (quando aplicável) — os dados da 44 vão aninhados em `combo_44`:
```jsonc
{
  "tool": "lancar_combo_33_44",
  "args": {
    "codigo_ssw": 33,
    "extras": {
      "combo_44": {
        "quantidade_volumes": "2",       // obrigatório
        "motivo": "DESACORDO COMERCIAL", // obrigatório
        "filial": "POA"
      }
    }
  }
}
```

## Por que (não remover essa regra depois)

Sem `quantidade_volumes` + `motivo`, o setor de Devolução recebe a oc 44 sem saber
quantos volumes voltam nem por quê → não consegue tratar. O backend agora **bloqueia**
o lançamento nesse caso (erro no todo), então deixar o banner aprovar direto só geraria
falha visível pra operadora. O modal obrigatório é o caminho feliz.

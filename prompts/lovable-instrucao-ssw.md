# Lovable — Mostrar instrução do SSW junto com a última ocorrência

## Contexto

A operação lança ocorrências no SSW e, junto com o código (ex: 49), preenche um campo de "instrução" com texto livre que dá contexto adicional pra Larissa.

**Exemplo real (NF 196537):**
- Última ocorrência: `49 - Tratativa de relacionamento`
- **Instrução**: `"CLIENTE BLOQUEADO"`

Sem esse texto, Larissa abre o SSW manualmente pra entender. Com ele visível no Cockpit, ela já sabe o que tratar (ex: "cliente bloqueado por falta de pagamento → escalar pro financeiro").

Outros exemplos vivos no banco hoje:
- oc=58: `"AGUARDANDO LIBERACAO DO SETOR DE DEVOLUCAO"`
- oc=56: `"FOTO/NFD"`
- oc=56: `"CLIENTE SE RECUSA A FAZER A RESSALVA"`
- oc=55: `"01 VOL RECEBIDO EM PEND BHZ, SEGUE HOJE"`
- oc=14: `"VOLUME LOCALIZADO (SSWMOBILE)"`

## Onde mostrar

No **header do card** detalhado, **logo abaixo** do código + descrição da última ocorrência (onde hoje aparece "49 - Tratativa de relacionamento" ou equivalente).

## Visual sugerido

```
┌──────────────────────────────────────────────────────┐
│ NF 196537 — INOVA MED                                │
│                                                       │
│ Última ocorrência:                                   │
│   49 — Tratativa de relacionamento                   │
│                                                       │
│   📌 Instrução SSW: CLIENTE BLOQUEADO                │
└──────────────────────────────────────────────────────┘
```

Tom visual: cinza/azul-discreto, **NÃO** alarmante (não é erro, é só info). Pode ser uma linha pequena com label + valor — tipo um chip ou pill.

## Fonte do dado

Já está no card. Campo:
```ts
card.agent_state?.instrucao_ultima_ocorrencia: string | null
```

(O sync-bastao puxa isso do Bastão a cada execução e atualiza `cards.agent_state.instrucao_ultima_ocorrencia`. Sem mudança de backend necessária.)

## Componente React

```tsx
interface CardWithAgentState {
  cod_ultima_ocorrencia: number | null;
  agent_state: {
    instrucao_ultima_ocorrencia?: string | null;
    [k: string]: unknown;
  } | null;
}

function InstrucaoSSW({ card }: { card: CardWithAgentState }) {
  const instrucao = card.agent_state?.instrucao_ultima_ocorrencia?.trim();
  if (!instrucao) return null;

  // Filtra ruído de instruções "óbvias" que não agregam (texto que só repete a oc).
  // Ex: oc=54 vem com "Aguardando retorno do cliente pagador  (SSW WebAPI Parceiro)" —
  // não vale a pena mostrar; já está claro pelo nome da oc.
  const RUIDO = [
    'aguardando retorno do cliente pagador',
    'recebimento encerrado',
    '(sswmobile)',
    '(ssw webapi parceiro)',
  ];
  const baixo = instrucao.toLowerCase();
  const ehRuido = RUIDO.some((r) => baixo === r || baixo === r + '.');
  if (ehRuido) return null;

  return (
    <div className="mt-1 flex items-start gap-1.5 text-sm text-slate-700">
      <span className="text-slate-400">📌</span>
      <div>
        <span className="text-slate-500 mr-1">Instrução SSW:</span>
        <span className="font-medium">{instrucao}</span>
      </div>
    </div>
  );
}
```

## Onde inserir

No componente onde você renderiza a oc (provavelmente `CardDetail.tsx`, `CardHeader.tsx` ou similar), logo após o código + descrição:

```tsx
<div>
  <span className="text-slate-500">Última ocorrência:</span>
  <span className="font-semibold ml-1">
    {card.cod_ultima_ocorrencia} — {nomeDaOcorrencia(card.cod_ultima_ocorrencia)}
  </span>
  <InstrucaoSSW card={card} />   {/* ← novo */}
</div>
```

## Comportamento garantido

- ✅ Aparece automaticamente em todos os cards com `agent_state.instrucao_ultima_ocorrencia` preenchido (já populado pra todos os cards ativos).
- ✅ Não aparece quando o campo é null/vazio (sem placeholder ruim tipo "(sem instrução)").
- ✅ Filtra ruído de strings genéricas que só repetem a oc.
- ✅ Atualiza junto com o resto do card via realtime/refetch — sync-bastao reescreve a cada 2 minutos.

## Resumo em 1 frase

Adicionar 1 componente `<InstrucaoSSW card={card} />` logo abaixo da última ocorrência, lendo `card.agent_state.instrucao_ultima_ocorrencia`. Sem mudança de backend.

# Lovable — Nova aba "AÇÃO EXECUTADA" + alerta Bastão atrasado

## Contexto

Quando Larissa aprova uma ação no Cockpit (ex: lançar oc=54+email), o executor lança no SSW. Após sucesso, o **Bastão** (sistema interno que abastece o Cockpit) demora pra incorporar essa nova ocorrência — pode levar até 1h+.

Antes desse fix: card ia direto pra "AGUARDANDO CLIENTE", e o sync-bastao podia regredir o card pra AGUARDANDO_VOCE com a oc antiga (Bastão atrasado), fazendo Larissa achar que precisava aprovar de novo. Bug real: NF 196537 ficou aprovando oc=54 duas vezes e mandando 2 emails ao cliente.

**Agora:** Card vai pra `state='ACAO_EXECUTADA'` (lock=true) e fica congelado **até Bastão confirmar a oc**. Sem aprovação, sem regressão. Quando Pass A do sync-bastao reconhecer que `Bastão.oc == card.oc`, libera pro state final (oc=54 → AGUARDANDO_CLIENTE; outras → TRANSFERIDO etc).

## O que adicionar no Lovable

### 1. Nova aba/coluna no Kanban: "AÇÃO EXECUTADA"

Filtra cards onde `state = 'ACAO_EXECUTADA'`. Layout sugerido (entre "AGUARDANDO VOCÊ" e "AGUARDANDO CLIENTE"):

```
┌──────────────────┐
│ AÇÃO EXECUTADA   │
│ aguardando Bastão│
│                  │
│  [card 1]        │
│  ⏱ há 12 min     │
│                  │
│  [card 2]        │
│  ⚠ Bastão atrasado│
│  há 1h32min      │
└──────────────────┘
```

Cards mostram:
- **Linha principal:** NF + cliente + última ocorrência lançada
- **Countdown:** `⏱ Lançado há X min` calculado a partir de `cards.acao_executada_em`
- **Alerta Bastão atrasado:** SE `now() - acao_executada_em > 1h`, badge vermelho "⚠ BASTÃO ATRASADO" — operadora pode investigar manualmente.

### 2. No detalhe do card (quando aberto em ACAO_EXECUTADA)

```
┌────────────────────────────────────────────────────────┐
│ ✓ AÇÃO EXECUTADA com sucesso                           │
│                                                         │
│ Você lançou oc {cod_ultima_ocorrencia} no SSW.         │
│ Aguardando Bastão sincronizar pra confirmar.           │
│                                                         │
│ Tempo desde execução: {now - acao_executada_em}        │
│                                                         │
│ ⚠ Após 1h sem confirmação, o Bastão pode estar         │
│   atrasado. Olha o SSW manualmente se quiser.          │
│                                                         │
│ [Ver histórico SSW] [Forçar atualização]               │
└────────────────────────────────────────────────────────┘
```

**Botões:**
- "Ver histórico SSW" — abre link SSW da NF.
- "Forçar atualização" — chama edge function `atualizar-card-via-tracking` (já existe) pra forçar sync imediato.

**Importante:** Card NÃO mostra propostas de ação. Não tem botão APROVAR. Está congelado.

### 3. Hook React pra computar countdown

```tsx
function useTempoDesdeAcao(acaoExecutadaEm: string | null) {
  const [agora, setAgora] = useState(Date.now());
  
  useEffect(() => {
    if (!acaoExecutadaEm) return;
    const id = setInterval(() => setAgora(Date.now()), 30_000); // refresh a cada 30s
    return () => clearInterval(id);
  }, [acaoExecutadaEm]);

  if (!acaoExecutadaEm) return null;
  const ms = agora - new Date(acaoExecutadaEm).getTime();
  const min = Math.floor(ms / 60_000);
  const horas = Math.floor(min / 60);
  
  return {
    minutos: min,
    label: horas >= 1 ? `há ${horas}h${min % 60}min` : `há ${min}min`,
    bastaoAtrasado: min >= 60,
  };
}
```

### 4. Componente da aba

```tsx
function AbaAcaoExecutada({ cards }: { cards: Card[] }) {
  return (
    <div className="kanban-column">
      <div className="kanban-header bg-blue-50">
        <h3>✓ AÇÃO EXECUTADA</h3>
        <p className="text-xs text-slate-500">aguardando Bastão sincronizar</p>
      </div>
      <div className="cards">
        {cards.map((c) => (
          <CardAcaoExecutada key={c.id} card={c} />
        ))}
      </div>
    </div>
  );
}

function CardAcaoExecutada({ card }: { card: Card }) {
  const tempo = useTempoDesdeAcao(card.acao_executada_em);
  return (
    <div className={`card-ae ${tempo?.bastaoAtrasado ? 'border-red-400' : 'border-blue-300'}`}>
      <div className="text-sm font-semibold">{card.empresa_cliente}</div>
      <div className="text-xs text-slate-600">NF {card.nf} • oc {card.cod_ultima_ocorrencia}</div>
      {tempo && (
        <div className={`text-xs mt-1 ${tempo.bastaoAtrasado ? 'text-red-600 font-bold' : 'text-slate-500'}`}>
          {tempo.bastaoAtrasado ? '⚠ Bastão atrasado' : '⏱'} {tempo.label}
        </div>
      )}
    </div>
  );
}
```

## Comportamento garantido (backend)

- ✅ Card entra em ACAO_EXECUTADA logo após executor confirmar SSW (sucesso 200, protocolo).
- ✅ `acao_executada_em` é timestamp UTC do momento do sucesso.
- ✅ `lock_aguardando_validacao = true` — RPCs `aprovar_e_executar` e `voltar_para_to_do` rejeitam aprovações nesse state.
- ✅ Pass A do sync-bastao libera card automaticamente quando Bastão.oc == card.oc:
  - oc=54 → AGUARDANDO_CLIENTE
  - oc finalizadora (1/30/32) → RESOLVIDO
  - oc relacionamento (não 54) → AGUARDANDO_VALIDACAO_HUMANA + lock
  - outras → TRANSFERIDO
- ✅ Card_event `AcaoExecutadaConfirmadaPeloBastao` registra a transição.

## Resumo em 1 frase

Nova aba "AÇÃO EXECUTADA" entre "AGUARDANDO VOCÊ" e "AGUARDANDO CLIENTE" mostra cards lançados aguardando Bastão sincronizar; conta tempo via `cards.acao_executada_em`; alerta vermelho após 1h; sem propostas/aprovações nesse state.

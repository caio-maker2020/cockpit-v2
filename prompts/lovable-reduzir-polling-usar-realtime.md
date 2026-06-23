PROMPT Lovable — Reduzir polling / usar realtime (alívio de carga no banco)

## Contexto (pra você entender o porquê)
No apagão de 2026-06-23 o banco saturou. Parte da carga vem do **front perguntando ao
banco "tem novidade?" com frequência alta demais**. Medimos no banco: em poucos minutos
o front chamou `messages_inbox` ~2.400 vezes, `cards_emails_outbound` ~1.200 vezes, além
de `cards` e `v_cards_requer_atencao`. O backend já foi otimizado; agora preciso que o
front pare de criar fila desnecessária.

## Objetivo
Trocar **polling por intervalo** por **realtime do Supabase** onde der, e onde polling for
mesmo necessário, **espaçar** e **parar quando a aba não está visível**.

## O que fazer

### 1. Preferir realtime a setInterval
Onde a tela hoje faz `setInterval(() => refetch(), Xms)` em cima de `cards`, `todos`,
`messages_inbox` ou `cards_emails_outbound`, troque por uma subscription:
```ts
const ch = supabase
  .channel('cards-do-operador')
  .on('postgres_changes',
      { event: '*', schema: 'public', table: 'cards' },
      () => refetchDebounced())   // refetch com debounce de ~1s, não a cada evento
  .subscribe();
// no cleanup do componente:
return () => { supabase.removeChannel(ch); };
```
A RLS já filtra pro operador, então a subscription só recebe o que ele pode ver.

### 2. Polling que sobrar: espaçar + pausar fora de foco
Para qualquer polling que não dê pra virar realtime agora:
- Intervalo **mínimo de 30s** (não 5s/10s).
- **Pausar quando a aba não está visível**: usar `document.visibilityState`. Não adianta
  ficar consultando com a aba em segundo plano.
```ts
useEffect(() => {
  let id: any;
  const tick = () => { if (document.visibilityState === 'visible') refetch(); };
  const start = () => { id = setInterval(tick, 30000); };
  start();
  document.addEventListener('visibilitychange', tick); // refetch na hora que volta o foco
  return () => { clearInterval(id); document.removeEventListener('visibilitychange', tick); };
}, []);
```

### 3. Não refazer a mesma busca em vários componentes
Se várias telas/componentes buscam `cards`/`messages_inbox` separadamente, centralize num
único hook/estado compartilhado (ex.: React Query com `staleTime` de ~30s e a MESMA query
key) pra não multiplicar a mesma chamada.

### 4. Aba ⚠️ CONFLITOS (v_cards_requer_atencao)
Essa aba não precisa de polling agressivo — o normal é estar vazia. Carrega 1× ao abrir a
aba + um refetch via realtime de `cards`. Sem `setInterval` curto.

## Resultado esperado
Queda grande no número de chamadas ao banco sem o operador perceber atraso (realtime é
mais rápido que polling, inclusive). Me avise quando aplicar que eu confirmo no banco se o
volume de chamadas caiu.

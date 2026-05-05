# Cockpit — Botões da auto-proposta oc=20 (Aprovar / Voltar p/ To-Do)

> Cole esse prompt no Lovable. **Mudança cirúrgica** no card da aba
> "AGUARDANDO VALIDAÇÃO HUMANA". Não mexe em mais nada.

---

## Contexto

A regra atual: **toda NF com `cod_ultima_ocorrencia=20` (Extravio
localizado)** ganha auto-proposta de "Lançar oc 55 no SSW — autorizado a
seguir entrega". Vai pra **AGUARDANDO VALIDAÇÃO HUMANA** com lock ativo.

Essa proposta específica deve ter **apenas 2 ações**:

1. **Aprovar e Executar** → API SSW dispara a oc 55
2. **Voltar para o To-Do** → manda card de volta pra **PARA FAZER**, mantém proposta pendente

**Não tem botão Rejeitar** nesse caso — porque a opção de "lançar 55" é
sempre válida pra oc=20, ela só pode ser feita agora ou depois. Rejeitar
seria contraditório com o padrão.

(Outras propostas IA que vierem no futuro podem ter regras diferentes —
isso é específico da regra `oc=20→55`.)

A RPC do backend já está pronta: `voltar_para_to_do(p_todo_id, p_motivo)`.

---

## 1. Detecção da regra "oc=20"

No componente que renderiza o card em **AGUARDANDO VALIDAÇÃO HUMANA**,
diferenciar pela `cod_ultima_ocorrencia` do card:

```tsx
const ehPropostaOc20 = card.cod_ultima_ocorrencia === 20;
```

Use isso pra escolher o conjunto de botões.

---

## 2. Layout — só 2 botões pra oc=20

```tsx
{ehPropostaOc20 ? (
  // Caso especial: oc=20 → Aprovar (lança 55) ou Voltar p/ To-Do
  <div className="flex flex-col sm:flex-row gap-2 mt-4">
    <button
      onClick={() => handleAprovar(todo.id)}
      disabled={loading === todo.id}
      title="Dispara a oc 55 (Autorizado a seguir entrega) no SSW via API"
      className="flex-1 bg-sal text-paper font-mono text-xs font-600 uppercase tracking-widest px-6 py-3 border-2 border-ink shadow-flat hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-flat-sm active:translate-x-[2px] active:translate-y-[2px] active:shadow-none disabled:opacity-40 transition-all"
    >
      {loading === todo.id ? 'Executando...' : 'Aprovar e Executar →'}
    </button>

    <button
      onClick={() => handleVoltar(todo.id)}
      disabled={loading === todo.id}
      title="Volta o card pra aba PARA FAZER e mantém a proposta disponível pra aprovação futura."
      className="flex-1 bg-paper text-ink font-mono text-xs font-600 uppercase tracking-widest px-6 py-3 border-2 border-ink shadow-flat hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-flat-sm active:translate-x-[2px] active:translate-y-[2px] active:shadow-none disabled:opacity-40 transition-all"
    >
      ← Voltar p/ To-Do
    </button>
  </div>
) : (
  // Demais propostas: comportamento atual (Aprovar + Rejeitar)
  <div className="flex flex-col sm:flex-row gap-2 mt-4">
    <button
      onClick={() => handleAprovar(todo.id)}
      disabled={loading === todo.id}
      className="flex-1 bg-sal text-paper font-mono text-xs font-600 uppercase tracking-widest px-6 py-3 border-2 border-ink shadow-flat hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-flat-sm active:translate-x-[2px] active:translate-y-[2px] active:shadow-none disabled:opacity-40 transition-all"
    >
      {loading === todo.id ? 'Executando...' : 'Aprovar e Executar →'}
    </button>

    <button
      onClick={() => handleRejeitar(todo.id)}
      disabled={loading === todo.id}
      className="flex-1 bg-paper text-ink-soft font-mono text-xs font-600 uppercase tracking-widest px-6 py-3 border-2 border-ink-soft hover:text-ink hover:border-ink disabled:opacity-40 transition-colors"
    >
      Rejeitar
    </button>
  </div>
)}
```

---

## 3. Handler `handleVoltar`

```tsx
async function handleVoltar(todoId: string) {
  // Motivo opcional — clica OK sem digitar nada e segue
  const motivo = window.prompt(
    'Motivo (opcional) pra voltar essa proposta pro To-Do:',
    ''
  );

  // Cancelar prompt → não faz nada
  if (motivo === null) return;

  setLoading(todoId);

  const { error } = await supabase.rpc('voltar_para_to_do', {
    p_todo_id: todoId,
    p_motivo: motivo.trim() || null,
  });

  setLoading(null);

  if (error) {
    toast.error(`Não foi possível voltar: ${error.message}`);
    return;
  }

  toast.success('Proposta voltou pra "Para Fazer". Você pode aprovar depois.');

  // Refresh do Kanban (adapte conforme pattern atual:
  // react-query / swr / manual refetch / etc.)
  queryClient.invalidateQueries(['cards']);
}
```

**Versão alternativa sem motivo** (clique = ação imediata):

```tsx
async function handleVoltar(todoId: string) {
  setLoading(todoId);
  const { error } = await supabase.rpc('voltar_para_to_do', {
    p_todo_id: todoId,
    p_motivo: null,
  });
  setLoading(null);
  if (error) { toast.error(error.message); return; }
  toast.success('Proposta voltou pra "Para Fazer".');
  queryClient.invalidateQueries(['cards']);
}
```

Use uma das duas — sugestão é a **com prompt**, registra o porquê em
`card_events.TodoVoltadoParaToDo.payload.motivo` pra auditoria depois.

---

## 4. Fluxo esperado

1. Card com oc=20 entra em **AGUARDANDO VALIDAÇÃO HUMANA** (auto-proposta de oc 55)
2. Larissa abre o card → vê **2 botões**: "Aprovar e Executar →" e "← Voltar p/ To-Do"
3. **Cenário A** — clica Aprovar:
   - RPC `aprovar_e_executar` → executor lança oc 55 no SSW (via codigo_api 58)
   - Card vai pra `EXECUTANDO_ACAO`, depois pra `RESOLVIDO` (via Pass C)
4. **Cenário B** — clica Voltar p/ To-Do:
   - (Opcional) digita motivo → RPC `voltar_para_to_do`
   - Card volta pra aba **PARA FAZER** (`AGUARDANDO_AGENTE`)
   - Lock destravado
   - Todo continua `pendente`
   - Quando Larissa quiser aprovar depois, abre o card de novo → toda hora ela tem o botão Aprovar disponível

---

## 5. Checklist

- [ ] Detectar `card.cod_ultima_ocorrencia === 20` no componente de validação humana
- [ ] Renderizar **só 2 botões** quando oc=20: Aprovar / Voltar p/ To-Do
- [ ] Manter os botões antigos (Aprovar/Rejeitar) pras outras propostas
- [ ] Implementar `handleVoltar(todoId)` chamando RPC `voltar_para_to_do`
- [ ] Toast de sucesso/erro
- [ ] Refresh do Kanban após sucesso
- [ ] Testar com NF 757022 (que tem proposta pendente atualmente)
- [ ] Testar fluxo completo: Voltar p/ To-Do → card aparece em PARA FAZER → Aprovar de lá → executor dispara oc 55
- [ ] Verificar `card_event` `TodoVoltadoParaToDo` no histórico

---

## Resultado esperado

Card oc=20 = 2 ações limpas e óbvias. Larissa nunca sente que está "preso"
ou que precisa decidir contra a vontade — ou aprova agora, ou volta pro
to-do e decide depois.

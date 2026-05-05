# Cockpit — Aba "Aguardando Validação Humana" v2 (leve + 3 botões universais)

> Cole esse prompt INTEIRO no Lovable. **Substitui** o prompt anterior
> `lovable-voltar-para-to-do.md` (que tinha lógica condicional por oc).
> Aplica a TODOS os cards dessa aba, independente da regra de auto-proposta.

---

## Contexto

### A regra do lock (confirmada)

Quando o sistema gera uma auto-proposta de ação (lançar oc no SSW,
responder cliente, etc), o card vai pra `AGUARDANDO_VALIDACAO_HUMANA`
com `lock_aguardando_validacao=true`. Daí pra frente, o card **fica
travado** — o sync-bastao não mexe nele, não muda de estado por conta
própria. Só sai por ação humana explícita.

### Por que "Voltar p/ To-Do" em TODOS os cards (não só oc=20)

Estamos em fase de teste. Em qualquer regra futura (oc=20→55 hoje, e
outras que vão surgir), a IA pode propor algo equivocado por:
- Bastão com dado incompleto
- Snapshot desatualizado
- Edge case que ainda não mapeamos

Sem rede de segurança, Larissa fica travada nesse card. Com o botão
"Voltar p/ To-Do" universal, ela sempre tem saída: destrava o lock,
volta o card pra **PARA FAZER**, e toca manual. Todo continua pendente
pra aprovar depois se quiser.

### Por que o card está pesado

Hoje cada card mostra muito detalhe (proposta + rationale técnico +
payload + 2 botões grandes + sombras + bordas grossas). Quando a fila
crescer pra 10-20 cards/dia, vai sobrecarregar visual. Card precisa ser
**escaneável em 1 segundo**.

---

## 1. Lógica: 3 botões em TODOS os cards de validação humana

```tsx
// Aplicar em TODOS os cards na aba AGUARDANDO_VALIDACAO_HUMANA
// Não tem mais condicional por oc — sempre os 3 botões.

<div className="flex items-center gap-1.5">
  <button
    onClick={() => handleAprovar(todo.id)}
    disabled={loading === todo.id}
    title="Executa a ação proposta automaticamente"
    className="flex-1 bg-sal text-paper font-mono text-[10px] font-600 uppercase tracking-wider px-3 py-1.5 hover:bg-ink transition-colors disabled:opacity-40"
  >
    {loading === todo.id ? '...' : 'Aprovar →'}
  </button>

  <button
    onClick={() => handleVoltar(todo.id)}
    disabled={loading === todo.id}
    title="Destrava o card e volta pra aba PARA FAZER. Mantém a proposta disponível pra aprovação posterior."
    className="flex-1 bg-paper text-ink font-mono text-[10px] font-600 uppercase tracking-wider px-3 py-1.5 border border-ink/30 hover:border-ink transition-colors disabled:opacity-40"
  >
    ← Voltar
  </button>

  <button
    onClick={() => handleRejeitar(todo.id)}
    disabled={loading === todo.id}
    title="Cancela a proposta. O card sai do lock pro estado coerente com a oc atual."
    className="px-2 py-1.5 font-mono text-[10px] uppercase tracking-wider text-ink/50 hover:text-sal transition-colors disabled:opacity-40"
  >
    Rejeitar
  </button>
</div>
```

**Hierarquia visual** (de mais peso pra menos):
1. **Aprovar →** — vermelho Sal sólido. Ação primária e mais usada.
2. **← Voltar** — outline cinza claro. Saída de emergência sempre presente.
3. **Rejeitar** — só texto, sem borda. Ação rara e definitiva.

---

## 2. Handlers

```tsx
async function handleAprovar(todoId: string) {
  setLoading(todoId);
  const { error } = await supabase.rpc('aprovar_e_executar', { p_todo_id: todoId });
  setLoading(null);
  if (error) { toast.error(error.message); return; }
  toast.success('Aprovado. Executando...');
  queryClient.invalidateQueries(['cards']);
}

async function handleVoltar(todoId: string) {
  // Sem prompt de motivo — clique imediato. Em fase de teste, simplicidade > auditoria.
  setLoading(todoId);
  const { error } = await supabase.rpc('voltar_para_to_do', {
    p_todo_id: todoId,
    p_motivo: null,
  });
  setLoading(null);
  if (error) { toast.error(error.message); return; }
  toast.success('Voltou pra "Para Fazer".');
  queryClient.invalidateQueries(['cards']);
}

async function handleRejeitar(todoId: string) {
  const motivo = window.prompt('Motivo da rejeição (obrigatório, mín 3 chars):');
  if (!motivo || motivo.trim().length < 3) {
    toast.error('Motivo precisa ter ao menos 3 caracteres');
    return;
  }
  setLoading(todoId);
  const { error } = await supabase.rpc('rejeitar_acao', {
    p_todo_id: todoId,
    p_motivo: motivo.trim(),
  });
  setLoading(null);
  if (error) { toast.error(error.message); return; }
  toast.success('Rejeitado.');
  queryClient.invalidateQueries(['cards']);
}
```

---

## 3. Redesign do card — versão leve

### Antes (pesado)

```
┌────────────────────────────────────┐
│  ████████ NF 757022 ████████       │
│  ████ Cliente: ACME LTDA ████      │
│                                    │
│  Última ocorrência: 20             │
│  Extravio localizado               │
│  04 VOLS RECEBIDO DE UDE...        │
│                                    │
│  ╔════ AÇÃO PROPOSTA ════╗         │
│  ║ Lançar oc 55 no SSW   ║         │
│  ║ Padrão Larissa: após  ║         │
│  ║ oc=20 (extravio loca- ║         │
│  ║ lizado), próximo passo║         │
│  ║ é oc 55 (autorizado..)║         │
│  ╚════════════════════════╝         │
│                                    │
│  [chave_cte: 31260421...]          │
│  [codigo_api: 58]                  │
│                                    │
│  ┌──────────┐  ┌──────────┐        │
│  │ APROVAR  │  │ REJEITAR │        │
│  └──────────┘  └──────────┘        │
└────────────────────────────────────┘
```

### Depois (leve)

```
┌──────────────────────────────────────┐
│ NF 757022 · ACME · oc 20             │ ← header 1 linha
│                                      │
│ Lançar oc 55 no SSW                  │ ← proposta em 1 linha clara
│                                      │
│ [Aprovar →] [← Voltar] [Rejeitar]    │ ← 3 botões compactos
│                                      │
│ ▸ detalhes técnicos                  │ ← collapsed por default
└──────────────────────────────────────┘
```

### Componente novo

```tsx
function CardValidacaoHumana({ card, todo }: Props) {
  const [showDetails, setShowDetails] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);

  const proposta = todo.proposta_payload;
  const acao = proposta?.args?.codigo_ssw
    ? `Lançar oc ${proposta.args.codigo_ssw} no SSW`
    : todo.descricao;

  return (
    <div className="bg-paper border border-ink/15 p-4 hover:border-ink/40 transition-colors">

      {/* Header: NF · cliente · oc — 1 linha discreta */}
      <div className="flex items-baseline gap-2 font-mono text-[10px] uppercase tracking-wider text-ink-soft mb-3">
        <span className="text-ink font-600">NF {card.nf}</span>
        <span className="text-ink/30">·</span>
        <span className="truncate">{card.empresa_cliente ?? '—'}</span>
        <span className="text-ink/30">·</span>
        <span>oc {card.cod_ultima_ocorrencia ?? '—'}</span>
      </div>

      {/* Proposta IA — 1 linha clara em destaque editorial */}
      <div className="font-display text-base text-ink leading-tight mb-4">
        {acao}
      </div>

      {/* 3 botões compactos — usar Lógica acima */}
      <div className="flex items-center gap-1.5">
        <button onClick={() => handleAprovar(todo.id)} disabled={loading === todo.id}
          className="flex-1 bg-sal text-paper font-mono text-[10px] font-600 uppercase tracking-wider px-3 py-1.5 hover:bg-ink transition-colors disabled:opacity-40">
          {loading === todo.id ? '...' : 'Aprovar →'}
        </button>
        <button onClick={() => handleVoltar(todo.id)} disabled={loading === todo.id}
          className="flex-1 bg-paper text-ink font-mono text-[10px] font-600 uppercase tracking-wider px-3 py-1.5 border border-ink/30 hover:border-ink transition-colors disabled:opacity-40">
          ← Voltar
        </button>
        <button onClick={() => handleRejeitar(todo.id)} disabled={loading === todo.id}
          className="px-2 py-1.5 font-mono text-[10px] uppercase tracking-wider text-ink/50 hover:text-sal transition-colors disabled:opacity-40">
          Rejeitar
        </button>
      </div>

      {/* Detalhes técnicos — collapsed por default */}
      <button
        onClick={() => setShowDetails(!showDetails)}
        className="mt-3 font-mono text-[9px] uppercase tracking-wider text-ink/40 hover:text-ink transition-colors"
      >
        {showDetails ? '▾ ocultar detalhes' : '▸ detalhes técnicos'}
      </button>

      {showDetails && (
        <div className="mt-2 pt-2 border-t border-ink/10 font-mono text-[10px] text-ink-soft space-y-0.5">
          {proposta?.rationale && (
            <div><span className="text-ink/40">motivo:</span> {proposta.rationale}</div>
          )}
          {proposta?.args?.chave_cte && (
            <div><span className="text-ink/40">chave_cte:</span> {proposta.args.chave_cte}</div>
          )}
          {card.responsavel_relacionamento && (
            <div><span className="text-ink/40">operador:</span> {card.responsavel_relacionamento}</div>
          )}
          {card.bastao_synced_at && (
            <div><span className="text-ink/40">sync:</span> {new Date(card.bastao_synced_at).toLocaleString('pt-BR')}</div>
          )}
        </div>
      )}
    </div>
  );
}
```

---

## 4. Mudanças visuais — resumo

| Antes | Depois |
|---|---|
| Bordas `border-2 border-ink` (pesadas) | `border border-ink/15` (sutil) |
| `shadow-flat` em todos os cards | sem sombra (border só) |
| Fundo papel + box vermelho da proposta | papel limpo, sem box |
| Header com badges grandes | 1 linha mono discreta |
| Proposta em caixa decorativa | 1 linha em serif Fraunces |
| Rationale + payload sempre visíveis | collapsed atrás de "▸ detalhes técnicos" |
| Botões `px-6 py-3` (grandes) | Botões `px-3 py-1.5` (compactos) |
| Tag em uppercase 12px | Tag em uppercase 10px |

**Resultado**: card 50% mais curto na vertical, escaneável em 1 segundo,
sem perder informação (detalhes existem, só ficam atrás de 1 clique).

---

## 5. Checklist

- [ ] **Remover** condicional por `cod_ultima_ocorrencia=20` do código antigo (se foi implementado pelo prompt anterior). 3 botões agora em TODOS os cards.
- [ ] Implementar `handleAprovar`, `handleVoltar`, `handleRejeitar` (códigos acima)
- [ ] Refatorar componente do card pra versão leve (estrutura acima)
- [ ] Detalhes técnicos collapsed por default — `useState(false)` inicial
- [ ] Header em 1 linha: NF · cliente · oc
- [ ] Proposta em 1 linha (font-display, sem caixa decorativa)
- [ ] 3 botões compactos (px-3 py-1.5)
- [ ] Testar com a NF 757022 (proposta pendente atual)
- [ ] Testar fluxo completo: Aprovar / Voltar / Rejeitar — todos retornam Promise + invalidam Kanban
- [ ] Validar que detalhes técnicos abrem/fecham corretamente

---

## Resultado esperado

Aba **AGUARDANDO VALIDAÇÃO HUMANA** com cards finos, 1 linha de
contexto, 1 linha de proposta, 3 botões compactos. Larissa bate o olho e
em 1 segundo decide: aprova, volta pro to-do, ou rejeita.

Sem sufoco visual quando a fila tiver 10+ propostas. Sem informação
escondida — tudo a 1 clique de distância.

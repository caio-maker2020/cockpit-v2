# Lovable — Banner unificado de sugestão IA dos agentes (oc=13 + ocs padrão)

**Data:** 2026-05-22
**Escopo:** 100% frontend. Padroniza o banner de sugestão dos agentes IA (`agente-oc13-autonomo` + `agente-sugere-ocs-padrao`) **no MESMO formato visual** do banner de sugestão IA de cliente respondeu (`lovable-banner-ia-sugestao.md` — visual indigo, ao lado, com botão direto e template pré-preenchido).

**Backend:** já está pronto. Os agentes salvam em `cards.aviso_alteracao_oc`:

```ts
{
  tipo: 'ia_sugestao_oc13' | 'ia_sugestao_ocs_padrao' | 'ia_sugestao_oc13_revisar' | 'ia_sugestao_oc13_21_cancel' | 'ia_oc13_autonoma' | 'ia_oc13_falhou' | 'ia_ocs_padrao_falhou',
  sugestao: string,                    // ex: "oc=54+email", "oc=56", "oc=21+cancel"
  template: string | null,             // ex: "RECUSA_TOTAL", "FALTA_DE_VOLUME", "PROBLEMAS_COM_ENDERECO", "RECUSA_PARCIAL"
  motivo_extraido: string | null,      // texto limpo do motorista (sem SSWMOBILE/GPS)
  motivo_cancelamento: string | null,  // pra sugerir_21_cancel
  foto_classificacao: string | null,
  confianca: number,                   // 0..1
  observacao: string | null,
  atualizado_em: string,
}
```

---

## Princípio visual (cópia do banner sugestão de cliente respondeu)

```
┌─ ✦ Recomendado pelo Agente IA ──────────────────────┐
│                                                       │
│ Lançar oc=54 + email — Recusa total                  │
│ Confiança: alta (85%) ✓                              │
│                                                       │
│ "CLIENTE RECUSOU A NOTA DEVIDO ESTAREM EM PROCESSO   │
│  DE INVENTARIO E NAO FAZEM RESSALVA"                 │
│                                                       │
│ [✓ Aprovar oc=54+email]   [Ver outras opções →]      │
└───────────────────────────────────────────────────────┘
```

- **Cor base:** indigo/cyan suave (mesma família do banner cliente respondeu — diferenciado da pílula vermelha que era usada antes)
- **Posição:** topo do detalhe do card, ACIMA da lista de todos pendentes (mesma posição do banner cliente respondeu)
- **Layout:** card retangular ocupando largura plena (não "à direita") — operadora lê de cima pra baixo
- **Comportamento idêntico:** botão primário não auto-aprova, faz scroll suave + destaca o todo correspondente

---

## Mapeamento por tipo de sugestão IA

Renderizar SE `card.aviso_alteracao_oc?.tipo` é um dos abaixo:

### 1. `ia_sugestao_oc13` ou `ia_sugestao_ocs_padrao` → sugere oc=54+email
Caso ideal — motivo acionável + foto OK.

```tsx
<BannerSugestaoIA
  titulo={`Lançar oc=54 + email — ${labelTemplate(aviso.template)}`}
  subtitulo="Recomendado pelo Agente IA"
  motivoCitado={aviso.motivo_extraido}
  confianca={aviso.confianca}
  acaoPrimaria={{
    label: `✓ Aprovar oc=54+email`,
    onClick: () => destacarTodoOc(54),
  }}
  acaoSecundaria={{ label: "Ver outras opções →", onClick: () => scrollTodos() }}
/>
```

### 2. `ia_sugestao_oc13_revisar` (sugere oc=56) — operação revisa

```tsx
<BannerSugestaoIA
  variant="warning"          // tom amarelo/âmbar
  titulo="Lançar oc=56 — Falta info operacional"
  subtitulo="Recomendado pelo Agente IA · Operação revisa antes de cliente"
  motivoCitado={aviso.motivo_extraido}
  confianca={aviso.confianca}
  observacao={aviso.observacao}  // "Texto vago ou foto sem contexto"
  acaoPrimaria={{ label: "✓ Aprovar oc=56", onClick: () => destacarTodoOc(56) }}
  acaoSecundaria={{ label: "Ver outras opções →", onClick: () => scrollTodos() }}
/>
```

### 3. `ia_sugestao_oc13_21_cancel` (sugere oc=21+cancel) — operador valida

```tsx
<BannerSugestaoIA
  variant="warning"
  titulo="Lançar oc=21 + cancelar reentrega"
  subtitulo="Recomendado pelo Agente IA · valide antes de executar"
  motivoCitado={aviso.motivo_extraido}
  confianca={aviso.confianca}
  observacao={`Motivo do cancelamento: ${aviso.motivo_cancelamento}`}
  acaoPrimaria={{ label: "✓ Aprovar oc=21 + cancelar", onClick: () => destacarTodoOc(21) }}
  acaoSecundaria={{ label: "Ver outras opções →", onClick: () => scrollTodos() }}
/>
```

### 4. `ia_oc13_autonoma` (já executado, read-only)

```tsx
<BannerSugestaoIA
  variant="success"     // tom verde — ação completa
  titulo="Ação autônoma executada"
  subtitulo={`oc=21 lançada · cancelamento agendado em +24h`}
  motivoCitado={aviso.motivo_cancelamento}
  confianca={aviso.confianca}
  observacao={aviso.observacao}
  semAcaoPrimaria   // só info
/>
```

### 5. `ia_oc13_falhou` ou `ia_ocs_padrao_falhou`

```tsx
<BannerSugestaoIA
  variant="danger"
  titulo="Agente IA falhou"
  subtitulo={`Categoria: ${labelCategoria(aviso.categoria)} · Tentativa ${aviso.tentativa}/3`}
  detalhe={aviso.erro_msg}
/>
```

---

## Componente `BannerSugestaoIA.tsx`

Crie em `src/components/cards/BannerSugestaoIA.tsx` (ou onde já mora `BannerSugestaoIaCliente.tsx`). API:

```ts
interface BannerSugestaoIAProps {
  titulo: string;
  subtitulo?: string;
  motivoCitado?: string | null;
  observacao?: string | null;
  detalhe?: string;
  confianca?: number;        // 0..1
  variant?: 'info' | 'warning' | 'success' | 'danger';  // default 'info' (indigo)
  acaoPrimaria?: { label: string; onClick: () => void };
  acaoSecundaria?: { label: string; onClick: () => void };
  semAcaoPrimaria?: boolean;
}
```

Estrutura visual (Tailwind):

```tsx
<div className={cn(
  "rounded-lg border p-5 mb-4",
  variant === 'info'    && "bg-indigo-50 border-indigo-200",
  variant === 'warning' && "bg-amber-50 border-amber-200",
  variant === 'success' && "bg-emerald-50 border-emerald-200",
  variant === 'danger'  && "bg-rose-50 border-rose-200",
)}>
  <div className="flex items-start gap-3">
    <div className="text-2xl">✦</div>
    <div className="flex-1">
      <p className="text-xs uppercase tracking-wider text-ink-mute font-mono">
        {subtitulo ?? "Recomendado pelo Agente IA"}
      </p>
      <h3 className="font-display text-h6 text-ink mt-1">{titulo}</h3>

      {confianca != null && (
        <BadgeConfianca confianca={confianca} className="mt-2" />
      )}

      {motivoCitado && (
        <blockquote className="mt-3 text-body italic text-ink-soft border-l-2 border-current pl-3">
          "{motivoCitado}"
        </blockquote>
      )}

      {observacao && (
        <p className="mt-2 text-caption text-ink-mute">{observacao}</p>
      )}

      {detalhe && (
        <details className="mt-2 text-caption text-ink-mute">
          <summary>Detalhe técnico</summary>
          <code className="block mt-1 text-xs">{detalhe}</code>
        </details>
      )}

      <div className="flex gap-3 mt-4 items-center">
        {acaoPrimaria && (
          <button
            onClick={acaoPrimaria.onClick}
            className="bg-ink text-bg px-4 py-2 rounded-md text-body font-medium hover:bg-signal transition-colors"
          >
            {acaoPrimaria.label}
          </button>
        )}
        {acaoSecundaria && (
          <button
            onClick={acaoSecundaria.onClick}
            className="text-ink-soft hover:text-ink text-caption underline underline-offset-4"
          >
            {acaoSecundaria.label}
          </button>
        )}
        {/* Feedback loop — IA acertou OU IA errou */}
        {acaoPrimaria && (
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => registrarAcertoIA(card)}
              className="inline-flex items-center gap-1 text-caption text-positive hover:bg-positive-soft px-2 py-1 rounded transition-colors"
              title="A sugestão da IA está correta"
            >
              ✓ IA acertou
            </button>
            <span className="text-ink-mute">·</span>
            <button
              onClick={() => abrirModalFeedback()}
              className="inline-flex items-center gap-1 text-caption text-ink-mute hover:text-signal hover:bg-signal-soft px-2 py-1 rounded transition-colors"
              title="A IA errou — registrar correção"
            >
              ⌐ IA errou
            </button>
          </div>
        )}
      </div>
    </div>
  </div>
</div>
```

## RPC "IA acertou" — registra feedback positivo

```ts
async function registrarAcertoIA(card) {
  const ehOc13 = card.cod_ultima_ocorrencia === 13;
  const rpc = ehOc13 ? 'registrar_acerto_oc13_ia' : 'registrar_acerto_ocs_padrao_ia';

  const { error } = await supabase.rpc(rpc, {
    p_card_id: card.id,
    p_observacao: null,  // opcional — pode abrir modal pequeno com textarea
  });

  if (error) {
    toast.error(`Não consegui registrar: ${error.message}`);
    return;
  }

  toast.success("✓ Feedback registrado — vai alimentar o indicador de acerto da IA");

  // Re-fetch métricas pra atualizar contadores no front
  queryClient.invalidateQueries({ queryKey: ['agente-metricas'] });
}
```

### Confirmação visual

Quando o operador clicar "✓ IA acertou":
1. Toast verde "Feedback registrado"
2. Botão muda pra estado `disabled` com check verde (já registrado)
3. Contador no banner atualiza (ex: "✓ 3 acertos confirmados neste cliente")

### Indicador de progresso rumo à autonomia (banner-info opcional)

Se o (operador + oc + cliente) tem ≥5 acertos sem nenhum erro, mostrar pílula verde no canto direito do banner:

```tsx
{acertosDoCliente >= 5 && errosDoCliente === 0 && (
  <span className="text-caption text-positive bg-positive-soft px-2 py-1 rounded">
    ✦ {acertosDoCliente}/10 acertos · próximo da autonomia
  </span>
)}
```

Query (cliente-side, lê `v_agente_ocs_padrao_rumo_autonomia`):

```ts
const { data } = await supabase
  .from('v_agente_ocs_padrao_rumo_autonomia')
  .select('acertos, erros')
  .eq('operador', card.responsavel_relacionamento)
  .eq('codigo_oc', card.cod_ultima_ocorrencia)
  .eq('pagador', card.pagador)
  .maybeSingle();
```

---

## `BadgeConfianca`

```tsx
function BadgeConfianca({ confianca }: { confianca: number }) {
  const pct = Math.round(confianca * 100);
  const config =
    pct >= 80 ? { label: `alta (${pct}%)`, classe: "bg-emerald-100 text-emerald-700", icone: "✓" } :
    pct >= 50 ? { label: `média (${pct}%)`, classe: "bg-amber-100 text-amber-700", icone: "" } :
                { label: `baixa (${pct}%) — confirme antes`, classe: "bg-rose-100 text-rose-700", icone: "⚠" };
  return (
    <span className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded text-caption font-mono", config.classe)}>
      Confiança: {config.label} {config.icone}
    </span>
  );
}
```

---

## **Comportamento "Aprovar oc=X" — template pré-preenchido**

Quando operadora clica "✓ Aprovar oc=54+email":

1. **Scroll suave** até o todo `proposta_payload.args.codigo_ssw === 54` na lista de todos pendentes
2. **Destaca** o todo com borda indigo + animação pulse 2s
3. **Auto-expande o composer de email** já com:
   - **Template selecionado:** `aviso.template` (RECUSA_TOTAL/etc) já marcado no dropdown
   - **Corpo pré-preenchido:** texto do template com `{motivo}` substituído por `aviso.motivo_extraido`
4. Larissa revisa o texto, ajusta se quiser, e clica "Enviar" — mesmo fluxo atual

Pseudo-código:

```tsx
function destacarTodoOc(codigoSsw: number) {
  const todo = todos.find(t => t.proposta_payload?.args?.codigo_ssw === codigoSsw);
  if (!todo) {
    toast.warning(`Proposta oc=${codigoSsw} não está nas opções pendentes`);
    return;
  }
  document.getElementById(`todo-${todo.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTodoHighlighted(todo.id);

  // Pré-popular composer se for oc=54+email
  if (codigoSsw === 54 && card.aviso_alteracao_oc?.template) {
    setComposerEmailAberto(true);
    setTemplateSelecionado(card.aviso_alteracao_oc.template);
    // Substitui {motivo} no corpo do template
    const corpoTemplate = templates[card.aviso_alteracao_oc.template].corpo;
    const corpoPreenchido = corpoTemplate
      .replace(/\{motivo\}/g, card.aviso_alteracao_oc.motivo_extraido ?? '')
      .replace(/\{nf\}/g, card.nf)
      .replace(/\{ctrc\}/g, card.ctrc ?? '');
    setComposerTexto(corpoPreenchido);
  }
}
```

### Templates ajustados (sugestão)

Cada template precisa ter `{motivo}` no corpo pra absorver o que a IA extraiu. Exemplos:

**RECUSA_TOTAL:**
```
Prezados,

Identificamos que a NF {nf} foi recusada totalmente pelo destinatário.
Motivo informado: "{motivo}".

Aguardamos orientação sobre o destino da mercadoria.

Att,
[Operadora]
```

**FALTA_DE_VOLUME:**
```
Prezados,

A NF {nf} foi entregue, porém com falta de volumes.
Anotação do destinatário: "{motivo}".

Solicitamos orientação para tratativa.

Att,
[Operadora]
```

**PROBLEMAS_COM_ENDERECO:**
```
Prezados,

Não foi possível efetuar a entrega da NF {nf} por problema com o endereço.
Observação da equipe: "{motivo}".

Pode confirmar o endereço/contato pra próxima tentativa?

Att,
[Operadora]
```

Se templates já existem em `templates_email` no Supabase, **adicionar/atualizar** o campo `corpo_template` pra incluir `{motivo}` — não criar novos.

---

## Mapping `labelTemplate`

```ts
const TEMPLATE_LABELS: Record<string, string> = {
  RECUSA_TOTAL: 'Recusa total',
  RECUSA_PARCIAL: 'Recusa parcial',
  FALTA_DE_VOLUME: 'Falta de volume',
  PROBLEMAS_COM_ENDERECO: 'Problemas com endereço',
};
function labelTemplate(t: string | null): string {
  return t ? (TEMPLATE_LABELS[t] ?? t) : '';
}
```

---

## Modal "IA errou" (feedback loop)

Mesmo modal já existente nos banners atuais — chama RPC apropriada conforme `aviso.tipo`:
- `ia_sugestao_oc13*` ou `ia_oc13_autonoma` → `registrar_feedback_oc13_ia`
- `ia_sugestao_ocs_padrao` → `registrar_feedback_ocs_padrao_ia`

---

## Substitui os banners atuais

Remove os componentes específicos (`BannerOc13`, `BannerOcsPadrao`) e usa `BannerSugestaoIA` em todos os cards onde `card.aviso_alteracao_oc?.tipo` começa com `ia_`.

Já existe `BannerSugestaoIaCliente` pra cliente respondeu — mantenha em paralelo OU una os dois sob `BannerSugestaoIA` (recomendado — diminui código duplicado).

---

## Resumo

| Antes | Depois |
|---|---|
| 3 banners diferentes (oc=13 autônomo, oc=13 sugestão, ocs padrão) | 1 componente `BannerSugestaoIA` com variants |
| Layout próprio embaixo, verde escuro | Mesmo visual indigo do banner cliente respondeu — topo do card |
| Operador precisa clicar separado no todo + abrir composer + escolher template + escrever corpo | 1 clique "Aprovar oc=54+email" → composer abre com template + corpo pré-preenchido com motivo da IA |
| Motivo IA mostrado mas não usado no email | `{motivo}` substituído automaticamente no corpo do template |
| Inconsistência visual entre sugestões IA | Padrão único — operador identifica imediatamente |

Cole no Lovable: ele vai detectar o componente compartilhado e refatorar os 4 cards (oc=13 sugestão / oc=13 21+cancel / ocs padrão / cliente respondeu) com o mesmo visual e fluxo de aprovação.

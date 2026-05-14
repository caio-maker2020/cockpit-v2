# Cockpit — Cards com ações múltiplas + remover Rejeitar

> Cole esse prompt INTEIRO no Lovable.
>
> **NÃO mexe** em login (já está pronto), TopBar, Kanban, RLS, ou qualquer
> outra tela que não seja explicitamente citada abaixo.
>
> **3 mudanças apenas:**
> 1. **Remover botão Rejeitar** de TODA a plataforma
> 2. **Card AGUARDANDO VALIDAÇÃO HUMANA** — renderizar N opções + 2 universais
> 3. **Card AGUARDANDO CLIENTE** — renderizar N opções (sem universais, sem lock)

---

## Contexto técnico

O backend agora cria N todos pendentes por card (não mais 1). Cada todo
representa uma "opção de ação" pra operadora aprovar. Exemplos
atualizados (2026-05-04):

- Card com **oc=20** (Extravio localizado) → 1 todo: `lançar 55`
- Card com **oc=10/11/35** → **4 todos**: `lançar 21` + `lançar 54+email` + `lançar 44` + `lançar 56`
- Card com **oc=49** → **5 todos**: `lançar 21` + `lançar 54+email` + `lançar 55` + `lançar 44` + `lançar 56`
- Card com **oc=54** (Aguardando cliente, antes de cliente responder) → **2 todos**: `lançar 21` + `lançar 55`
- Card com **oc=54 onde cliente JÁ respondeu** → **4 todos**: `lançar 21` + `lançar 44` + `lançar 56` + `re-lançar 54` (a 55 antiga é cancelada automaticamente)

Regras do state:

- Card oc=54 fica na coluna **AGUARDANDO CLIENTE** (sem lock) — operadora pode aprovar a qualquer momento
- Quando cliente responde, vinculador move pra **AGUARDANDO VALIDAÇÃO HUMANA** com lock=true
- Os 2 todos continuam pendentes; operadora aprova um, outros dois são auto-cancelados pelo backend

---

## 1. Remover botão "Rejeitar" — TODA a plataforma

Remover qualquer renderização de `<button>Rejeitar</button>` ou similar
em **todos os componentes**. A função RPC `rejeitar_acao` continua no
banco (não mexer no backend), mas frontend não chama mais.

**Onde procurar e deletar:**
- Card de validação humana (qualquer aba)
- Modais de aprovação
- Menus de contexto
- Qualquer outro lugar que tinha "Rejeitar"

A saída de emergência única passa a ser **"Recusar Ações Sugeridas"**.

---

## 2. Card AGUARDANDO VALIDAÇÃO HUMANA

### 2.0a. Destaque visual no card RESUMIDO (Kanban) — sem precisar abrir  ⚠️

Antes de abrir o card no detalhe, a operadora precisa ver de longe (na
lista do Kanban) que aquele card tem alerta. Quando
`card.aviso_alteracao_oc != null`, aplicar destaque no mini-card da
listagem:

- **Borda esquerda amarela espessa**: `border-l-4 border-amber-400`
- **Ícone ⚠️ no canto superior direito** (visível sem hover)
- **Tooltip** ao passar mouse: "Última ocorrência foi alterada — clique
  pra revisar"
- (Opcional) leve fundo `bg-amber-50/40` pra reforçar

```tsx
function MiniCardKanban({ card }: { card: Card }) {
  const temAlerta = card.aviso_alteracao_oc != null;
  const semChave = card.sem_chave_cte === true;
  const acaoFalhou = !!card.acao_falhou_motivo;

  // Cobrança repetida (cliente cobrou +1x): aplica a TODAS as colunas, mas
  // particularmente útil em TRATATIVA_PENDENTE.
  const { data: cobrancas } = useQuery({
    queryKey: ['cobrancas-count', card.id],
    queryFn: async () => {
      const { count } = await supabase
        .from('messages_inbox')
        .select('id', { count: 'exact', head: true })
        .eq('card_id', card.id);
      return count ?? 0;
    },
  });
  const cobrancaRepetida = (cobrancas ?? 0) > 1;

  // Prioridade visual: cobrança (vermelho) > ação falhou (amarelo forte) >
  // sem chave (laranja) > oc alterada (amarelo suave)
  const borda = cobrancaRepetida
    ? 'border-l-4 border-l-red-500 bg-red-50/40'
    : acaoFalhou
    ? 'border-l-4 border-l-yellow-500 bg-yellow-100/60'
    : semChave
    ? 'border-l-4 border-l-orange-500 bg-orange-50/40'
    : temAlerta
    ? 'border-l-4 border-l-amber-400 bg-amber-50/40'
    : '';

  return (
    <div
      className={[
        'bg-paper border border-ink/15 p-3 cursor-pointer hover:border-ink/40 transition-colors relative',
        borda,
      ].filter(Boolean).join(' ')}
    >
      {cobrancaRepetida && (
        <span
          className="absolute top-2 right-2 text-red-600 text-sm font-bold"
          title={`Cliente cobrou ${cobrancas} vezes — atenção urgente`}
        >
          🔔
        </span>
      )}
      {!cobrancaRepetida && acaoFalhou && (
        <span
          className="absolute top-2 right-2 text-yellow-700 text-sm font-bold animate-pulse"
          title={`Ação não executada — verifique. Motivo: ${card.acao_falhou_motivo?.slice(0, 120)}`}
        >
          ❗
        </span>
      )}
      {!cobrancaRepetida && !acaoFalhou && semChave && (
        <span
          className="absolute top-2 right-2 text-orange-600 text-sm"
          title="Card sem chave fiscal — propostas automáticas não foram criadas. Investigar caso a caso (NF pode ser RPS ou ausente do RPA OPC 455)."
        >
          🔑
        </span>
      )}
      {!cobrancaRepetida && !acaoFalhou && !semChave && temAlerta && (
        <span
          className="absolute top-2 right-2 text-amber-600 text-sm"
          title="Última ocorrência foi alterada — clique pra revisar"
        >
          ⚠️
        </span>
      )}
      {/* ...resto do mini-card existente (NF, cliente, oc, etc) */}
    </div>
  );
}
```

### 2.0b. Banner "Sem chave fiscal" no detalhe do card  🔑

Quando `card.sem_chave_cte === true`, mostra banner laranja no topo do
detalhe do card (qualquer aba):

```tsx
{card.sem_chave_cte && (
  <div className="mb-3 px-3 py-2 bg-orange-50 border border-orange-300 text-orange-900 text-xs">
    <div className="font-mono font-600 uppercase tracking-wider mb-1">
      🔑 Card sem chave fiscal
    </div>
    <div className="text-[11px] leading-snug">
      Não conseguimos criar propostas automáticas porque a chave do CT-e (ou RPS) dessa NF não está cadastrada no sistema. Possíveis causas: RPA OPC 455 não importou ainda, NF é RPS de entrega local sem chave padrão, ou houve erro na importação. Larissa pode tratar manualmente no SSW ou pedir pra cadastrar a chave.
    </div>
  </div>
)}
```

Aplica em **todas as colunas** do Kanban onde o card pode ter
`aviso_alteracao_oc` populado (basicamente AGUARDANDO_VALIDACAO_HUMANA,
mas se o backend popular noutra coluna no futuro o destaque já cobre).

### 2.0c. Banner "Ação não executada" no detalhe do card  ❗

**Contexto**: a Larissa aprovou um todo (ex: "lançar oc 56"), o executor
tentou no SSW e **falhou** (de-para errado, código não cadastrado, SSW
fora do ar, etc). Antes o card ia pra `BLOQUEADO_POR_ERRO` e ficava
esquecido. Agora o card volta pra **AGUARDANDO_VOCÊ** (mesma coluna de
validação humana) com `card.acao_falhou_motivo` populado e os outros
todos cancelados pela aprovação **voltam pra pendente** — Larissa pode
escolher outra opção.

Quando `card.acao_falhou_motivo != null`, mostra banner amarelo forte
no topo do detalhe (qualquer aba), ANTES de qualquer outro banner:

```tsx
{card.acao_falhou_motivo && (
  <div className="mb-3 px-3 py-2 bg-yellow-100 border-2 border-yellow-500 text-yellow-900 text-xs">
    <div className="font-mono font-700 uppercase tracking-wider mb-1 flex items-center gap-2">
      <span className="text-base">❗</span>
      Ação não foi executada — verifique
    </div>
    <div className="text-[11px] leading-snug">
      A última ação aprovada falhou no SSW. As opções de proposta foram
      restauradas — você pode escolher outra ação ou voltar pra to-do.
    </div>
    <details className="mt-1.5">
      <summary className="cursor-pointer text-yellow-800 text-[10px] uppercase tracking-wider">
        ver detalhe técnico
      </summary>
      <pre className="mt-1 text-[10px] whitespace-pre-wrap text-yellow-900/80 bg-yellow-50 p-1.5">
        {card.acao_falhou_motivo}
      </pre>
    </details>
  </div>
)}
```

O backend limpa `acao_falhou_motivo` automaticamente quando a próxima
aprovação é bem-sucedida. Não precisa frontend limpar.

### 2.0d. Banner "IA sugere oc=X" após resposta do cliente  ✦

**Contexto**: card estava em AGUARDANDO_CLIENTE (oc=54 lançada, esperando
posicionamento do cliente). Cliente respondeu o email — vinculador chama
agente IA (Sonnet 4.6) que interpreta a resposta e sugere qual a próxima
oc lançar:
- **44** se cliente autorizou devolução
- **21** se cliente quer reentrega
- **56** se inconclusivo / Operação revisar
- **54** se resposta sem decisão clara — manter aguardando

A sugestão fica em `card.ia_sugestao_oc_resposta`:

```json
{
  "oc_sugerida": 44,
  "confianca": 0.92,
  "motivo": "Cliente confirmou explicitamente: 'pode devolver, abrimos a NFD aqui'.",
  "sugerido_em": "2026-05-05T20:14:00Z"
}
```

Quando esse campo está preenchido (`!= null`), renderizar banner indigo
**ANTES** da lista de propostas (mas DEPOIS dos banners de erro/aviso —
ordem: acao_falhou_motivo → sem_chave_cte → aviso_alteracao_oc → ia_sugestao_oc_resposta):

```tsx
{card.ia_sugestao_oc_resposta && (
  <div className="mb-3 px-3 py-2 bg-indigo-50 border border-indigo-300 text-indigo-900 text-xs">
    <div className="font-mono font-700 uppercase tracking-wider mb-1 flex items-center gap-2">
      <span>✦</span>
      IA sugere oc={card.ia_sugestao_oc_resposta.oc_sugerida}
      <span className="text-indigo-700/60 ml-auto font-400">
        confiança {Math.round(card.ia_sugestao_oc_resposta.confianca * 100)}%
      </span>
    </div>
    <div className="text-[11px] leading-snug">
      {card.ia_sugestao_oc_resposta.motivo}
    </div>
    <div className="text-[9px] text-indigo-700/50 mt-1 italic">
      Você decide — todas as opções abaixo continuam disponíveis.
    </div>
  </div>
)}
```

(Opcional, melhora visibilidade) Highlight sutil na proposta sugerida pela IA
na lista de opções — borda indigo no botão correspondente:

```tsx
const sugerida = card.ia_sugestao_oc_resposta?.oc_sugerida;
// ... ao renderizar cada todo:
const ehSugerida = Number(t.proposta_payload?.args?.codigo_ssw) === sugerida;
className={ehSugerida ? "ring-2 ring-indigo-300" : ""}
```

**Importante**:
- Garantir que o `select(...)` de cards inclui `ia_sugestao_oc_resposta`.
- Backend limpa esse campo automaticamente quando operadora aprova qualquer
  proposta (mesmo padrão de `aviso_alteracao_oc`). Frontend não limpa.
- Se IA falhou (timeout/erro), campo fica `null` e o banner não aparece —
  fluxo segue normal com as 4 propostas sem destaque.

### 2.0. Banner "OC alterada durante lock"  ⚠️

**Contexto**: card lockado em VALIDAÇÃO HUMANA tem propostas baseadas
na oc que estava no SSW quando o lock foi criado. Se enquanto o card
está esperando aprovação a Operação lança outra oc por fora (ex: oc=14
saída pra entrega, oc=01 entrega realizada), o backend atualiza
`cod_ultima_ocorrencia` no card MAS as propostas continuam baseadas na
oc antiga — operadora pode aprovar ação inválida.

Nesse caso, o backend popula `card.aviso_alteracao_oc` com:

```json
{
  "oc_anterior": 20,
  "oc_atual": 14,
  "alterada_em": "2026-05-04T10:23:00Z"
}
```

Quando esse campo está preenchido (`!= null`), renderiza um **banner
amarelo** logo no topo do card, ANTES do header de NF:

```tsx
{card.aviso_alteracao_oc && (
  <div className="mb-3 px-3 py-2 bg-amber-50 border border-amber-300 text-amber-900 text-xs">
    <div className="font-mono font-600 uppercase tracking-wider mb-1">
      ⚠️ Atenção: ocorrência foi alterada
    </div>
    <div className="text-[11px] leading-snug">
      A última ocorrência mudou de <strong>oc {card.aviso_alteracao_oc.oc_anterior}</strong>
      {' '}para <strong>oc {card.aviso_alteracao_oc.oc_atual}</strong> em{' '}
      {new Date(card.aviso_alteracao_oc.alterada_em).toLocaleString('pt-BR', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
      })}.
      As propostas abaixo podem estar desatualizadas — revise antes de aprovar.
    </div>
  </div>
)}
```

O backend limpa `aviso_alteracao_oc` automaticamente quando a operadora
clica em qualquer botão (Aprovar, Recusar Ações Sugeridas, Voltar p/ Aguardando
Cliente). Não precisa o frontend limpar manualmente.

### 2.1. Visual leve (compacto)

Substitui o componente atual.

```tsx
function CardValidacaoHumana({ card, todos }: {
  card: Card;
  todos: Todo[]; // todos os todos pendentes do card
}) {
  const [showDetails, setShowDetails] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);

  const todosPendentes = todos.filter(t => t.status === 'pendente');

  // Card só mostra "Voltar p/ Aguardando Cliente" se veio de AGUARDANDO_CLIENTE
  // (ou seja, é um card oc=54 onde cliente respondeu).
  // Lógica simples: card_event mais recente tem event_type='RetornoClienteEmAguardo'
  // OU cod_ultima_ocorrencia = 54.
  const veioDeAguardandoCliente = card.cod_ultima_ocorrencia === 54;

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

      {/* Botões dinâmicos: 1 por todo pendente + universais */}
      <div className="flex flex-wrap items-center gap-1.5 mb-3">
        {todosPendentes.map(todo => {
          const codigo = todo.proposta_payload?.args?.codigo_ssw;
          const label = codigo
            ? `Aprovar e lançar ${codigo} →`
            : `Aprovar →`;
          return (
            <button
              key={todo.id}
              onClick={() => handleAprovar(todo.id, setLoading)}
              disabled={loading !== null}
              title={todo.descricao ?? `Lançar oc ${codigo} no SSW`}
              className="bg-sal text-paper font-mono text-[10px] font-600 uppercase tracking-wider px-3 py-1.5 hover:bg-ink transition-colors disabled:opacity-40"
            >
              {loading === todo.id ? '...' : label}
            </button>
          );
        })}

        {/* Universal: Recusar Ações Sugeridas (sempre presente) */}
        <button
          onClick={() => handleRecusarAcoes(card.id, todosPendentes[0]?.id, setLoading)}
          disabled={loading !== null}
          title="Cancela as propostas sugeridas e consulta o SSW agora pra decidir o destino real do card (RESOLVIDO / TRANSFERIDO / volta pra PARA FAZER conforme última ocorrência real)."
          className="bg-paper text-ink font-mono text-[10px] font-600 uppercase tracking-wider px-3 py-1.5 border border-ink/30 hover:border-ink transition-colors disabled:opacity-40"
        >
          ✕ Recusar Ações Sugeridas
        </button>

        {/* Universal: Voltar p/ Aguardando Cliente (só se veio de oc=54) */}
        {veioDeAguardandoCliente && (
          <button
            onClick={() => handleVoltarCliente(card.id, setLoading)}
            disabled={loading !== null}
            title="Resposta do cliente foi inconclusiva. Reinicia ciclo de cobrança em 4 dias."
            className="bg-paper text-ink font-mono text-[10px] font-600 uppercase tracking-wider px-3 py-1.5 border border-ink/30 hover:border-ink transition-colors disabled:opacity-40"
          >
            ← Voltar p/ Aguardando Cliente
          </button>
        )}
      </div>

      {/* Detalhes técnicos — collapsed por default */}
      <button
        onClick={() => setShowDetails(!showDetails)}
        className="font-mono text-[9px] uppercase tracking-wider text-ink/40 hover:text-ink transition-colors"
      >
        {showDetails ? '▾ ocultar detalhes' : '▸ detalhes técnicos'}
      </button>

      {showDetails && (
        <div className="mt-2 pt-2 border-t border-ink/10 font-mono text-[10px] text-ink-soft space-y-0.5">
          {todosPendentes.map(t => (
            <div key={t.id}>
              <span className="text-ink/40">opção:</span> {t.proposta_payload?.rationale ?? t.descricao}
            </div>
          ))}
          {card.bastao_synced_at && (
            <div><span className="text-ink/40">sync:</span> {new Date(card.bastao_synced_at).toLocaleString('pt-BR')}</div>
          )}
        </div>
      )}
    </div>
  );
}
```

### 2.1.0. Modal pré-aprovação pra propostas COM EMAIL (oc=10/11/35/49/54+template) ✉️

Quando proposta inclui email pro cliente (`proposta_payload.tool === 'lancar_oc_e_enviar_email'` OU `proposta_payload.args.template_id !== undefined`), abre modal antes de aprovar. Composer permite Larissa **editar texto** ou **marcar email como já enviado manual**.

```tsx
function ModalAprovarComEmail({
  todoId,
  cardId,
  codigoSsw,
  templateId,
  onClose,
  onConfirmed,
}: {
  todoId: string;
  cardId: string;
  codigoSsw: number;
  templateId?: string;
  onClose: () => void;
  onConfirmed: () => void;
}) {
  const [texto, setTexto] = useState('');
  const [assuntoSugerido, setAssuntoSugerido] = useState('');
  const [gerando, setGerando] = useState(false);
  const [enviando, setEnviando] = useState(false);

  async function handleGerarComIA() {
    setGerando(true);
    const { data, error } = await supabase.functions.invoke('redator-email-saida', {
      body: { card_id: cardId, codigo_ssw_proposto: codigoSsw, template_id: templateId },
    });
    setGerando(false);
    if (error) { toast.error(error.message); return; }
    setTexto(data?.texto ?? '');
    setAssuntoSugerido(data?.assunto ?? '');
    toast.success('Texto gerado pela IA — edite à vontade.');
  }

  async function handleConfirmarEnviar() {
    if (!texto.trim()) { toast.error('Texto vazio. Gera com IA ou escreve.'); return; }
    setEnviando(true);
    const { error } = await supabase.rpc('aprovar_e_executar', {
      p_todo_id: todoId,
      p_extras: {
        texto_email_customizado: texto.trim(),
      },
    });
    setEnviando(false);
    if (error) { toast.error(error.message); return; }
    toast.success(`Aprovado. Lançando oc ${codigoSsw} + enviando email...`);
    queryClient.invalidateQueries({ queryKey: ['cards'] });
    onConfirmed();
  }

  async function handleJaEnviadoManual() {
    if (!confirm('Marcar email como já enviado manualmente? Sistema vai lançar oc ' + codigoSsw + ' SEM disparar email.')) return;
    setEnviando(true);
    const { error } = await supabase.rpc('aprovar_e_executar', {
      p_todo_id: todoId,
      p_extras: {
        skip_email: true,
      },
    });
    setEnviando(false);
    if (error) { toast.error(error.message); return; }
    toast.success(`Aprovado. Lançando oc ${codigoSsw} (sem email).`);
    queryClient.invalidateQueries({ queryKey: ['cards'] });
    onConfirmed();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4">
      <div className="bg-paper border border-ink/20 p-5 max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div className="font-mono text-[10px] uppercase tracking-wider text-ink-soft mb-3">
          ✉️ Aprovar e lançar oc {codigoSsw} — com email pro cliente
          {templateId && <span className="ml-2 text-ink/40">template: {templateId}</span>}
        </div>
        <p className="text-sm text-ink/70 mb-4">
          Edite o texto abaixo e clique em <strong>Confirmar e enviar</strong>.
          Ou se você já mandou o email manualmente pelo Gmail, clique em
          <strong> Email já enviado manual</strong> — sistema só lança a oc.
        </p>

        {/* Botão "Gerar com IA" */}
        <div className="mb-3">
          <button
            onClick={handleGerarComIA}
            disabled={gerando || enviando}
            className="bg-paper text-ink font-mono text-[10px] font-600 uppercase tracking-wider px-3 py-1.5 border border-ink/30 hover:border-ink transition-colors disabled:opacity-40"
          >
            {gerando ? 'Gerando...' : '✦ Gerar com IA'}
          </button>
          {assuntoSugerido && (
            <span className="ml-3 text-[11px] text-ink/50">
              Assunto sugerido: <em>{assuntoSugerido}</em>
            </span>
          )}
        </div>

        {/* Composer */}
        <textarea
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          rows={14}
          placeholder="Texto do email — clique 'Gerar com IA' pra preencher automaticamente, ou escreva direto."
          className="w-full px-3 py-2 border border-ink/30 bg-paper text-ink font-mono text-[12px] focus:border-ink outline-none resize-y mb-4"
        />

        {/* Ações */}
        <div className="flex flex-wrap gap-2 justify-end">
          <button
            onClick={onClose}
            disabled={enviando}
            className="bg-paper text-ink font-mono text-[10px] font-600 uppercase tracking-wider px-3 py-1.5 border border-ink/30 hover:border-ink transition-colors disabled:opacity-40"
          >
            Cancelar
          </button>
          <button
            onClick={handleJaEnviadoManual}
            disabled={enviando}
            title="Lança a oc sem enviar email automático (você já mandou pelo Gmail)"
            className="bg-paper text-ink font-mono text-[10px] font-600 uppercase tracking-wider px-3 py-1.5 border border-ink/30 hover:border-ink transition-colors disabled:opacity-40"
          >
            ✓ Email já enviado manual
          </button>
          <button
            onClick={handleConfirmarEnviar}
            disabled={enviando || !texto.trim()}
            className="bg-sal text-paper font-mono text-[10px] font-600 uppercase tracking-wider px-4 py-1.5 hover:bg-ink transition-colors disabled:opacity-40"
          >
            {enviando ? '...' : `📧 Confirmar e enviar email →`}
          </button>
        </div>
      </div>
    </div>
  );
}
```

**Integração nos cards** (`CardValidacaoHumana`, `CardAguardandoCliente`, `CardTratativaPendente`):

```tsx
const [modalEmail, setModalEmail] = useState<{
  todoId: string;
  codigo: number;
  templateId?: string;
} | null>(null);

// Detector: proposta tem email associado?
function propostaTemEmail(todo: Todo): boolean {
  const tool = todo.proposta_payload?.tool;
  const templateId = todo.proposta_payload?.args?.template_id;
  return tool === 'lancar_oc_e_enviar_email' || !!templateId;
}

// No map dos botões:
<button
  onClick={() => {
    const codigo = todo.proposta_payload?.args?.codigo_ssw;
    if (codigo === 44 || codigo === '44') {
      setModal44(todo.id);
    } else if (propostaTemEmail(todo)) {
      setModalEmail({
        todoId: todo.id,
        codigo: Number(codigo),
        templateId: todo.proposta_payload?.args?.template_id,
      });
    } else {
      handleAprovar(todo.id, setLoading);
    }
  }}
  ...
>

{/* No final do componente: */}
{modalEmail && (
  <ModalAprovarComEmail
    todoId={modalEmail.todoId}
    cardId={card.id}
    codigoSsw={modalEmail.codigo}
    templateId={modalEmail.templateId}
    onClose={() => setModalEmail(null)}
    onConfirmed={() => setModalEmail(null)}
  />
)}
```

### 2.1.1. Modal pré-aprovação pra oc=44 (RETORNO DE CARGA)  📦

A oc=44 é "Retorno de carga — encaminhar pro setor de Devolução". Antes
de aprovar essa proposta específica, Larissa precisa preencher 3 infos
que vão pro SSW na descrição da ocorrência:

- **Quantidade de volumes** (texto/número)
- **Motivo da devolução** (texto)
- **Filial onde está o volume** (texto livre por enquanto)

**Comportamento**: quando código === 44, o botão `Aprovar e lançar 44 →`
abre um modal antes de chamar a RPC. Os 3 campos são obrigatórios.

```tsx
function ModalAprovarOc44({
  todoId,
  onClose,
  onConfirmed,
}: {
  todoId: string;
  onClose: () => void;
  onConfirmed: () => void;
}) {
  const [volumes, setVolumes] = useState('');
  const [motivo, setMotivo] = useState('');
  const [filial, setFilial] = useState('');
  const [loading, setLoading] = useState(false);

  const podeConfirmar = volumes.trim() && motivo.trim() && filial.trim();

  async function handleConfirmar() {
    if (!podeConfirmar) return;
    setLoading(true);
    const { error } = await supabase.rpc('aprovar_e_executar', {
      p_todo_id: todoId,
      p_extras: {
        quantidade_volumes: volumes.trim(),
        motivo: motivo.trim(),
        filial: filial.trim(),
      },
    });
    setLoading(false);
    if (error) { toast.error(error.message); return; }
    toast.success('Aprovado. Executando lançamento da oc 44...');
    queryClient.invalidateQueries(['cards']);
    onConfirmed();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60">
      <div className="bg-paper border border-ink/20 p-5 max-w-md w-full">
        <div className="font-mono text-[10px] uppercase tracking-wider text-ink-soft mb-3">
          📦 Aprovar e lançar oc 44 — retorno de carga
        </div>
        <p className="text-sm text-ink/70 mb-4">
          Preencha as informações abaixo. Vão junto na descrição da ocorrência
          no SSW pro setor de Devolução acessar.
        </p>

        <label className="block mb-3">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-soft">Quantidade de volumes</span>
          <input
            type="text"
            value={volumes}
            onChange={(e) => setVolumes(e.target.value)}
            placeholder="Ex: 5"
            className="w-full mt-1 px-3 py-2 border border-ink/30 bg-paper text-ink focus:border-ink outline-none"
            autoFocus
          />
        </label>

        <label className="block mb-3">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-soft">Motivo da devolução</span>
          <input
            type="text"
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            placeholder="Ex: Cliente recusou — produto avariado"
            className="w-full mt-1 px-3 py-2 border border-ink/30 bg-paper text-ink focus:border-ink outline-none"
          />
        </label>

        <label className="block mb-4">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-soft">Filial onde está o volume</span>
          <input
            type="text"
            value={filial}
            onChange={(e) => setFilial(e.target.value)}
            placeholder="Ex: SAA, Pouso Alegre, Belo Horizonte..."
            className="w-full mt-1 px-3 py-2 border border-ink/30 bg-paper text-ink focus:border-ink outline-none"
          />
        </label>

        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            disabled={loading}
            className="bg-paper text-ink font-mono text-[10px] font-600 uppercase tracking-wider px-3 py-1.5 border border-ink/30 hover:border-ink transition-colors disabled:opacity-40"
          >
            Cancelar
          </button>
          <button
            onClick={handleConfirmar}
            disabled={!podeConfirmar || loading}
            className="bg-sal text-paper font-mono text-[10px] font-600 uppercase tracking-wider px-3 py-1.5 hover:bg-ink transition-colors disabled:opacity-40"
          >
            {loading ? '...' : 'Confirmar e lançar 44 →'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

**Integração no `CardValidacaoHumana` e `CardAguardandoCliente`**: ao
clicar no botão de um todo cujo `codigo_ssw === 44`, em vez de chamar
`handleAprovar` direto, abrir o modal:

```tsx
const [modal44, setModal44] = useState<string | null>(null);

// no map dos botões dinâmicos:
<button
  onClick={() => {
    if (codigo === 44 || codigo === '44') {
      setModal44(todo.id);
    } else {
      handleAprovar(todo.id, setLoading);
    }
  }}
  ...
>

// no final do componente:
{modal44 && (
  <ModalAprovarOc44
    todoId={modal44}
    onClose={() => setModal44(null)}
    onConfirmed={() => setModal44(null)}
  />
)}
```

### 2.2. Handlers (compartilhados — usa em todos os cards)

```tsx
async function handleAprovar(todoId: string, setLoading: (s: string | null) => void) {
  setLoading(todoId);
  const { error } = await supabase.rpc('aprovar_e_executar', { p_todo_id: todoId });
  setLoading(null);
  if (error) { toast.error(error.message); return; }
  toast.success('Aprovado. Executando...');
  queryClient.invalidateQueries(['cards']);
}

async function handleRecusarAcoes(cardId: string, anyTodoId: string | undefined, setLoading: (s: string | null) => void) {
  if (!anyTodoId) { toast.error('Nenhuma proposta pra recusar'); return; }
  setLoading(anyTodoId);
  // Edge Function "voltar-para-to-do-com-rastreio" (v3 — Caio 2026-05-13):
  // 1. Consulta SSW interno (opção 101) — fonte canônica on-time, sem latência
  //    do Bastão de pendência.
  // 2. Cancela TODAS propostas pendentes do card.
  // 3. Decide destino pela última oc real do SSW:
  //    - finalizadora (1/30/32) → RESOLVIDO
  //    - oc=54 → AGUARDANDO_CLIENTE
  //    - fora de relacionamento → TRANSFERIDO (card some)
  //    - relacionamento com regra ≠ atual → AVH + lock + propostas da regra nova
  //    - sem mudança / sem regra → AGUARDANDO_AGENTE (PARA FAZER limpo)
  // 4. Seta cooldown de 10min pra mesma oc — sync respeita a recusa.
  // Fallback: se SSW interno indisponível, cai na RPC voltar_para_to_do antiga.
  const { data, error } = await supabase.functions.invoke('voltar-para-to-do-com-rastreio', {
    body: { todo_id: anyTodoId, motivo: null },
  });
  setLoading(null);
  if (error || !data?.ok) {
    toast.error(error?.message ?? data?.error ?? 'Erro ao recusar ações');
    return;
  }
  // Mensagem por decisão
  const mensagemPorDecisao: Record<string, string> = {
    resolvido: 'Recusado. Última oc no SSW é finalizadora — card encerrado como RESOLVIDO.',
    transferido: `Recusado. Última oc=${data.oc_ssw} é de outro setor — card movido pra TRANSFERIDO.`,
    aguardando_cliente: 'Recusado. Última oc é 54 — card foi pra AGUARDANDO CLIENTE.',
    aguardando_voce_nova_oc: `Recusado. Oc mudou pra ${data.oc_ssw} — propostas novas criadas pra você revisar.`,
    para_fazer_sem_regra: `Recusado. Oc mudou pra ${data.oc_ssw} — card voltou pra PARA FAZER sem propostas mapeadas.`,
    para_fazer_oc_inalterada: 'Recusado. Card voltou pra PARA FAZER (oc ainda é a mesma — sync respeita por 10min).',
  };
  if (data.fonte === 'fallback_rpc') {
    toast.success('Recusado (via fallback — SSW indisponível). Card voltou pra PARA FAZER.');
  } else {
    toast.success(mensagemPorDecisao[data.decisao] ?? 'Recusado.');
  }
  queryClient.invalidateQueries(['cards']);
}

async function handleVoltarCliente(cardId: string, setLoading: (s: string | null) => void) {
  setLoading(cardId);
  // RPC marcar_retorno_inconclusivo: card volta pra AGUARDANDO_CLIENTE,
  // cancela todos pendentes, agenda nova cobrança em D+4
  const { error } = await supabase.rpc('marcar_retorno_inconclusivo', {
    p_card_id: cardId,
    p_motivo: null,
  });
  setLoading(null);
  if (error) { toast.error(error.message); return; }
  toast.success('Voltou pra "Aguardando Cliente". Cobrança automática em 4 dias.');
  queryClient.invalidateQueries(['cards']);
}
```

---

## 2.3. Card TRATATIVA_PENDENTE (cliente cobrou sobre NF fora de relacionamento)

**Quando aparece**: a NF do cliente já saiu pra outro setor (Operação,
Devolução, Indenização) — card está como TRANSFERIDO. Mas cliente cobrou
de novo (email/whatsapp) OU a NF voltou pra Bastão com responsabilidade
de relacionamento. Sistema move pra TRATATIVA_PENDENTE pra Larissa
decidir se acompanha ou descarta.

Visual igual `CardValidacaoHumana` (header NF · cliente · oc) MAIS:
- Mostra **última oc atual** com label clara
- Mostra **setor que está com a carga** (do dicionário)
- 2 botões: **"⚡ Acompanhar"** (mantém em TRATATIVA_PENDENTE — não faz nada) e **"✕ Não importante"** (cancela)

```tsx
function CardTratativaPendente({ card, todos }: { card: Card; todos: Todo[] }) {
  const [loading, setLoading] = useState<string | null>(null);

  // Conta quantas mensagens INBOUND (do cliente) chegaram nesse card.
  // count > 1 = cliente cobrou de novo → notificação visual chamativa.
  const { data: cobrancas } = useQuery({
    queryKey: ['cobrancas-count', card.id],
    queryFn: async () => {
      const { count } = await supabase
        .from('messages_inbox')
        .select('id', { count: 'exact', head: true })
        .eq('card_id', card.id);
      return count ?? 0;
    },
  });
  const cobrancaRepetida = (cobrancas ?? 0) > 1;

  const todosPendentes = todos.filter(t => t.status === 'pendente');

  async function handleAprovar(todoId: string) {
    setLoading(todoId);
    const { error } = await supabase.rpc('aprovar_e_executar', { p_todo_id: todoId });
    setLoading(null);
    if (error) { toast.error(error.message); return; }
    toast.success('Aprovado. Executando...');
    queryClient.invalidateQueries({ queryKey: ['cards'] });
  }

  async function handleNaoImportante() {
    if (!confirm('Marcar como "não importante"? O card será cancelado e some da plataforma.')) return;
    setLoading('nao-importante');
    const { error } = await supabase.rpc('marcar_card_nao_importante', {
      p_card_id: card.id,
      p_motivo: null,
    });
    setLoading(null);
    if (error) { toast.error(error.message); return; }
    toast.success('Card marcado como não importante.');
    queryClient.invalidateQueries({ queryKey: ['cards'] });
  }

  function handleAcompanhar() {
    toast.success('Mantendo card em acompanhamento.');
  }

  return (
    <div className={[
      'bg-paper border p-4 hover:border-ink/40 transition-colors',
      cobrancaRepetida ? 'border-l-4 border-l-red-500 bg-red-50/40' : 'border-ink/15',
    ].join(' ')}>

      {/* Badge cobrança repetida — chamativo */}
      {cobrancaRepetida && (
        <div className="mb-3 px-3 py-2 bg-red-50 border border-red-300 text-red-900 text-xs">
          <span className="font-mono font-600 uppercase tracking-wider">
            🔔 Cliente cobrou {cobrancas} vezes sobre essa NF — atenção!
          </span>
        </div>
      )}

      {/* Header */}
      <div className="flex items-baseline gap-2 font-mono text-[10px] uppercase tracking-wider text-ink-soft mb-3">
        <span className="text-ink font-600">NF {card.nf}</span>
        <span className="text-ink/30">·</span>
        <span className="truncate">{card.empresa_cliente ?? '—'}</span>
        <span className="text-ink/30">·</span>
        <span>oc {card.cod_ultima_ocorrencia ?? '—'}</span>
      </div>

      {/* Box destaque: última oc */}
      <div className="mb-3 px-3 py-2 bg-ink/5 border border-ink/15 text-xs">
        <div className="font-mono text-[10px] uppercase tracking-wider text-ink/60 mb-1">
          última ocorrência
        </div>
        <div className="text-ink">
          oc <strong>{card.cod_ultima_ocorrencia ?? '—'}</strong>
          {' '}— {todosPendentes.length > 0
            ? 'Cliente respondeu — escolha a próxima ação ou aguarde decisão dele.'
            : 'Cliente cobrou sobre essa NF que está fora do escopo do Relacionamento.'}
        </div>
      </div>

      {/* Botões dinâmicos (1 por todo pendente) + universais */}
      <div className="flex flex-wrap items-center gap-1.5">
        {todosPendentes.map(todo => {
          const codigo = todo.proposta_payload?.args?.codigo_ssw;
          return (
            <button
              key={todo.id}
              onClick={() => handleAprovar(todo.id)}
              disabled={loading !== null}
              title={todo.descricao ?? `Lançar oc ${codigo} no SSW`}
              className="bg-sal text-paper font-mono text-[10px] font-600 uppercase tracking-wider px-3 py-1.5 hover:bg-ink transition-colors disabled:opacity-40"
            >
              {loading === todo.id ? '...' : `Aprovar e lançar ${codigo} →`}
            </button>
          );
        })}

        {/* Universais sempre presentes */}
        <button
          onClick={handleAcompanhar}
          disabled={loading !== null}
          title="Mantém o card em acompanhamento. Decida depois."
          className="bg-paper text-ink font-mono text-[10px] font-600 uppercase tracking-wider px-3 py-1.5 border border-ink/30 hover:border-ink transition-colors disabled:opacity-40"
        >
          ⚡ Acompanhar
        </button>
        <button
          onClick={handleNaoImportante}
          disabled={loading !== null}
          title="Cancela o card. Some da plataforma."
          className="bg-paper text-ink font-mono text-[10px] font-600 uppercase tracking-wider px-3 py-1.5 border border-ink/30 hover:border-ink transition-colors disabled:opacity-40"
        >
          {loading === 'nao-importante' ? '...' : '✕ Não importante'}
        </button>
      </div>
    </div>
  );
}
```

**Notas importantes**:

- **`todos`** vem da query do Kanban (igual `CardValidacaoHumana`). Se card tem todos pendentes (cliente respondeu sobre extravio oc=6/9/16), mostra botões dinâmicos (Lançar 55, Lançar 44). Se não tem (TRATATIVA_PENDENTE simples), mostra só os universais.
- **Badge cobrança repetida**: borda esquerda vermelha + box destacado quando `count(messages_inbox WHERE card_id=X) > 1`. Replica visual também no MINI-CARD do Kanban (mesma lógica do destaque amarelo de `aviso_alteracao_oc` na seção 2.0a).

Roteamento na coluna do Kanban "TRATATIVA PENDENTE" (state =
`TRATATIVA_PENDENTE`): renderiza `<CardTratativaPendente />` em vez do
componente genérico.

---

## 3. Card AGUARDANDO CLIENTE

### 3.1. Mesma estética do card de validação humana, sem botões universais

Cards oc=54 já têm 2 todos pendentes (`lançar 21` + `lançar 55`). Operadora
pode aprovar a qualquer momento — mesmo antes do cliente responder.

```tsx
function CardAguardandoCliente({ card, todos }: {
  card: Card;
  todos: Todo[];
}) {
  const [showDetails, setShowDetails] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);

  const todosPendentes = todos.filter(t => t.status === 'pendente');

  return (
    <div className="bg-paper border border-ink/15 p-4 hover:border-ink/40 transition-colors">

      {/* Header igual */}
      <div className="flex items-baseline gap-2 font-mono text-[10px] uppercase tracking-wider text-ink-soft mb-3">
        <span className="text-ink font-600">NF {card.nf}</span>
        <span className="text-ink/30">·</span>
        <span className="truncate">{card.empresa_cliente ?? '—'}</span>
        <span className="text-ink/30">·</span>
        <span>oc {card.cod_ultima_ocorrencia ?? '—'}</span>
      </div>

      {/* Indicador discreto: aguardando cliente há quantos dias + cobrança */}
      <CobrancaAgendadaInfo cardId={card.id} />

      {/* Botões dinâmicos: 1 por todo pendente. SEM universais. */}
      <div className="flex flex-wrap items-center gap-1.5 mt-3">
        {todosPendentes.map(todo => {
          const codigo = todo.proposta_payload?.args?.codigo_ssw;
          return (
            <button
              key={todo.id}
              onClick={() => handleAprovar(todo.id, setLoading)}
              disabled={loading !== null}
              title={todo.descricao}
              className="bg-sal text-paper font-mono text-[10px] font-600 uppercase tracking-wider px-3 py-1.5 hover:bg-ink transition-colors disabled:opacity-40"
            >
              {loading === todo.id ? '...' : `Aprovar e lançar ${codigo} →`}
            </button>
          );
        })}
      </div>

      <button
        onClick={() => setShowDetails(!showDetails)}
        className="mt-3 font-mono text-[9px] uppercase tracking-wider text-ink/40 hover:text-ink transition-colors"
      >
        {showDetails ? '▾ ocultar detalhes' : '▸ detalhes técnicos'}
      </button>

      {showDetails && (
        <div className="mt-2 pt-2 border-t border-ink/10 font-mono text-[10px] text-ink-soft space-y-0.5">
          {todosPendentes.map(t => (
            <div key={t.id}>
              <span className="text-ink/40">opção:</span> {t.proposta_payload?.rationale ?? t.descricao}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

### 3.2. Componente `CobrancaAgendadaInfo` (mostra "cobrança em N dias")

```tsx
function CobrancaAgendadaInfo({ cardId }: { cardId: string }) {
  const { data: acao } = useQuery({
    queryKey: ['acao-agendada', cardId],
    queryFn: async () => {
      const { data } = await supabase
        .from('acoes_agendadas')
        .select('executar_em, payload')
        .eq('card_id', cardId)
        .eq('status', 'pendente')
        .order('executar_em', { ascending: true })
        .limit(1)
        .maybeSingle();
      return data;
    },
  });

  if (!acao?.executar_em) return null;

  const diff = new Date(acao.executar_em).getTime() - Date.now();
  const dias = Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));

  return (
    <div className="font-mono text-[10px] uppercase tracking-wider text-warn-deep">
      ✦ Cobrança automática em {dias} dia{dias !== 1 ? 's' : ''}
    </div>
  );
}
```

---

## 4. Query do Kanban — incluir todos pendentes por card

Onde o Kanban busca os cards por coluna, incluir os todos pendentes na query:

```tsx
const { data: cards } = useQuery({
  queryKey: ['cards', state],
  queryFn: async () => {
    const { data } = await supabase
      .from('cards')
      .select(`
        *,
        todos!inner(id, status, descricao, proposta_payload, action_id)
      `)
      .eq('state', state)
      .eq('todos.status', 'pendente');
    return data;
  },
});
```

Adapta conforme a query atual do Kanban — o importante é trazer os todos
pendentes junto com cada card pra renderizar os botões dinâmicos.

---

## 5. Checklist

- [ ] Remover **TODOS** os botões "Rejeitar" da plataforma (busca global no código)
- [ ] Destaque visual (borda amarela + ⚠️) no MINI-CARD do Kanban quando `card.aviso_alteracao_oc != null` (ver seção 2.0a)
- [ ] Banner amarelo "OC alterada durante lock" no `CardValidacaoHumana` quando `card.aviso_alteracao_oc != null` (ver seção 2.0)
- [ ] `handleRecusarAcoes` chama Edge Function `voltar-para-to-do-com-rastreio` (não a RPC direta) — ver seção 2.2
- [ ] Modal `ModalAprovarOc44` (3 inputs obrigatórios) — abrir antes de aprovar quando codigo_ssw === 44 (ver seção 2.1.1)
- [ ] Modal `ModalAprovarComEmail` — abrir antes de aprovar quando proposta tem email associado (oc=10/11/35/49/54+template). Botões: Gerar com IA, Confirmar e enviar, Email já enviado manual (ver seção 2.1.0)
- [ ] Componente `CardTratativaPendente` na coluna TRATATIVA PENDENTE — botões dinâmicos (Lançar 55/44 quando aplicável) + universais "Acompanhar" e "Não importante" (ver seção 2.3)
- [ ] Badge cobrança repetida 🔔 (vermelho) no mini-card do Kanban + dentro do `CardTratativaPendente` quando `count(messages_inbox WHERE card_id=X) > 1` (ver seções 2.0a + 2.3)
- [ ] `CardTratativaPendente` recebe `todos` (igual `CardValidacaoHumana`) — query do Kanban precisa trazer todos pendentes pra coluna TRATATIVA PENDENTE
- [ ] Criar/refatorar componente `CardValidacaoHumana` (versão leve, N botões + universais)
- [ ] Criar/refatorar componente `CardAguardandoCliente` (versão leve, N botões, sem universais)
- [ ] Implementar handlers `handleAprovar`, `handleRecusarAcoes`, `handleVoltarCliente`
- [ ] Componente `CobrancaAgendadaInfo` no card AGUARDANDO CLIENTE
- [ ] Atualizar query do Kanban pra incluir `todos` pendentes por card
- [ ] Testar com card real:
  - [ ] Card oc=54 em AGUARDANDO_CLIENTE mostra 2 botões (`lançar 21` + `lançar 55`)
  - [ ] Card oc=20 em AGUARDANDO_VALIDAÇÃO_HUMANA mostra 1 botão + Recusar Ações Sugeridas
  - [ ] Card oc=54 em AGUARDANDO_VALIDAÇÃO_HUMANA (após cliente responder) mostra 2 botões + Recusar Ações Sugeridas + Voltar p/ Aguardando Cliente
- [ ] Aprovar uma opção: outras viram canceladas e card vai pra EXECUTANDO_ACAO
- [ ] Voltar p/ to-do: card vira PARA FAZER, todos cancelados
- [ ] Voltar p/ aguardando cliente (só em oc=54 pós-resposta): card volta pra AGUARDANDO_CLIENTE com cobrança reagendada D+4

---

## Resultado esperado

Cards finos com botões claros baseados nas opções IA disponíveis pra
aquele caso específico. Sem botão Rejeitar. Operadora bate o olho e em
1 segundo decide qual ação tomar (ou volta pra to-do se nenhuma fizer
sentido).

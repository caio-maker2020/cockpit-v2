# Cockpit — Aba "Resposta" no card (Larissa responde direto pelo Cockpit)

> Cole esse prompt INTEIRO no Lovable.
>
> **NÃO mexe** em outras telas/funcionalidades. Adiciona/refaz a aba
> "RESPOSTA" do detalhe do card.

---

## Contexto

Larissa hoje responde clientes pelo Gmail dela. Pra evoluir o
acompanhamento (e treinar IA pra autonomia futura), agora ela pode
responder **direto pelo Cockpit**, mantendo a thread Gmail intacta.

Como funciona:

- A aba **"Resposta"** do card mostra um composer com texto **já
  pré-preenchido pela IA** (agente `redator` que existe).
- Larissa lê, edita se quiser, e clica **"Enviar resposta"**.
- Backend manda via Gmail API com headers `In-Reply-To` + `References`
  (Gmail mantém thread). Destinatário = só o cliente original (sem CC).
- Próxima resposta do cliente cai na mesma thread → vinculador linka
  automaticamente ao mesmo card.

A aba **"Mensagens"** (que já existe) continua mostrando timeline de
emails inbound + outbound.

---

## 1. Componente `AbaRespostaCard`

```tsx
function AbaRespostaCard({ card }: { card: Card }) {
  const queryClient = useQueryClient();
  const [textoEditavel, setTextoEditavel] = useState<string>('');
  const [enviando, setEnviando] = useState(false);
  const [gerandoSugestao, setGerandoSugestao] = useState(false);

  // 1) Busca último todo "responder_cliente" pendente (gerado pelo redator)
  const { data: sugestao, refetch: refetchSugestao } = useQuery({
    queryKey: ['sugestao-resposta', card.id],
    queryFn: async () => {
      const { data } = await supabase
        .from('todos')
        .select('id, proposta_payload, created_at')
        .eq('card_id', card.id)
        .eq('status', 'pendente')
        .filter('proposta_payload->>tool', 'eq', 'responder_cliente')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      return data;
    },
  });

  // 2) Última mensagem inbound do card (origem da thread)
  const { data: ultimaInbound } = useQuery({
    queryKey: ['ultima-msg-inbound', card.id],
    queryFn: async () => {
      const { data } = await supabase
        .from('messages_inbox')
        .select('id, remetente, conteudo, recebido_em, raw_payload')
        .eq('card_id', card.id)
        .eq('canal', 'email')
        .order('recebido_em', { ascending: false })
        .limit(1)
        .maybeSingle();
      return data;
    },
  });

  // Pré-preenche o composer com a sugestão do redator quando ela carrega
  useEffect(() => {
    const textoSugerido = sugestao?.proposta_payload?.texto_sugerido as string | undefined;
    if (textoSugerido && !textoEditavel) {
      setTextoEditavel(textoSugerido);
    }
  }, [sugestao]);

  async function handleGerarSugestao() {
    setGerandoSugestao(true);
    const { error } = await supabase.functions.invoke('redator', {
      body: { card_id: card.id, force: true },
    });
    setGerandoSugestao(false);
    if (error) { toast.error(error.message); return; }
    await refetchSugestao();
    toast.success('Sugestão atualizada pela IA.');
  }

  async function handleEnviar() {
    if (!textoEditavel.trim()) { toast.error('Texto vazio'); return; }
    if (!ultimaInbound) {
      toast.error('Sem mensagem inbound nesse card pra responder.');
      return;
    }
    setEnviando(true);
    const { data, error } = await supabase.functions.invoke('responder-email-cliente', {
      body: {
        card_id: card.id,
        texto: textoEditavel,
        mensagem_origem_id: ultimaInbound.id,
      },
    });
    setEnviando(false);
    if (error || !data?.ok) {
      toast.error(error?.message ?? data?.error ?? 'Erro ao enviar');
      return;
    }
    toast.success(`Resposta enviada pra ${data.to}`);
    setTextoEditavel('');
    queryClient.invalidateQueries({ queryKey: ['cards'] });
    queryClient.invalidateQueries({ queryKey: ['ultima-msg-inbound', card.id] });
  }

  if (!ultimaInbound) {
    return (
      <div className="p-5 text-center text-ink-soft">
        <p className="text-sm">Nenhuma mensagem do cliente nesse card pra responder.</p>
      </div>
    );
  }

  const subjectOriginal = (ultimaInbound.raw_payload as any)?.Subject ?? 'Sua mensagem';

  return (
    <div className="p-5 space-y-4">

      {/* Contexto: a quem vai a resposta */}
      <div className="bg-ink/5 border border-ink/15 px-3 py-2 text-xs">
        <div className="font-mono text-[10px] uppercase tracking-wider text-ink/60 mb-1">
          respondendo
        </div>
        <div className="text-ink">
          <strong>Para:</strong> {ultimaInbound.remetente}<br />
          <strong>Assunto:</strong> Re: {subjectOriginal}
        </div>
      </div>

      {/* Composer */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="font-mono text-[10px] uppercase tracking-wider text-ink-soft">
            sua resposta
            {sugestao && (
              <span className="ml-2 text-ink/40 text-[9px]">
                ✦ pré-preenchida pela IA — edite à vontade
              </span>
            )}
          </label>
          <button
            onClick={handleGerarSugestao}
            disabled={gerandoSugestao}
            className="font-mono text-[9px] uppercase tracking-wider text-ink/50 hover:text-ink transition-colors disabled:opacity-40"
            title="Pede pra IA gerar uma nova sugestão (sobrescreve atual)"
          >
            {gerandoSugestao ? '...' : '↻ regerar sugestão'}
          </button>
        </div>
        <textarea
          value={textoEditavel}
          onChange={(e) => setTextoEditavel(e.target.value)}
          rows={12}
          placeholder="Escreva sua resposta ou aguarde a sugestão da IA..."
          className="w-full px-3 py-2 border border-ink/30 bg-paper text-ink font-mono text-[12px] focus:border-ink outline-none resize-y"
        />
      </div>

      {/* Ações */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-[10px] text-ink/40">
          Resposta sai do seu Gmail ({/* email do operador */}) e mantém a
          thread original. Cliente recebe na mesma conversa.
        </p>
        <button
          onClick={handleEnviar}
          disabled={enviando || !textoEditavel.trim()}
          className="bg-sal text-paper font-mono text-[10px] font-600 uppercase tracking-wider px-4 py-2 hover:bg-ink transition-colors disabled:opacity-40 whitespace-nowrap"
        >
          {enviando ? 'Enviando...' : '✉ Enviar resposta →'}
        </button>
      </div>
    </div>
  );
}
```

## 2. Roteamento na aba "Resposta" do card

Onde hoje a aba "Resposta" é renderizada (vazia ou com placeholder),
trocar pelo componente `<AbaRespostaCard card={card} />`.

## 3. Integração com aba "Mensagens" existente

Não mexer na aba "Mensagens" — ela já mostra a timeline de emails
inbound. Quando Larissa enviar pelo Cockpit, o `card_event` novo
`RespostaManualEnviadaPeloCockpit` aparece na timeline (se a aba
mostra eventos do card).

Se a aba Mensagens também mostra emails OUTBOUND no futuro: precisa
ler `card_events WHERE event_type IN ('RespostaEnviada',
'RespostaManualEnviadaPeloCockpit')` e renderizar como bolha de
saída. Pra essa primeira versão, deixa só inbound — outbound aparece
no histórico de eventos.

## 4. Checklist

- [ ] Adicionar componente `AbaRespostaCard` na aba "Resposta" do detalhe do card
- [ ] Garantir que o redator está sendo chamado quando card é criado/atualizado (já existe via vinculador linha 412+ — confirmar)
- [ ] Testar fluxo end-to-end:
  - [ ] Card com mensagem inbound recebe sugestão do redator (todo `responder_cliente` pendente)
  - [ ] Aba Resposta mostra texto pré-preenchido
  - [ ] Edita + clica Enviar
  - [ ] Toast de sucesso, textarea limpa
  - [ ] Verifica no Gmail dela: email saiu, thread mantida (resposta aparece dentro da conversa original)
  - [ ] Cliente responde de novo: nova mensagem chega no mesmo card (vinculador linka pelo In-Reply-To)
- [ ] Botão "↻ regerar sugestão" funciona: chama `redator` com `force=true`, atualiza textarea

---

## Resultado esperado

Larissa abre card de uma NF, vai na aba "Resposta", vê texto sugerido
pela IA, ajusta (ou não), clica Enviar. Cliente recebe email no
Gmail dele dentro da thread original. Quando responder, volta pro
Cockpit no mesmo card automaticamente.

Fluxo continuamente fechado dentro do Cockpit. Larissa pode
continuar respondendo pelo Gmail dela em casos específicos — ambos
caminhos coexistem.

# Lovable — Banner sugestão IA: extensões pra oc=49 (Caso 1/2/3 + catch-all)

**Data:** 2026-05-29
**Backend:** já deployado (`agente-sugere-ocs-padrao` com árvore de 4 ramos pra oc=49).

## Contexto

O agente `agente-sugere-ocs-padrao` agora também decide pra **oc=49** (TRATATIVA RELACIONAMENTO), cobrindo os 3 casos predominantes + catch-all. O backend grava em `cards.aviso_alteracao_oc` campos novos que o `BannerSugestaoIA` (componente unificado já existente) precisa renderizar quando `codigo_oc_card === 49`.

**Esta mudança é SÓ frontend.** O backend já está em produção.

## Schema do `aviso_alteracao_oc` quando oc=49

```ts
{
  tipo: 'ia_sugestao_ocs_padrao',
  codigo_oc_card: 49,
  proposta_destacada: 54 | null,
  template_email_sugerido: 'EXTRAVIO_PARCIAL' | 'EXTRAVIO_TOTAL_PEDIR_ROMANEIO' | 'RECUSA_TOTAL' | 'ENTREGUE_COM_FALTA_PEDIR_ROMANEIO' | 'ENTREGA_PARCIAL_APOS_FALTA_VOLUME' | null,
  motivo_extraido: string | null,
  confianca: number,                       // 0..1
  observacao_orquestrador: string,
  // === Campos NOVOS específicos oc=49 ===
  caso_oc49: 'extravio_total' | 'extravio_parcial' | 'extravio_sem_qtd' | 'cobranca_retorno' | 'devolucao_pos_56' | 'nao_reconhecido' | null,
  qtd_volumes_extraviados: number | null,  // só extravio_parcial
  qtd_volumes_nf: number | null,           // só extravio_parcial (pra contexto)
  cobrada_no_wpp: boolean | null,          // só extravio_sem_qtd
  cobrada_em: string | null,               // ISO timestamp
  acao_lateral: 'cobrar_retorno_mesma_thread' | null,  // só cobranca_retorno
  thread_id_alvo: string | null,           // gmail_thread_id pra reuso
  texto_prefixo_sugerido: string | null,   // texto pra enviar-retificacao-evidencia
  cod_ocorrencia_para_token: number | null, // oc cluster (deduzida pelo agente)
}
```

## Renderização por `caso_oc49`

### 1. `caso_oc49 === 'extravio_total'`

```tsx
<BannerSugestaoIA
  variant="info"   // indigo padrão
  eyebrow="Recomendado pelo Agente IA · Extravio total detectado"
  titulo="Lançar oc=54 + email EXTRAVIO_TOTAL_PEDIR_ROMANEIO"
  confianca={aviso.confianca}
  motivoCitado={aviso.motivo_extraido}
  observacao={aviso.observacao_orquestrador}
  acaoPrimaria={{
    label: "✓ Aprovar oc=54 + email",
    onClick: () => destacarTodoOc(54),
  }}
  acaoSecundaria={{ label: "Ver outras opções →", onClick: scrollTodos }}
/>
```

### 2. `caso_oc49 === 'extravio_parcial'`

Banner mostra qtd em destaque (pílula). Operador vê quantos volumes faltam antes de aprovar:

```tsx
<BannerSugestaoIA
  variant={aviso.qtd_volumes_extraviados >= aviso.qtd_volumes_nf ? "warning" : "info"}
  eyebrow="Recomendado pelo Agente IA · Extravio parcial detectado"
  titulo="Lançar oc=54 + email EXTRAVIO_PARCIAL"
  confianca={aviso.confianca}
  motivoCitado={aviso.motivo_extraido}
  observacao={aviso.observacao_orquestrador}
  badge={
    <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-amber-100 text-amber-900 font-mono text-caption">
      📦 {aviso.qtd_volumes_extraviados} de {aviso.qtd_volumes_nf ?? "?"} volumes extraviados
    </span>
  }
  acaoPrimaria={{
    label: "✓ Aprovar oc=54 + email",
    onClick: () => destacarTodoOc(54),   // executor popula {n_volumes_falta} sozinho via analise_padrao_resultado
  }}
  acaoSecundaria={{ label: "Ver outras opções →", onClick: scrollTodos }}
/>
```

Quando o operador clica "Aprovar oc=54 + email" e o composer abre, **o template já vem pré-populado com `{n_volumes_falta}={qtd_volumes_extraviados}` e `{qtde_volumes}={qtd_volumes_nf}`** — o executor faz isso automaticamente.

### 3. `caso_oc49 === 'extravio_sem_qtd'`

**Atualização Caio 2026-05-29:** o agente **NÃO** dispara WPP autônomo. Ele só sinaliza que extravio foi detectado sem qtd e o operador decide o momento de cobrar.

O banner tem **2 estados**:

#### 3a. Antes do operador cobrar (`cobrada_no_wpp === false`)

```tsx
<BannerSugestaoIA
  variant="warning"
  eyebrow="⚠️ Extravio detectado sem qtd de volumes"
  titulo="Cobrar ressarcimento pra continuar"
  confianca={aviso.confianca}
  motivoCitado={aviso.motivo_extraido}
  observacao={aviso.observacao_orquestrador}
  acaoPrimaria={{
    label: "📱 COBRAR RESSARCIMENTO",
    onClick: () => cobrarRessarcimento(card.id),
  }}
  acaoSecundaria={{ label: "Ver outras opções →", onClick: scrollTodos }}
/>
```

Implementação do botão:

```ts
async function cobrarRessarcimento(cardId: string, force = false) {
  const { data, error } = await supabase.functions.invoke('cobrar-ressarcimento-wpp', {
    body: { card_id: cardId, force },
  });
  if (error || !data?.ok) {
    const msg = data?.error ?? error?.message ?? "erro desconhecido";
    if (msg.includes("Nenhum contato cadastrado")) {
      toast.error("Cadastre o contato em Configurações > Contatos de escalonamento > Time Ressarcimento");
      return;
    }
    toast.error(`Não consegui cobrar: ${msg}`);
    return;
  }
  toast.success(`✓ ${data.total_enviados} mensagem(ns) enviada(s) ao time de ressarcimento`);
  queryClient.invalidateQueries({ queryKey: ['card', cardId] });
}
```

#### 3b. Após operador cobrar (`cobrada_no_wpp === true`)

Banner muda pra estado "aguardando" e card ganha cor diferente na lista:

```tsx
<BannerSugestaoIA
  variant="success"
  eyebrow={`📱 Time de ressarcimento cobrado · ${formatHora(aviso.cobrada_em)}`}
  titulo="Aguardando retorno do ressarcimento"
  confianca={aviso.confianca}
  motivoCitado={aviso.motivo_extraido}
  observacao="Quando o ressarcimento responder com a quantidade, atualize manualmente ou re-analise pra agente sugerir o caminho."
  acaoPrimaria={{
    label: "📱 Cobrar de novo",
    onClick: () => cobrarRessarcimento(card.id, true),  // force=true
  }}
  acaoSecundaria={{
    label: "Re-analisar agora",
    onClick: () => resetarAnaliseIA(card.id),
  }}
/>
```

**Cor diferenciada do card na lista:** quando `card.aviso_alteracao_oc?.cobrada_no_wpp === true`, aplique `border-l-4 border-amber-500 bg-amber-50/30` no item da lista INBOX, com chip "📱 COBRADA NO WPP em DD/MM HH:mm" visível. Operador vê de longe que tá aguardando ressarcimento responder.

### 4. `caso_oc49 === 'cobranca_retorno'`

```tsx
<BannerSugestaoIA
  variant="info"
  eyebrow="Recomendado pelo Agente IA · Cobrança de retorno"
  titulo="Cobrar cliente na mesma thread"
  confianca={aviso.confianca}
  motivoCitado={aviso.motivo_extraido}
  observacao={aviso.observacao_orquestrador}
  acaoPrimaria={{
    label: "✓ Cobrar de novo agora",
    onClick: () => chamarEnviarRetificacao(card.id, aviso.texto_prefixo_sugerido, aviso.cod_ocorrencia_para_token),
  }}
  acaoSecundaria={{ label: "Ver outras opções →", onClick: scrollTodos }}
/>
```

Implementação do botão:

```ts
async function chamarEnviarRetificacao(cardId: string, textoPrefixo: string, codOc: number | null) {
  const { data, error } = await supabase.functions.invoke('enviar-retificacao-evidencia', {
    body: {
      card_id: cardId,
      texto_prefixo: textoPrefixo,
      cod_ocorrencia: codOc,
    },
  });
  if (error) {
    toast.error(`Não consegui enviar: ${error.message}`);
    return;
  }
  toast.success(`✓ Cobrança enviada na thread original. Link: ${data.link_evidencia}`);
  queryClient.invalidateQueries({ queryKey: ['card', cardId] });
}
```

### 5. `caso_oc49 === 'devolucao_pos_56'`

Banner padrão de sugestão oc=54 + email — o template já vem populado pelo backend:

```tsx
<BannerSugestaoIA
  variant="info"
  eyebrow="Recomendado pelo Agente IA · Devolução pós oc=56"
  titulo={`Lançar oc=54 + email ${aviso.template_email_sugerido}`}
  confianca={aviso.confianca}
  motivoCitado={aviso.motivo_extraido}
  observacao={aviso.observacao_orquestrador}
  acaoPrimaria={{
    label: "✓ Aprovar oc=54 + email",
    onClick: () => destacarTodoOc(54),
  }}
  acaoSecundaria={{ label: "Ver outras opções →", onClick: scrollTodos }}
/>
```

### 6. `caso_oc49 === 'nao_reconhecido'` (catch-all)

```tsx
<BannerSugestaoIA
  variant="warning"
  eyebrow="Agente IA não reconheceu o caso"
  titulo="Operador escolhe manual"
  confianca={null}    // não mostra
  motivoCitado={aviso.motivo_extraido}
  observacao={aviso.observacao_orquestrador}
  acaoPrimaria={null}
  customFooter={
    <FormFeedbackCasoDesconhecido cardId={card.id} />
  }
/>
```

Componente do form de feedback:

```tsx
function FormFeedbackCasoDesconhecido({ cardId }: { cardId: string }) {
  const [texto, setTexto] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [enviado, setEnviado] = useState(false);

  async function submit() {
    if (texto.trim().length < 10) {
      toast.warning("Conte pra IA com pelo menos 10 caracteres o que era esse caso");
      return;
    }
    setEnviando(true);
    const { error } = await supabase.rpc('registrar_feedback_oc49_caso_desconhecido', {
      p_card_id: cardId,
      p_explicacao: texto.trim(),
    });
    setEnviando(false);
    if (error) {
      toast.error(`Não consegui registrar: ${error.message}`);
      return;
    }
    setEnviado(true);
    toast.success("✓ Feedback registrado — o agente vai aprender pra próximas oc=49");
  }

  if (enviado) {
    return <p className="text-positive text-caption">✓ Obrigado! Caio vai analisar o padrão.</p>;
  }

  return (
    <div className="mt-3 space-y-2">
      <label className="text-caption font-mono text-ink-mute">
        💡 Conte pro agente: qual era o caso real dessa oc=49?
      </label>
      <textarea
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        placeholder="Ex: cliente está pedindo nova tentativa de entrega na semana que vem"
        rows={2}
        className="w-full px-3 py-2 text-body border border-ink-mute/30 rounded focus:border-ink"
        minLength={10}
      />
      <button
        onClick={submit}
        disabled={enviando || texto.trim().length < 10}
        className="bg-ink text-bg px-3 py-1 rounded text-caption font-mono hover:bg-signal disabled:opacity-50"
      >
        {enviando ? "Enviando..." : "Ensinar o agente"}
      </button>
    </div>
  );
}
```

## Detalhes UX adicionais

### Chip "COBRADA NO WPP" na lista INBOX

Quando `card.aviso_alteracao_oc?.cobrada_no_wpp === true`, mostre na linha do card no INBOX:

```tsx
<span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-100 text-amber-900 text-caption font-mono">
  📱 COBRADA NO WPP
</span>
```

E aplique borda esquerda âmbar (`border-l-4 border-amber-500`) pra destacar visualmente. Operador vê de longe que tá esperando ressarcimento responder.

### Pílula de extravio parcial

Quando `qtd_volumes_extraviados >= qtd_volumes_nf`, o regex que extraiu a qtd pode estar errado (instrução SSW ambígua). Mostre warning visível:

```tsx
{aviso.qtd_volumes_extraviados >= aviso.qtd_volumes_nf && (
  <div className="bg-amber-50 border-l-4 border-amber-400 p-2 text-caption mt-2">
    ⚠️ Qtd extraviada ({aviso.qtd_volumes_extraviados}) é maior ou igual ao total da NF ({aviso.qtd_volumes_nf}).
    Confira a oc=6 anterior no histórico SSW antes de enviar.
  </div>
)}
```

## Validação

1. **Caso 1 total** — oc=49 com usuário em `usuarios_ssw_perdas` + oc=6 com instrução "TOTAL" → banner azul "Lançar oc=54 + email EXTRAVIO_TOTAL_PEDIR_ROMANEIO".
2. **Caso 1 parcial** — oc=49 + oc=6 instrução "FALTA 2 VOLUMES" → banner azul com pílula `📦 2 de N volumes extraviados`. Aprovar → composer abre com email já com "extravio de 2 de N volumes".
3. **Caso 1c sem qtd** — oc=49 + oc=6 instrução "EXTRAVIO NA TRANSFERENCIA" (sem número) → banner amarelo "Aguardando retorno do ressarcimento". Card na lista mostra chip "📱 COBRADA NO WPP".
4. **Caso 2 cobrança** — oc=49 instrução "FALTA DE RETORNO" + thread oc=54 anterior → banner com botão "Cobrar de novo agora" que chama `enviar-retificacao-evidencia` na thread original.
5. **Caso 3 devolução pós-56** — oc=49 após oc=56 do Cockpit + nova evidência → banner sugere `RECUSA_TOTAL` / `ENTREGUE_COM_FALTA_PEDIR_ROMANEIO` / `ENTREGA_PARCIAL_APOS_FALTA_VOLUME` conforme cluster original.
6. **Catch-all** — oc=49 sem nenhum sinal → banner amarelo "Operador escolhe manual" + textarea pra ensinar o agente. Submit chama RPC, gera row em `agente_ocs_padrao_feedback`.

Cola no Lovable.

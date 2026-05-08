# Lovable — Botão "Lançar oc emergencial" + anexo SSW (ACAO_EXECUTADA + PARA FAZER sem propostas)

> **Atualização Caio 2026-05-08:** modal ganha upload opcional de imagem/PDF.
> SSW WebAPI suporta o campo `imagem` no body — Larissa pode anexar
> comprovante/foto pra setor de Perdas/Devolução ver direto no SSW. Migration
> 073 adiciona parâmetro `p_anexo_id` na RPC. Apenas JPEG e PDF são aceitos
> (regra do SSW). Reutiliza bucket `email_anexos` + edge function
> `upload-anexo-email` (já existem).


## Contexto

Em **2 situações** Larissa pode precisar lançar uma oc fora das propostas pré-configuradas:

1. **Card em `state='ACAO_EXECUTADA'`** (congelado aguardando Bastão confirmar) — caso excepcional precisa de outra oc imediata.

2. **Card em `state='AGUARDANDO_AGENTE'` SEM propostas pendentes** — oc atual não tem regra mapeada em `REGRAS_AUTO_ACAO[oc]` ainda. Larissa abre o card em "PARA FAZER" e fica sem o que clicar enquanto a regra não é configurada.

Pra ambos, o sistema oferece um botão único que abre lista de todas as ocorrências lançáveis.

**Sem email.** Só lançamento da oc. Email continua pelo fluxo normal.

## Quando renderizar o botão

```ts
const mostraBotaoEmergencial = (
  card.state === 'ACAO_EXECUTADA'
) || (
  card.state === 'AGUARDANDO_AGENTE' &&
  todosPendentes.length === 0
);
```

Onde `todosPendentes` = todos com `status IN ('pendente', 'aprovado')` desse card.

| State | Tem propostas? | Botão emergencial? |
|---|---|---|
| ACAO_EXECUTADA | irrelevante | ✓ Sim |
| AGUARDANDO_AGENTE | **não** (oc sem regra) | ✓ Sim |
| AGUARDANDO_AGENTE | sim | ✗ Não (usa propostas existentes) |
| AGUARDANDO_VALIDACAO_HUMANA | sim | ✗ Não |
| AGUARDANDO_CLIENTE | — | ✗ Não |
| TRANSFERIDO/RESOLVIDO/CANCELADO | terminal | ✗ Não |

## Layout

### Cards em ACAO_EXECUTADA

```
┌────────────────────────────────────────────────────────┐
│ ✓ AÇÃO EXECUTADA — aguardando Bastão                   │
│ Você lançou oc 54 há 12 min                            │
│                                                         │
│ ⚠ Caso excepcional? Lance outra oc:                    │
│ [+ Lançar outra oc emergencial]                        │
└────────────────────────────────────────────────────────┘
```

### Cards em PARA FAZER sem propostas

```
┌────────────────────────────────────────────────────────┐
│ NF 750030 — F E F DISTRIBUIDORA                        │
│ Última oc: 12 — CHEGADA NA UNIDADE DE TRANSBORDO       │
│                                                         │
│ ⚠ Esta ocorrência ainda não tem propostas configuradas.│
│   Lance manualmente enquanto a regra é cadastrada:    │
│ [+ Lançar oc manualmente]                              │
└────────────────────────────────────────────────────────┘
```

## Modal ao clicar

Mesmo modal nos 2 casos:

```
┌────────────────────────────────────────────────────────┐
│ Lançar oc — NF 750030                                  │
│                                                         │
│ ⚠ Use com atenção — lançamento direto no SSW           │
│                                                         │
│ Ocorrência:                                             │
│ ┌──────────────────────────────────────────────────┐   │
│ │ 33 — DEVOLUCAO TOTAL/PARCIAL CONFIRMADA   ▾    │   │
│ └──────────────────────────────────────────────────┘   │
│                                                         │
│ Texto adicional (obrigatório pra oc=41):               │
│ ┌──────────────────────────────────────────────────┐   │
│ │                                                   │   │
│ └──────────────────────────────────────────────────┘   │
│                                                         │
│ Imagem/PDF (opcional, JPEG ou PDF, máx 10MB):           │
│ ┌──────────────────────────────────────────────────┐   │
│ │ [📎 Anexar arquivo]                              │   │
│ │ comprovante.jpg (240KB) [✕]                      │   │
│ └──────────────────────────────────────────────────┘   │
│                                                         │
│              [CANCELAR]    [LANÇAR OC →]               │
└────────────────────────────────────────────────────────┘
```

**Combinações cobertas (todas válidas):**
- só oc
- oc + texto
- oc + imagem
- oc + texto + imagem

## Lista de ocs no select

```ts
const { data } = await supabase
  .from('ocorrencias_dexpara')
  .select('codigo_ssw, descricao')
  .eq('ativo', true)
  .order('codigo_ssw');
```

13 ocs hoje: 21, 23, 29, 33, 41, 44, 51, 52, 54, 55, 56, 57, 58.

## Componente React

```tsx
import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabaseClient';

interface OcOption { codigo_ssw: number; descricao: string; }

interface BotaoEmergencialProps {
  card: {
    id: string;
    nf: string;
    state: string;
  };
  todosPendentes: Array<{ status: string }>;  // todos do card
  onLancado: () => void;
}

export function BotaoEmergencial({ card, todosPendentes, onLancado }: BotaoEmergencialProps) {
  const [modalAberto, setModalAberto] = useState(false);

  const semPropostas = todosPendentes.filter(t =>
    t.status === 'pendente' || t.status === 'aprovado'
  ).length === 0;

  const mostra = card.state === 'ACAO_EXECUTADA' ||
    (card.state === 'AGUARDANDO_AGENTE' && semPropostas);

  if (!mostra) return null;

  const labelBotao = card.state === 'ACAO_EXECUTADA'
    ? '⚠ Caso excepcional? + Lançar outra oc emergencial'
    : '⚠ Sem propostas configuradas. + Lançar oc manualmente';

  const labelAviso = card.state === 'ACAO_EXECUTADA'
    ? 'Card está em AÇÃO EXECUTADA aguardando Bastão confirmar a oc anterior. Use só em exceção.'
    : 'Esta ocorrência ainda não tem propostas configuradas no sistema. Lance manualmente enquanto a regra é cadastrada.';

  return (
    <>
      <button
        onClick={() => setModalAberto(true)}
        className="text-sm text-amber-700 underline mt-2"
      >
        {labelBotao}
      </button>
      <ModalLancarEmergencial
        cardId={card.id}
        nf={card.nf}
        avisoTexto={labelAviso}
        isOpen={modalAberto}
        onClose={() => setModalAberto(false)}
        onLancado={() => {
          setModalAberto(false);
          onLancado();
        }}
      />
    </>
  );
}

function ModalLancarEmergencial({
  cardId, nf, avisoTexto, isOpen, onClose, onLancado
}: {
  cardId: string;
  nf: string;
  avisoTexto: string;
  isOpen: boolean;
  onClose: () => void;
  onLancado: () => void;
}) {
  const [ocs, setOcs] = useState<OcOption[]>([]);
  const [codigoSelecionado, setCodigoSelecionado] = useState<number | null>(null);
  const [textoDescricao, setTextoDescricao] = useState('');
  const [anexoId, setAnexoId] = useState<string | null>(null);
  const [anexoFilename, setAnexoFilename] = useState<string | null>(null);
  const [anexoSize, setAnexoSize] = useState<number | null>(null);
  const [uploadando, setUploadando] = useState(false);
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    supabase
      .from('ocorrencias_dexpara')
      .select('codigo_ssw, descricao')
      .eq('ativo', true)
      .order('codigo_ssw')
      .then(({ data }) => setOcs((data ?? []) as OcOption[]));
    // Reset estado quando reabre
    setCodigoSelecionado(null);
    setTextoDescricao('');
    setAnexoId(null);
    setAnexoFilename(null);
    setAnexoSize(null);
    setErro(null);
  }, [isOpen]);

  const ocExigeTexto = codigoSelecionado === 41;

  async function selecionarArquivo(file: File) {
    setErro(null);
    // SSW só aceita JPEG e PDF (regra da WebAPI ssw.inf.br)
    const mimesAceitos = ['image/jpeg', 'image/jpg', 'image/pjpeg', 'application/pdf'];
    if (!mimesAceitos.includes(file.type)) {
      setErro('Apenas JPEG ou PDF são aceitos pelo SSW.');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setErro('Arquivo maior que 10MB.');
      return;
    }
    setUploadando(true);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('card_id', cardId);
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/upload-anexo-email`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${session?.access_token}` },
          body: form,
        },
      );
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Upload falhou: ${txt.slice(0, 200)}`);
      }
      const data = await res.json();
      setAnexoId(data.anexo_id);
      setAnexoFilename(file.name);
      setAnexoSize(file.size);
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
    } finally {
      setUploadando(false);
    }
  }

  function removerAnexo() {
    setAnexoId(null);
    setAnexoFilename(null);
    setAnexoSize(null);
  }

  async function lancar() {
    if (!codigoSelecionado) return;
    if (ocExigeTexto && !textoDescricao.trim()) {
      setErro('Texto adicional é obrigatório para oc=41 (informação complementar)');
      return;
    }
    setLoading(true);
    setErro(null);
    const { error } = await supabase.rpc('lancar_oc_emergencial_acao_executada', {
      p_card_id: cardId,
      p_codigo_ssw: codigoSelecionado,
      p_texto_descricao: textoDescricao.trim() || null,
      p_anexo_id: anexoId,
    });
    setLoading(false);
    if (error) {
      setErro(error.message);
      return;
    }
    onLancado();
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 max-w-lg w-full">
        <h2 className="text-lg font-semibold mb-2">Lançar oc — NF {nf}</h2>
        <div className="bg-amber-50 border border-amber-300 rounded p-3 mb-4 text-sm text-amber-900">
          ⚠ {avisoTexto}
        </div>

        <label className="block text-sm font-medium mb-1">Ocorrência:</label>
        <select
          className="w-full border rounded p-2 mb-4"
          value={codigoSelecionado ?? ''}
          onChange={(e) => setCodigoSelecionado(Number(e.target.value) || null)}
        >
          <option value="">— escolher —</option>
          {ocs.map((o) => (
            <option key={o.codigo_ssw} value={o.codigo_ssw}>
              {o.codigo_ssw} — {o.descricao}
            </option>
          ))}
        </select>

        <label className="block text-sm font-medium mb-1">
          Texto adicional {ocExigeTexto ? '(obrigatório)' : '(opcional)'}:
        </label>
        <textarea
          className="w-full border rounded p-2 mb-4 h-24"
          value={textoDescricao}
          onChange={(e) => setTextoDescricao(e.target.value)}
          placeholder={ocExigeTexto
            ? 'Descreva a informação complementar...'
            : 'Texto adicional (opcional)'}
        />

        <label className="block text-sm font-medium mb-1">
          Imagem/PDF para o SSW (opcional, JPEG ou PDF, máx 10MB):
        </label>
        <div className="border rounded p-3 mb-4 bg-slate-50">
          {!anexoId ? (
            <label className="inline-flex items-center gap-2 cursor-pointer text-sm text-blue-700 hover:underline">
              <span>📎 {uploadando ? 'Enviando...' : 'Anexar arquivo'}</span>
              <input
                type="file"
                accept="image/jpeg,image/jpg,application/pdf"
                className="hidden"
                disabled={uploadando}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) selecionarArquivo(f);
                  e.target.value = '';
                }}
              />
            </label>
          ) : (
            <div className="flex items-center gap-2 text-sm">
              <span>📎 {anexoFilename}</span>
              {anexoSize != null && (
                <span className="text-slate-500">({Math.round(anexoSize / 1024)} KB)</span>
              )}
              <button
                onClick={removerAnexo}
                className="text-red-600 hover:text-red-800 ml-2"
                type="button"
              >
                ✕ remover
              </button>
            </div>
          )}
          <p className="text-xs text-slate-500 mt-1">
            O arquivo é enviado direto ao SSW como evidência da ocorrência.
            Após sucesso, é removido do Cockpit (privacidade).
          </p>
        </div>

        {erro && (
          <div className="bg-red-50 border border-red-300 rounded p-2 mb-4 text-sm text-red-900">
            {erro}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded border" disabled={loading || uploadando}>
            Cancelar
          </button>
          <button
            onClick={lancar}
            disabled={!codigoSelecionado || loading || uploadando}
            className="px-4 py-2 rounded bg-blue-600 text-white disabled:opacity-50"
          >
            {loading ? 'Lançando...' : 'Lançar oc →'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

## Comportamento garantido (backend)

- ✅ RPC `lancar_oc_emergencial_acao_executada` aceita state `ACAO_EXECUTADA` OU `AGUARDANDO_AGENTE` (com 0 propostas pendentes).
- ✅ Em `AGUARDANDO_AGENTE` com propostas ativas, RPC rejeita (Larissa deve usar as propostas).
- ✅ Aceita só ocs ativas em `ocorrencias_dexpara`.
- ✅ Sem email — só lançamento.
- ✅ Após sucesso: state = `ACAO_EXECUTADA` + `acao_executada_em=now()`.
- ✅ Audit: `card_event` `AprovacaoEmergencialOperador` com `state_origem` (ACAO_EXECUTADA ou AGUARDANDO_AGENTE) + `tem_anexo`.
- ✅ **Anexo opcional (Caio 2026-05-08):** RPC aceita `p_anexo_id uuid` (vem do upload-anexo-email). Validação: arquivo precisa existir no bucket + mime ∈ {JPEG, PDF}. Executor lê do storage, converte base64 e envia como `imagem` na chamada SSW. Após sucesso SSW, deleta o arquivo do bucket (mesma regra dos email_anexos).

## Resumo em 1 frase

Botão emergencial aparece quando `card.state IN ('ACAO_EXECUTADA','AGUARDANDO_AGENTE')` E (state=ACAO_EXECUTADA OU lista de propostas vazia); abre modal com 13 ocs lançáveis; chama RPC; card vai pra ACAO_EXECUTADA pós-sucesso.

# Lovable — Banner amarelo + Badge verde "IA — Validação de Evidência"

## Contexto

Sistema do Cockpit roda verificação automática no SSW pra ver se há foto anexada na ocorrência atual (10/11/35). Resultado fica gravado em `cards.evidencia_status` + `cards.evidencia_diagnostico`.

**Comportamento desejado (Caio 2026-05-08):**

- Quando IA acha foto correlacionada à oc → **badge verde discreto** no card ("IA validou OK")
- Quando IA acha problema (sem foto, foto em outra oc, scrape falhou) → **banner amarelo** com diagnóstico

Ambos coexistem no mesmo card. Larissa sempre sabe que a IA rodou.

**IMPORTANTE:** o sistema NUNCA lança oc=56 sozinho. Apenas SUGERE. Larissa decide.

## Onde

No topo do card detalhado (mesmo lugar onde aparecem outros banners tipo "📬 CLIENTE RESPONDEU" e "AÇÃO FALHOU"). Badge verde fica logo abaixo do header (linha discreta), banner amarelo fica como alerta destacado.

## Regra de renderização

```ts
const status = card.evidencia_status;
const verificada = card.evidencia_verificada_em;

// Badge verde: IA achou foto OK na oc
const mostraBadgeVerde = status === 'ok_com_foto_correlacionada';

// Banner amarelo: IA achou problema E Larissa não marcou como verificado
const mostraBannerAmarelo =
  status != null
  && status !== 'ok_com_foto_correlacionada'
  && verificada == null;
```

## Visual

### Badge verde (caso OK)

Linha discreta, NÃO destacada como banner. Cor: `bg-emerald-50 border-emerald-200 text-emerald-700`. Ícone `CheckCircle` da lucide-react.

```
┌──────────────────────────────────────────────────────────┐
│ NF 70677 — LEONE — oc 10                                 │
│ ✓ IA validou: foto OK na linha da oc 10                  │
│                                                           │
│ [...resto do card...]                                    │
└──────────────────────────────────────────────────────────┘
```

### Banner amarelo (caso problema — preservado da versão anterior)

```
┌──────────────────────────────────────────────────────────────┐
│ ⚠ IA — VALIDAÇÃO DE EVIDÊNCIA                                │
│                                                               │
│ {evidencia_diagnostico}                                       │
│                                                               │
│ [🔗 Abrir SSW]   [✓ Marcar como verificado e ocultar]        │
└──────────────────────────────────────────────────────────────┘
```

Cor: `bg-amber-50 border-amber-300 text-amber-900`. Ícone `AlertTriangle`.

## Componente React

```tsx
import { AlertTriangle, CheckCircle, ExternalLink, Check } from 'lucide-react';
import { useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

interface CardEvidencia {
  id: string;
  nf: string | null;
  cod_ultima_ocorrencia: number | null;
  evidencia_status: string | null;
  evidencia_diagnostico: string | null;
  evidencia_verificada_em: string | null;
}

export function BlocoEvidenciaIA({ card, onUpdate }: { card: CardEvidencia; onUpdate?: () => void }) {
  return (
    <>
      <BadgeIaOk card={card} />
      <BannerEvidenciaProblema card={card} onUpdate={onUpdate} />
    </>
  );
}

function BadgeIaOk({ card }: { card: CardEvidencia }) {
  if (card.evidencia_status !== 'ok_com_foto_correlacionada') return null;

  return (
    <div className="flex items-center gap-1.5 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1 w-fit my-2">
      <CheckCircle className="w-3.5 h-3.5" />
      <span>IA validou: foto OK na linha da oc {card.cod_ultima_ocorrencia}</span>
    </div>
  );
}

function BannerEvidenciaProblema({ card, onUpdate }: { card: CardEvidencia; onUpdate?: () => void }) {
  const [loading, setLoading] = useState(false);

  const visivel =
    card.evidencia_status != null &&
    card.evidencia_status !== 'ok_com_foto_correlacionada' &&
    card.evidencia_verificada_em == null;

  if (!visivel) return null;

  async function marcarVerificado() {
    setLoading(true);
    const { error } = await supabase
      .from('cards')
      .update({ evidencia_verificada_em: new Date().toISOString() })
      .eq('id', card.id);
    setLoading(false);
    if (error) {
      console.error('Erro ao marcar verificado:', error);
      return;
    }
    onUpdate?.();
  }

  return (
    <div className="border border-amber-300 bg-amber-50 rounded-md p-4 mb-4 flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5 shrink-0" />
        <div className="flex-1">
          <h3 className="font-semibold text-amber-900 text-sm">IA — Validação de Evidência</h3>
          <p className="text-amber-900 text-sm mt-1 leading-snug">
            {card.evidencia_diagnostico}
          </p>
        </div>
      </div>
      <div className="flex gap-2 ml-7">
        <a
          href="https://ssw.inf.br/2/"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded border border-amber-300 bg-white text-amber-900 hover:bg-amber-100"
        >
          <ExternalLink className="w-3 h-3" />
          Abrir SSW
        </a>
        <button
          onClick={marcarVerificado}
          disabled={loading}
          className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50"
        >
          <Check className="w-3 h-3" />
          {loading ? 'Salvando...' : 'Marcar como verificado e ocultar'}
        </button>
      </div>
    </div>
  );
}
```

## Onde inserir no card detalhado

```tsx
// dentro do CardDetail render
<>
  <BlocoEvidenciaIA card={card} onUpdate={refetchCard} />
  {/* outros banners (cliente respondeu, ação falhou...) */}
  {/* lista de propostas / todos pendentes */}
</>
```

## Casos cobertos

| `evidencia_status` | UI mostrada |
|---|---|
| `null` (não rodou — cards antigos) | Nada |
| `ok_com_foto_correlacionada` | **Badge verde** "✓ IA validou: foto OK na linha da oc {X}" |
| `ok_sem_btn_foto` | Banner amarelo: "Não encontrei foto..." |
| `ambiguo_foto_em_outra_oc` | Banner amarelo: "Encontrei foto na linha 'X'..." |
| `scrape_indisponivel` | Banner amarelo: "Não consegui verificar: {motivo}..." |

## Comportamento garantido (backend, não mudou)

- ✅ `cards.evidencia_status` populado pelo `verificarEvidenciaESinalizar` em sync-bastao + vinculador.
- ✅ Badge verde aparece automaticamente quando IA validou OK — sem ação adicional.
- ✅ Botão "Marcar verificado" do banner amarelo seta `evidencia_verificada_em = now()` — banner some.
- ✅ Sistema NÃO dispara oc=56 sozinho.

## Resumo em 1 frase

Badge verde discreto quando `evidencia_status='ok_com_foto_correlacionada'`; banner amarelo quando `evidencia_status` é problema E `evidencia_verificada_em` é null; coexistem no mesmo card.

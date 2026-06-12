# Lovable — Banner "Sugestão IA" com transcrição da ressalva destacada

**Data:** 2026-05-27
**Backend:** já deployado (`agente-sugere-ocs-padrao`).

## Contexto / problema

Hoje o banner "Recomendado pelo agente IA" mostra o `motivo_extraido` em uma citação simples (texto italic discreto). Operador acaba abrindo a foto da evidência só pra confirmar o conteúdo da ressalva — fricção desnecessária quando a IA já transcreveu o manuscrito literalmente.

**Objetivo:** apresentar a transcrição da ressalva como **bloco destacado**, "como se o agente IA entrasse e transcrevesse a ressalva pro operador". Operador só abre a foto quando realmente precisar comparar.

## Dados disponíveis no card (já populados pelo backend)

```ts
card.aviso_alteracao_oc = {
  tipo: "ia_sugestao_ocs_padrao",
  codigo_oc_card: 19,
  proposta_destacada: 54,
  template_email_sugerido: "ENTREGUE_COM_FALTA_PEDIR_ROMANEIO",
  motivo_extraido: "Faltou um volume Item TNT/KBCO-01 Assento Versato 6 Unidades",
  tem_ressalva: true,                // ← NOVO (agora propagado)
  ressalva_texto: "Faltou um volume Item TNT/KBCO-01 Assento Versato 6 Unidades", // ← NOVO
  confianca: "alta",
  observacao_orquestrador: "oc=19 com motivo escrito identificado (ressalva na foto). Evidência boa — sugere notificar cliente.",
  evidencia_foto_url: "https://.../foto-oc-card?card_id=...&codigo_oc=19",
  alerta_caixa_lacrada: null,        // oc=35 only
  // ...
}
```

`ressalva_texto` é a **transcrição literal** que a IA Vision (Claude Sonnet 4.6) leu na foto. `motivo_extraido` em geral é igual ao `ressalva_texto` pra oc=10/19/35 (depois do fix do dia 2026-05-27, motivo vem APENAS da ressalva). Pra oc=11 pode vir de instrução do motorista (não é ressalva manuscrita — não destacar como tal).

## Componente a alterar

[src/components/cards/BannerSugestaoIA.tsx](src/components/cards/BannerSugestaoIA.tsx)

(ou o nome equivalente — o componente que renderiza "🤖 RECOMENDADO PELO AGENTE IA" + proposta + motivo extraído)

### Mudança visual

Hoje:

```
🤖 RECOMENDADO PELO AGENTE IA
Lançar oc=54 + email — ENTREGUE_COM_FALTA_PEDIR_ROMANEIO
Confiança: alta (85%)

  "Faltou um volume Item TNT/KBCO-01 Assento Versato 6 Unidades"

Observação: oc=19 com motivo escrito identificado...
```

Novo:

```
🤖 RECOMENDADO PELO AGENTE IA
Lançar oc=54 + email — ENTREGUE_COM_FALTA_PEDIR_ROMANEIO
Confiança: alta (85%)

┌─ 📝 Transcrição da ressalva (lida da foto pela IA Vision) ────┐
│                                                                │
│   "Faltou um volume Item TNT/KBCO-01 Assento Versato 6        │
│    Unidades"                                                   │
│                                                                │
│   [🖼 Ver foto original]                                       │
└────────────────────────────────────────────────────────────────┘

Observação do orquestrador: oc=19 com motivo escrito identificado...
```

### Implementação (TSX)

```tsx
// Dentro do BannerSugestaoIA (logo após a linha de confiança, antes da observação do orquestrador)

const aviso = card.aviso_alteracao_oc;
const ressalvaTexto = aviso?.ressalva_texto?.trim();
const temRessalva = aviso?.tem_ressalva === true && !!ressalvaTexto;
const motivoExtraido = aviso?.motivo_extraido?.trim();
const codigoOc = aviso?.codigo_oc_card;
const fotoUrl = aviso?.evidencia_foto_url;

// Bloco "Transcrição da ressalva" — só pra ocs que dependem de ressalva (10/19/35)
const ocsComRessalva = [10, 19, 35];
const mostrarBlocoRessalva = ocsComRessalva.includes(codigoOc);

{mostrarBlocoRessalva && (
  <div className="mt-3 border-l-4 border-amber-400 bg-amber-50/60 rounded-r-md p-3">
    <div className="flex items-center gap-2 mb-2">
      <span className="text-base">📝</span>
      <span className="text-caption font-display font-semibold text-amber-900 uppercase tracking-wide">
        {temRessalva
          ? "Transcrição da ressalva (lida da foto pela IA Vision)"
          : "Ressalva manuscrita"}
      </span>
    </div>

    {temRessalva ? (
      <blockquote className="font-mono text-body text-ink leading-relaxed pl-3 border-l-2 border-amber-300">
        "{ressalvaTexto}"
      </blockquote>
    ) : motivoExtraido ? (
      <p className="text-body text-ink-mute italic pl-3">
        Sem ressalva manuscrita identificada. Motivo lido da instrução do motorista:
        <br/>"{motivoExtraido}"
      </p>
    ) : (
      <p className="text-body text-rose-700 pl-3">
        ⚠️ A IA não encontrou ressalva manuscrita legível na foto. Recomenda revisar manualmente.
      </p>
    )}

    {fotoUrl && (
      <div className="mt-2 flex gap-2">
        <button
          onClick={() => setModalEvidenciaAberto(true)}
          className="text-caption font-mono text-amber-900 hover:text-amber-700 underline decoration-dotted"
        >
          🖼 Ver foto original
        </button>
      </div>
    )}
  </div>
)}
```

### Removível / ajustar

O bloco antigo que mostrava `motivo_extraido` em italic simples (geralmente `<blockquote className="italic text-ink-mute">...</blockquote>` ou similar) **fica obsoleto** quando `mostrarBlocoRessalva===true`. Pra ocs fora do conjunto (10/19/35) — manter o comportamento antigo (motivo italic discreto).

### Modal de foto (reuso do componente existente)

Quando o operador clica em "🖼 Ver foto original", abrir o `<ModalEvidencia />` já existente (criado no prompt `lovable-banner-evidencia-galeria-multifoto.md`) — passando `cardId={card.id}` e `codigoOc={codigoOc}`. Se a oc tem múltiplas fotos, modal já renderiza navegação automaticamente.

## Edge case: confiança baixa ou ressalva genérica

Quando o agente IA não conseguiu transcrever (foto ilegível, sem foto, ressalva genérica como "ok"/"."), o backend grava:
- `tem_ressalva: false`
- `ressalva_texto: null`

E geralmente sugere oc=56 em vez de oc=54+email. Nessa hipótese o bloco amarelo mostra o aviso "⚠️ A IA não encontrou ressalva manuscrita legível" — sinal claro pro operador de que precisa abrir a foto e decidir manualmente.

## Tokens / cores Hejlsberg

- Fundo: `bg-amber-50/60` (suave, não compete com badge IA roxo)
- Borda esquerda: `border-amber-400` (destaque)
- Citação: `font-mono` (transmite "transcrito literalmente, não parafraseado")
- Header: `font-display font-semibold uppercase tracking-wide` (chip-style)

## Validação

1. **Card oc=19 NF 132109 DURAFA** com ressalva "Faltou um volume..." → banner deve mostrar bloco amarelo com a transcrição literal em fonte mono.
2. **Card oc=35** com ressalva válida → mesmo bloco.
3. **Card oc=35 sem ressalva legível** (sugestão oc=56) → bloco mostra "⚠️ A IA não encontrou ressalva manuscrita legível na foto".
4. **Card oc=11** (GPS) → NÃO mostra bloco da ressalva (motivo vem de GPS/instrução, não é ressalva); mantém citação italic discreta.
5. **Card oc=10** com ressalva → bloco mostra transcrição. Sem ressalva → aviso.
6. Clicar "🖼 Ver foto original" abre o ModalEvidencia já existente.

## Por que isso importa (contexto do Caio)

Caio: *"Preciso que aparece oq esta escrito na ressalva... como se o agente entrasse e transcrevesse a ressalva pro operador só precisar abrir a imagem qdo realmente necessaria."*

O operador toma a decisão em 5 segundos lendo a transcrição. Hoje, o operador abre a foto pra ler o manuscrito — fricção repetida em todo card. Esse bloco transforma o banner num "resumo de evidência" autossuficiente.

Cola no Lovable.

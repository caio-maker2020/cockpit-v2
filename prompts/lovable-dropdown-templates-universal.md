# Lovable — Dropdown universal de templates de email em QUALQUER oc

**Data:** 2026-05-26
**Pedido Caio:** operador deve poder escolher QUALQUER template ativo em QUALQUER caso (não só nas ocs onde IA sugere). Backend já suporta `extras.template_id_override` — só UI.

## Estado atual

- **Backend:** `executor/index.ts` honra `extras.template_id_override` pra qualquer aprovação oc=54+email (já implementado pra oc=20 — ver memory `project_oc20_proposta_54_email_dropdown`).
- **IA Agente:** sugere `template_id` em `cards.analise_padrao_resultado.template_email_sugerido` (RECUSA_TOTAL, RECUSA_PARCIAL, FALTA_DE_VOLUME, FALTA_DE_VOLUME_TOTAL, ENTREGA_PARCIAL_APOS_FALTA_VOLUME, PROBLEMAS_COM_ENDERECO, etc).
- **UI atual:** modal só mostra dropdown em oc=20. Em outras ocs, template vem fixo da proposta — operador não consegue trocar sem editar texto livre.

## Mudança proposta

**TODA aprovação de oc=54+email deve abrir o composer com:**
1. Dropdown "Template" mostrando **TODOS** os templates ativos (não filtrar por oc atual)
2. Pré-seleção: `analise_padrao_resultado.template_email_sugerido` se IA sugeriu, senão o template da proposta (`proposta_payload.args.template_id`)
3. Quando operador troca o template no dropdown, **corpo do email re-renderiza** com o novo template
4. Operador continua podendo editar manualmente o corpo (texto livre) — `texto_email_customizado` tem prioridade no executor

## Implementação

### 1. Carregar lista de templates ativos (1× por sessão)

```tsx
// src/hooks/useTemplatesEmail.ts
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

export interface TemplateEmail {
  id: string;
  nome: string;
  descricao: string | null;
  assunto: string;
  corpo_template: string;
  variaveis_esperadas: string[];
}

export function useTemplatesEmail() {
  return useQuery({
    queryKey: ["templates-email-ativos"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("templates_email")
        .select("id, nome, descricao, assunto, corpo_template, variaveis_esperadas")
        .eq("ativo", true)
        .order("id");
      if (error) throw error;
      return data as TemplateEmail[];
    },
    staleTime: 5 * 60_000, // 5min — templates mudam pouco
  });
}
```

### 2. Componente do composer com dropdown

```tsx
// src/components/cards/ComposerEmail.tsx
import { useState, useEffect, useMemo } from "react";
import { useTemplatesEmail } from "@/hooks/useTemplatesEmail";

interface ComposerEmailProps {
  card: {
    id: string;
    nf: string;
    pagador: string;
    empresa_cliente: string;
    cod_ultima_ocorrencia: number;
    analise_padrao_resultado: {
      template_email_sugerido?: string | null;
      motivo_extraido?: string | null;
    } | null;
    responsavel_relacionamento: string;
  };
  // proposta veio do todo aprovado
  templateIdInicial: string | null;
  onAprovar: (extras: {
    template_id_override?: string;
    texto_email_customizado: string;
    assunto_override?: string;
    enviar_email: boolean;
    email_destinatarios: string[];
  }) => void;
}

export function ComposerEmail({ card, templateIdInicial, onAprovar }: ComposerEmailProps) {
  const { data: templates = [], isLoading } = useTemplatesEmail();

  // Sugestão da IA OU template da proposta OU primeiro ativo
  const templateSugerido =
    card.analise_padrao_resultado?.template_email_sugerido ??
    templateIdInicial ??
    null;

  const [templateIdSelecionado, setTemplateIdSelecionado] = useState<string | null>(
    templateSugerido,
  );
  const [corpoEditado, setCorpoEditado] = useState<string>("");
  const [corpoFoiEditadoManual, setCorpoFoiEditadoManual] = useState(false);

  const templateAtual = useMemo(
    () => templates.find((t) => t.id === templateIdSelecionado),
    [templates, templateIdSelecionado],
  );

  // Quando troca o template, re-renderiza o corpo (a não ser que operador
  // já editou manualmente — aí preserva)
  useEffect(() => {
    if (!templateAtual) return;
    if (corpoFoiEditadoManual) return;
    setCorpoEditado(renderTemplate(templateAtual.corpo_template, card));
  }, [templateAtual, card, corpoFoiEditadoManual]);

  if (isLoading) return <p>Carregando templates…</p>;

  return (
    <div className="space-y-3">
      {/* Dropdown */}
      <label className="block">
        <span className="text-caption font-mono text-ink-mute">Template do email</span>
        <select
          value={templateIdSelecionado ?? ""}
          onChange={(e) => {
            setTemplateIdSelecionado(e.target.value);
            setCorpoFoiEditadoManual(false); // troca de template re-renderiza
          }}
          className="mt-1 block w-full rounded-md border-ink-mute/30 bg-bg text-ink font-mono text-body"
        >
          {templateSugerido && (
            <option value={templateSugerido}>
              ⭐ {templateSugerido} (sugerido pela IA)
            </option>
          )}
          {templates
            .filter((t) => t.id !== templateSugerido)
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.nome} ({t.id})
              </option>
            ))}
        </select>
      </label>

      {/* Assunto (vem do template, editável) */}
      <label className="block">
        <span className="text-caption font-mono text-ink-mute">Assunto</span>
        <input
          type="text"
          value={renderTemplate(templateAtual?.assunto ?? "", card)}
          onChange={() => {/* ... */}}
          className="mt-1 block w-full"
        />
      </label>

      {/* Corpo editável */}
      <label className="block">
        <span className="text-caption font-mono text-ink-mute">
          Corpo do email{" "}
          {corpoFoiEditadoManual && (
            <span className="text-positive">· editado manualmente</span>
          )}
        </span>
        <textarea
          value={corpoEditado}
          onChange={(e) => {
            setCorpoEditado(e.target.value);
            setCorpoFoiEditadoManual(true);
          }}
          rows={12}
          className="mt-1 block w-full font-mono text-body"
        />
      </label>

      <button
        onClick={() =>
          onAprovar({
            template_id_override: templateIdSelecionado ?? undefined,
            texto_email_customizado: corpoEditado,
            enviar_email: true,
            // ... resto
          })
        }
      >
        Aprovar oc=54 + enviar email
      </button>
    </div>
  );
}

// Render placeholder do template — substitui {nf}, {primeiro_nome}, etc.
function renderTemplate(tpl: string, card: ComposerEmailProps["card"]): string {
  const primeiroNome = card.empresa_cliente.split(/\s+/)[0] ?? "";
  return tpl
    .replace(/\{nf\}/g, card.nf)
    .replace(/\{primeiro_nome\}/g, primeiroNome)
    .replace(/\{nome_cliente\}/g, card.empresa_cliente)
    .replace(/\{empresa\}/g, card.empresa_cliente)
    .replace(/\{operadora_nome\}/g, card.responsavel_relacionamento)
    .replace(/\{n_volumes_falta\}/g, "")  // operador preenche manual se aplica
    .replace(/\{link_evidencia\}/g, "{link_evidencia}"); // backend resolve no executor
}
```

### 3. Onde substituir

Procurar no Lovable o modal/dialog atual de aprovação oc=54+email. Provavelmente está em algo tipo `src/components/cards/ModalAprovarOc54.tsx` ou `ComposerEmailModal.tsx`. Substituir o bloco de seleção de template (que hoje só aparece em oc=20 ou vem fixo) por `<ComposerEmail {...} />`.

### 4. Pré-seleção quando IA sugeriu

Quando `card.analise_padrao_resultado.template_email_sugerido` está populado (todo card oc=10/11/19/35 que IA analisou tem isso), aparece com **⭐** no dropdown e fica selecionado por padrão. Operador pode trocar a qualquer momento.

### 5. Backend já suporta

`executor/index.ts` linha 1866 lê `extras.template_id_override` e usa pra escolher o template no SSW + montar o assunto. Linha 1428-1430: `textoCustomizado` (vindo de `texto_email_customizado` em extras) tem prioridade sobre `corpo_template` do template.

---

## Lista de templates ativos hoje (referência)

```
COBRANCA_LEMBRETE              — alias do _4DIAS
COBRANCA_LEMBRETE_4DIAS        — 4 dias sem resposta (uso manual)
COBRANCA_LEMBRETE_8DIAS        — 8 dias — armazenagem aplicada (uso manual)
ENDERECO_INCORRETO             — legado
ENTREGA_PARCIAL_APOS_FALTA_VOLUME — recusa parcial por falta de volume (default oc=35)
EXTRAVIO_TOTAL_NOTIFICACAO     — legado
FALTA_DE_VOLUME                — extravio parcial (Resposta 1)
FALTA_DE_VOLUME_TOTAL          — extravio total (Resposta 2, Caio 2026-05-26)
PROBLEMAS_COM_ENDERECO         — oc=11
RECUSA_PARCIAL                 — oc=35
RECUSA_TOTAL                   — oc=10
```

Operador escolhe livremente entre todos. IA destaca 1 com ⭐ baseada em oc + evidência interpretada.

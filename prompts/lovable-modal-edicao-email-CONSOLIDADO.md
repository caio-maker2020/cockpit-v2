# Lovable — Modal de edição de email (CONSOLIDADO — cola uma vez só)

**Data:** 2026-06-01
**Backend:** 100% pronto. Migrations 123/181/186 aplicadas. RPCs `preview_email_todo` e `aprovar_e_executar` aceitam tudo descrito aqui.

---

## Bug em produção (urgente)

Hoje, quando a operadora clica **"Aprovar e Executar"** num to-do cujo `proposta_payload.tool === 'lancar_oc_e_enviar_email'`, o cockpit dispara `aprovar_e_executar(todo_id)` direto e o executor manda o email **sem permitir revisão**. Caso real 2026-06-01: NF 23142 — Larissa clicou Aprovar e o email saiu pro cliente em 9 segundos, sem ela ver. **Não pode acontecer mais. Toda aprovação de oc+email PRECISA passar por modal de revisão antes do envio.**

---

## O que implementar

Quando a operadora clicar **"Aprovar e Executar"** num to-do, **detectar o tool** e decidir o caminho:

```ts
const precisaModalEmail =
  todo.proposta_payload?.tool === 'lancar_oc_e_enviar_email';

if (precisaModalEmail) {
  abrirModalEdicaoEmail(todo.id);   // ← NOVO caminho
} else {
  await aprovarDireto(todo.id);     // mantém comportamento atual pros outros tools
}
```

Para to-dos com outras tools (ex: `lancar_ocorrencia` puro sem email, `enviar_email_livre_e_lancar_oc33_portal`, etc), **manter aprovação direta sem modal**. Só intercepta `lancar_oc_e_enviar_email`.

---

## Fluxo do modal

### 1. Ao abrir — chamar RPC

```ts
const { data, error } = await supabase.rpc('preview_email_todo', {
  p_todo_id: todoId,
});
```

Retorno da RPC (após mig 186 — campos `template_sugerido_ia`, `qtd_volumes_*` substituídos):

```jsonc
{
  "todo_id": "uuid",
  "card_id": "uuid",
  "nf": "23142",
  "codigo_ssw_proposta": 54,
  "cod_ultima_ocorrencia_card": 49,
  "email_destino": "comercial@pousofarma.com.br",
  "template_atual": {
    "id": "EXTRAVIO_PARCIAL",
    "nome": "Extravio parcial — solicitar tratativa",
    "descricao": "...",
    "assunto_renderizado": "Extravio parcial — NF 23142",
    "corpo_renderizado": "Olá POUSO,\n\nIdentificamos que durante o transporte da NF 23142 houve extravio de 1 de 8 volumes...",
    "usa_link_evidencia": false
  },
  "templates_disponiveis": [
    { "id": "EXTRAVIO_PARCIAL", "nome": "...", "descricao": "..." },
    { "id": "EXTRAVIO_TOTAL_PEDIR_ROMANEIO", "nome": "...", "descricao": "..." },
    { "id": "FALTA_DE_VOLUME", "nome": "...", "descricao": "..." },
    { "id": "RECUSA_TOTAL", "nome": "...", "descricao": "..." },
    { "id": "COBRANCA_LEMBRETE", "nome": "...", "descricao": "..." }
  ],
  "template_sugerido_ia": "EXTRAVIO_PARCIAL"
}
```

O `template_sugerido_ia` (quando não-nulo) é a recomendação do agente IA — destaque no dropdown.

### 2. State controlado (todo campo é editável, NÃO usa placeholder)

```tsx
const [carregando, setCarregando] = useState(true);
const [emailDestino, setEmailDestino] = useState('');
const [templateSelecionado, setTemplateSelecionado] = useState('');
const [templateOriginalId, setTemplateOriginalId] = useState('');
const [templateSugeridoIa, setTemplateSugeridoIa] = useState<string | null>(null);
const [templatesDisponiveis, setTemplatesDisponiveis] = useState<Template[]>([]);
const [assunto, setAssunto] = useState('');
const [corpoEmail, setCorpoEmail] = useState('');
const [usaLinkEvidencia, setUsaLinkEvidencia] = useState(false);
const [validarEvidencia, setValidarEvidencia] = useState(false);

useEffect(() => {
  (async () => {
    const { data, error } = await supabase.rpc('preview_email_todo', { p_todo_id: todoId });
    if (error) {
      toast.error(`Não consegui carregar preview: ${error.message}`);
      fecharModal();
      return;
    }
    setEmailDestino(data.email_destino ?? '');
    setTemplateSelecionado(data.template_atual.id);
    setTemplateOriginalId(data.template_atual.id);
    setTemplateSugeridoIa(data.template_sugerido_ia);
    setTemplatesDisponiveis(data.templates_disponiveis);
    setAssunto(data.template_atual.assunto_renderizado);
    setCorpoEmail(data.template_atual.corpo_renderizado);
    setUsaLinkEvidencia(data.template_atual.usa_link_evidencia);
    setCarregando(false);
  })();
}, [todoId]);
```

### 3. Trocar template no dropdown

Re-chamar a RPC com `p_template_id_override`. Se a operadora já editou o corpo, perguntar antes de descartar:

```ts
const onTemplateChange = async (novoId: string) => {
  // Detecta se houve edição manual: corpo atual difere do corpo renderizado original
  const editouManual = corpoEmail !== ultimoCorpoRenderizado || assunto !== ultimoAssuntoRenderizado;
  if (editouManual) {
    const ok = confirm('Trocar de template descarta as edições atuais. Continuar?');
    if (!ok) return;
  }
  const { data } = await supabase.rpc('preview_email_todo', {
    p_todo_id: todoId,
    p_template_id_override: novoId,
  });
  setTemplateSelecionado(novoId);
  setAssunto(data.template_atual.assunto_renderizado);
  setCorpoEmail(data.template_atual.corpo_renderizado);
  setUsaLinkEvidencia(data.template_atual.usa_link_evidencia);
  setUltimoAssuntoRenderizado(data.template_atual.assunto_renderizado);
  setUltimoCorpoRenderizado(data.template_atual.corpo_renderizado);
};
```

(Use `useState` adicionais `ultimoAssuntoRenderizado` / `ultimoCorpoRenderizado` pra detectar edição manual.)

### 4. Clicar CONFIRMAR — montar extras e chamar aprovar_e_executar

```ts
async function confirmar() {
  const extras: Record<string, unknown> = {
    assunto_override: assunto,
    texto_email_customizado: corpoEmail,
    validar_evidencia: validarEvidencia,
  };

  // só envia template_id_override se a operadora trocou
  if (templateSelecionado !== templateOriginalId) {
    extras.template_id_override = templateSelecionado;
  }

  // se o front também controla email_destinatarios (multi-select), inclui aqui:
  // extras.email_destinatarios = destinatariosMarcados;

  const { data, error } = await supabase.rpc('aprovar_e_executar', {
    p_todo_id: todoId,
    p_extras: extras,
  });
  if (error) {
    toast.error(`Não consegui aprovar: ${error.message}`);
    return;
  }
  toast.success('Aprovado. Email enviando...');
  fecharModal();
  queryClient.invalidateQueries({ queryKey: ['card', cardId] });
}
```

O executor (backend) lê os 4 campos de `extras`:
- `assunto_override` (string)
- `texto_email_customizado` (string)
- `template_id_override` (string opcional)
- `validar_evidencia` (boolean)

---

## Layout do modal

```
┌─ Aprovar e enviar email — NF 23142 ─────────────────────────┐
│                                                               │
│ PARA                                                          │
│ comercial@pousofarma.com.br                                   │
│ (texto cinza — se vier null, mostrar input editável + aviso  │
│  vermelho "⚠️ Cliente sem email cadastrado")                  │
│                                                               │
│ TEMPLATE *                                                    │
│ ┌──────────────────────────────────────────────────────┐    │
│ │ ✨ Extravio parcial — solicitar tratativa (Sugerido IA) │ ← marca o template_sugerido_ia
│ │    Extravio total — pedir romaneio assinado          │    │
│ │    Falta de volume — solicitar tratativa             │    │
│ │    Recusa total — solicitar tratativa                │    │
│ │    Cobrança de lembrete                              │    │
│ └──────────────────────────────────────────────────────┘    │
│                                                               │
│ ☐ Validar evidência antes de enviar                          │
│   (mostrar SÓ se cod_ultima_ocorrencia_card NÃO em [10,11,35]│
│    — pras outras ocs valida automático)                      │
│                                                               │
│ ASSUNTO *                                                    │
│ [ Extravio parcial — NF 23142                              ]│
│                                                               │
│ CORPO DO EMAIL *                                              │
│ ┌──────────────────────────────────────────────────────┐    │
│ │ Olá POUSO,                                            │    │
│ │                                                        │    │
│ │ Identificamos que durante o transporte da NF 23142   │    │
│ │ houve extravio de 1 de 8 volumes. Localizamos o      │    │
│ │ restante.                                             │    │
│ │                                                        │    │
│ │ Para prosseguirmos, poderia nos orientar:            │    │
│ │ (a) seguir com a entrega parcial dos volumes         │    │
│ │     localizados, OU                                   │    │
│ │ (b) realizar a devolução total?                      │    │
│ │ ...                                                    │    │
│ └──────────────────────────────────────────────────────┘    │
│                                                               │
│ 🔗 (visível só se usa_link_evidencia=true)                    │
│    O placeholder {link_evidencia} será substituído por um    │
│    link único no momento do envio. Mantenha-o no texto se   │
│    quiser que o cliente veja a evidência.                    │
│                                                               │
│                          [ CANCELAR ]  [ CONFIRMAR → ]       │
└───────────────────────────────────────────────────────────────┘
```

---

## Regras importantes

### Bug a corrigir (NÃO use placeholder no textarea)

O textarea CORPO DO EMAIL **deve ser controlado por state** (`value={corpoEmail}` + `onChange`). Hoje provavelmente está usando `placeholder` com o texto pré-formatado, e quando a operadora começa a digitar o texto some. **Eliminar qualquer `placeholder={...}` com conteúdo pré-renderizado** — só `value` + `onChange`.

```tsx
// ❌ ERRADO — perde texto ao digitar
<textarea placeholder={corpoRenderizado} />

// ✅ CERTO — state controlado
<textarea value={corpoEmail} onChange={(e) => setCorpoEmail(e.target.value)} />
```

### Destaque do template sugerido pela IA

Quando `template_sugerido_ia` for não-nulo, marcar visualmente esse template no dropdown (ícone ✨ + texto "Sugerido pela IA"). Esse já vem como default selecionado (o backend usa ele como `template_atual` automaticamente, mig 186).

### Checkbox "Validar evidência"

- **Mostrar checkbox** quando `cod_ultima_ocorrencia_card` ∉ [10, 11, 35] (default OFF).
- **Esconder** quando `cod_ultima_ocorrencia_card` ∈ [10, 11, 35] — backend valida automaticamente (regra fixa: recusa/endereço-errado SEMPRE precisa foto). Mostrar pode confundir.
- Quando marcado: backend roda scraping de evidência SSW antes de enviar. Quando desmarcado: envia direto.

### Aviso {link_evidencia}

Mostrar o card amarelo "🔗 ..." **só se** `template_atual.usa_link_evidencia === true`. A operadora pode manter ou remover o placeholder no corpo — backend gera o token só na hora do envio.

### Detectar edição manual antes de trocar template

Comparar `corpoEmail` (state atual) com `ultimoCorpoRenderizado` (último valor retornado pela RPC). Se diferentes → operadora editou manual → `confirm()` antes de descartar.

---

## Edge cases

- **`email_destino` null** mesmo após fallback do backend → input editável com label vermelha "⚠️ Cliente sem email cadastrado — informe manualmente". Por enquanto, bloquear botão Confirmar até preencher.
- **RPC preview falha** → toast erro + fechar modal. NÃO fazer fallback pra aprovação direta (risco de mandar email não revisado).
- **`templates_disponiveis` vazio** → improvável, mas se acontecer, dropdown desabilitado mostrando só `template_atual`.
- **Operadora cancela modal** → não chamar `aprovar_e_executar`. Todo continua pendente, ela pode tentar de novo depois.

---

## Tipos TypeScript

```ts
interface Template {
  id: string;
  nome: string;
  descricao: string;
}

interface PreviewEmailRpcResponse {
  todo_id: string;
  card_id: string;
  nf: string;
  codigo_ssw_proposta: number;
  cod_ultima_ocorrencia_card: number;
  email_destino: string | null;
  template_atual: {
    id: string;
    nome: string;
    descricao: string;
    assunto_renderizado: string;
    corpo_renderizado: string;
    usa_link_evidencia: boolean;
  };
  templates_disponiveis: Template[];
  template_sugerido_ia: string | null;   // NOVO (mig 186)
}
```

---

## Resumo das mudanças

1. **Novo componente:** `EditarEmailModal.tsx` (ou similar) — abre quando `todo.proposta_payload?.tool === 'lancar_oc_e_enviar_email'`.
2. **Modificar `handleAprovar(todoId)`:** detectar o tool antes; se `lancar_oc_e_enviar_email`, abrir modal em vez de chamar `aprovar_e_executar` direto.
3. **Modal contém:** PARA (read-only), TEMPLATE (dropdown com destaque "✨ Sugerido pela IA"), checkbox VALIDAR EVIDÊNCIA condicional, ASSUNTO (input editável), CORPO (textarea controlado por state — `value` + `onChange`, sem placeholder).
4. **Trocar template** re-chama `preview_email_todo` com `p_template_id_override`. Confirm dialog se operadora já editou.
5. **Confirmar** chama `aprovar_e_executar` com `extras = { assunto_override, texto_email_customizado, validar_evidencia, [template_id_override se trocou] }`.
6. **Outros tools** (não `lancar_oc_e_enviar_email`) continuam aprovação direta sem modal.

Zero mudança no backend — está tudo pronto desde 2026-06-01.

## Validação pós-deploy

1. NF 23142 (POUSO F H LTDA C2, oc=49) — operadora clica "Aprovar oc=54 + email" no banner sugestão IA ou no todo. Modal abre com:
   - PARA: comercial@pousofarma.com.br
   - TEMPLATE: "✨ Extravio parcial (Sugerido IA)" pré-selecionado
   - ASSUNTO: "Extravio parcial — NF 23142"
   - CORPO: já com "1 de 8 volumes"
   - Checkbox "Validar evidência" visível (oc=49), default OFF
2. Operadora edita corpo, troca template (vê confirm), edita assunto. Tudo persiste.
3. Confirmar → email sai com o conteúdo EDITADO, não o template original.

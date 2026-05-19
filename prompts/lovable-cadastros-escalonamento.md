# Lovable — Sub-tab "Escalonamento" em CADASTROS

**Data:** 2026-05-19
**Backend:** 100% pronto. Tabela `contatos_escalonamento` (migration 123) + RLS (SELECT todos, CRUD só gestor).

## O que essa feature é

A nova aba PRIORIDADES AI (kanban de cobrança escalonada) precisa de contatos cadastrados pra cada base + cargo. Quem cobra é o operador via Cockpit; quem é cobrado é o Gerente da Base, Coordenador de Entrega ou Gerente de Relacionamento.

Esta sub-tab em CADASTROS permite ao gestor cadastrar manualmente esses contatos.

## Schema da tabela `contatos_escalonamento`

```ts
type ContatoEscalonamento = {
  id: string;                 // uuid
  base: string | null;        // código SSW (ex: 'VGA','MTZ','MCU'). NULL = global (gerente_relacionamento típico).
  cargo: 'gerente_base' | 'coordenador_entrega' | 'gerente_relacionamento';
  nome: string;
  telefone: string | null;    // formato Evolution (5535999990000) — front normaliza
  email: string | null;
  ativo: boolean;
  observacao: string | null;
  created_at: string;
  updated_at: string;
};
```

## UX

### Localização
Sub-tab nova na aba **CADASTROS** (já existe), próxima às sub-tabs existentes (operadores, contatos de base SSW, templates, etc).

### Layout

```
Escalonamento
─────────────────────────────────────────────────────────────────────────
[ + Novo contato ]                                    [ Buscar ▾ ]

Base ▾ │ Cargo                       │ Nome          │ Telefone        │ Email           │ Ativo │ Ações
VGA    │ 📤 Gerente da Base          │ Ana Costa     │ (35) 99999-0001 │ ana@.com        │  ☑    │ ✏ 🗑
VGA    │ 📞 Coordenador de Entrega   │ Bruno Silva   │ (35) 98888-0002 │ bruno@.com      │  ☑    │ ✏ 🗑
MTZ    │ 📤 Gerente da Base          │ Carla Pereira │ (35) 97777-0003 │ carla@.com      │  ☑    │ ✏ 🗑
—      │ 🚨 Gerente de Relacionamento│ Maria Souza   │ (11) 99999-0099 │ maria@.com      │  ☑    │ ✏ 🗑   ← global
```

### Form "Novo contato" / "Editar"

```tsx
<Dialog>
  <DialogTitle>Cadastrar contato de escalonamento</DialogTitle>
  
  <Field label="Base SSW" hint="Deixe vazio se for contato global (todas bases)">
    <Select
      options={[
        { value: '', label: '— Global (todas bases)' },
        ...basesSswConhecidas, // SELECT DISTINCT base_destino FROM cards
      ]}
      allowCustom // permite digitar base nova
    />
  </Field>
  
  <Field label="Cargo" required>
    <Select
      options={[
        { value: 'gerente_base',          label: '📤 Gerente da Base' },
        { value: 'coordenador_entrega',   label: '📞 Coordenador de Entrega' },
        { value: 'gerente_relacionamento',label: '🚨 Gerente de Relacionamento' },
      ]}
    />
  </Field>
  
  <Field label="Nome" required>
    <Input />
  </Field>
  
  <Field label="Telefone (WhatsApp)" hint="Será normalizado pro formato Evolution">
    <Input mask="(99) 99999-9999" placeholder="(35) 99999-0000" />
  </Field>
  
  <Field label="Email">
    <Input type="email" />
  </Field>
  
  <Field label="Observação" hint="Opcional — contexto interno">
    <Textarea />
  </Field>
  
  <Field>
    <Switch label="Ativo" defaultChecked />
  </Field>
  
  <DialogActions>
    <Button variant="outline">Cancelar</Button>
    <Button onClick={salvar}>Salvar</Button>
  </DialogActions>
</Dialog>
```

### Normalização do telefone (ao salvar)

```ts
function normalizarTelefone(input: string): string | null {
  const digits = input.replace(/\D+/g, '');
  if (!digits) return null;
  if (digits.startsWith('55') && digits.length >= 12) return digits;
  if (digits.length === 11 || digits.length === 10) return `55${digits}`;
  return digits;
}
```

Salva normalizado no banco. Exibe formatado na tabela (`(35) 99999-0001`).

### Lista de bases SSW (autocomplete)

Query:
```ts
const { data: bases } = await supabase
  .from('cards')
  .select('base_destino')
  .not('base_destino', 'is', null);
// Cliente extrai unique + ordena
const basesUnicas = [...new Set(bases.map(b => b.base_destino))].sort();
```

Cache no react-query 5min. Ou usa tabela `bases_ssw` se existir; senão `cards`.

### RLS

- **Operador autenticado (não gestor):** SELECT funciona (lista vê), mas tentar CRUD retorna 403. UI esconde botões de edição pra papel != gestor.
- **Gestor:** CRUD completo.

```ts
const podeEditar = useOperadorAtual().papel === 'gestor';
```

### Validações no front

- Cargo obrigatório
- Nome obrigatório
- Pelo menos 1 entre telefone OU email (senão não tem como cobrar via canal nenhum)
- Telefone: aceitar só formato BR
- Email: validar regex

### Botões de teste rápido (opcional, só gestor)

Próximo a cada linha, botão "📤 Testar envio" que dispara:
```ts
// 1) Telefone preenchido: envia WhatsApp teste "Teste Cockpit — ignore"
// 2) Email preenchido: envia email teste similar
```
Via edge function nova `testar-contato-escalonamento` (futuro). Pro MVP, omitir.

## Critério de aceite

1. Gestor vê sub-tab "Escalonamento" em CADASTROS
2. Consegue criar/editar/deletar contatos
3. Operador comum vê a lista (read-only)
4. Telefone normalizado pra `5535999990001` ao salvar
5. Cargo aparece com ícones (📤 / 📞 / 🚨)
6. Coluna "Base" mostra `—` quando NULL com hint "(global)"
7. RLS valida: operador não-gestor recebe 403 ao tentar INSERT/UPDATE/DELETE

## Backend (não precisa mexer)

Tabela criada na migration 123 com:
- RLS `contatos_escal_select` (SELECT todos authenticated)
- RLS `contatos_escal_modify` (CRUD só gestor via `current_operador_papel()='gestor'`)
- Trigger `set_updated_at`
- Índice em `(base, cargo) WHERE ativo`

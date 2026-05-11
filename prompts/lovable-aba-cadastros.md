# Aba CADASTROS — Lovable

Cria uma nova aba **CADASTROS** no menu principal, posicionada logo abaixo de **AUDITORIA**. Essa aba é onde Larissa (operadora) e ADM (gestor) cadastram clientes que o Cockpit vai usar pra rastrear pendências e enviar emails automáticos.

---

## Por que isso existe

Hoje os clientes são cadastrados via planilha Excel + script manual. Operadora não consegue cadastrar sozinha — depende do Caio. A aba CADASTROS substitui esse fluxo: operadora preenche direto na interface e o Cockpit já passa a usar o cliente em produção (envio de email, tracking SSW).

**Tudo é obrigatório por design.** Sem senha de tracking SSW o agente não rastreia. Sem email cadastrado o Cockpit não envia mensagem pro cliente. Sem CNPJ/CPF não conseguimos identificar quem é o pagador. A UI bloqueia o salvar enquanto falta qualquer campo essencial.

---

## Permissões (escopo)

A regra de quem vê/edita o quê:

- **Operador (papel=`operador`)**: vê e edita SOMENTE clientes onde `operador_responsavel_id = self`. Quando cadastra um novo, o operador responsável é fixado nele automaticamente — não tem como escolher outro.
- **Gestor (papel=`gestor`)**: vê e edita TODOS os clientes. Quando cadastra um novo, DEVE escolher quem é o operador responsável (campo obrigatório só pra gestor).

O papel do usuário logado vem de `operadores.papel` (já existe no banco). Use `current_operador_papel()` ou consulte direto. RLS no banco já força esse escopo — mesmo que o front mande request "errada", o banco bloqueia. Mas a UI deve refletir a regra pra não confundir.

---

## Listagem (primeira tela da aba)

Layout: tabela com paginação + busca + filtros.

**Colunas:**
- **Cliente** (nome amigável, ex: "INOVAMED")
- **Documento** (CNPJ formatado `XX.XXX.XXX/XXXX-XX` ou CPF `XXX.XXX.XXX-XX`)
- **Contatos** (badge "3 emails", "1 wpp" — agregado de `contatos_cliente.tipo`)
- **Operador responsável** (nome do operador — só aparece pra gestor; pra operador essa coluna não faz sentido porque é sempre ele)
- **Ativo** (toggle visual — verde = ativo, cinza = inativo)
- **Ações** (botões: ✏ Editar, 🚫 Desativar)

**Busca:** input no topo, busca por `nome_amigavel ILIKE %query%` OU `documento ILIKE %query%`.

**Filtros:**
- Toggle "Mostrar inativos" (default desligado — mostra só ativos)
- Pra gestor: dropdown "Operador responsável" pra filtrar (default: todos)

**Ordenação:** alfabética por `nome_amigavel` ascendente.

**Botão principal (canto superior direito):** `+ Novo Cliente` — abre o form de cadastro.

### Como buscar os dados

Use o Supabase client (já injetado) com PostgREST. A RLS garante o escopo automaticamente — você NÃO precisa filtrar por operador no front, o banco já faz.

```ts
// Clientes (tracking_credentials)
const { data: clientes } = await supabase
  .from("tracking_credentials")
  .select("documento, nome_amigavel, ativo, operador_responsavel_id, notes, updated_at")
  .order("nome_amigavel", { ascending: true });

// Contatos agregados (carrega de uma vez pros clientes da tela)
const docs = clientes.map(c => c.documento);
const { data: contatos } = await supabase
  .from("contatos_cliente")
  .select("documento_cliente, tipo, identificador, ordem, tipo_uso, nome_pessoa, ativo")
  .in("documento_cliente", docs);

// Operadores (pra gestor mostrar nome + filtro)
const { data: operadores } = await supabase
  .from("operadores")
  .select("id, nome, email, papel")
  .eq("ativo", true)
  .order("nome");
```

Agrupa os contatos por `documento_cliente` no front pra contar emails/whatsapps.

---

## Form de cadastro (novo cliente OU editar existente)

Abre como modal ou rota dedicada `/cadastros/novo` ou `/cadastros/:documento/editar` — escolha o que combinar com o resto da aplicação. Conteúdo idêntico nos dois casos; em edição, campos vêm preenchidos.

### Seção 1 — Dados básicos do cliente

- **CNPJ / CPF** (input texto, máscara `XX.XXX.XXX/XXXX-XX` ou `XXX.XXX.XXX-XX`)
  - Aceita só dígitos; ao salvar, manda **só dígitos** pro back (sem pontuação).
  - Validação: 11 (CPF) OU 14 (CNPJ) dígitos. Bloqueia salvar fora disso.
  - Em edição, campo fica **readonly** (documento é PK; trocar = criar outro cliente).
- **Nome do cliente** (input texto, obrigatório)
- **Senha de tracking SSW** (input texto, obrigatório, **visível em claro**)
  - Helper text abaixo do campo: "É a senha que o SSW da transportadora configurou pro CNPJ desse cliente. Sem ela, o agente não consegue rastrear nada desse cliente."
- **Operador responsável** (dropdown)
  - **Pra operador**: campo oculto/disabled, valor fixo = ele mesmo. Mostra label "Você (Larissa)" como confirmação visual.
  - **Pra gestor**: dropdown obrigatório com lista de operadores ativos (`papel='operador'`). Mostra "Nome — email".
- **Observações** (textarea, opcional) — campo `notes` em `tracking_credentials`.

### Seção 2 — Contatos do cliente

Lista de linhas inline + botão `+ Adicionar contato` no fim. Cada linha tem:

- **Canal** (dropdown): `email` ou `whatsapp` (NÃO mostra `dominio` — é auto-gerado pelo back a partir dos emails)
- **Valor** (input texto, obrigatório)
  - Se canal=email: validação regex padrão de email no submit
  - Se canal=whatsapp: aceita DDD+número (11 dígitos, ex: `31999998888`)
- **Ordem** (input number, default 1, mínimo 1) — define preferência (1 = usar primeiro)
- **Uso** (dropdown, default "geral"): `geral`, `cobranca`, `logistico`, `financeiro`, `comercial`
- **Pessoa** (input texto, opcional) — ex: "Carolina Souza"
- **Observação** (input texto curto, opcional) — ex: "Responde rápido pelo WhatsApp"
- Botão `🗑 Remover` por linha (só habilita se houver >1 linha)

**Regra dura no submit:** pelo menos 1 contato precisa ter canal=email. O banco também bloqueia, mas a UI deve impedir o submit (botão "Salvar" disabled enquanto não tem email).

**Default da primeira linha** (cliente novo): canal=email, ordem=1, uso=geral.

### Botões

- **Salvar** (primário) — só habilita quando todas validações passam:
  - Documento 11 ou 14 dígitos
  - Nome ≥ 1 caractere após trim
  - Senha ≥ 1 caractere após trim
  - Operador responsável definido (gestor) ou implícito (operador)
  - Pelo menos 1 contato canal=email com email válido
  - Todos os contatos têm `valor` não vazio
- **Cancelar** (secundário) — volta pra listagem sem salvar

### Submit — chama RPC `cadastrar_cliente_completo`

```ts
const { data, error } = await supabase.rpc("cadastrar_cliente_completo", {
  p_documento: documento.replace(/\D/g, ""),  // só dígitos
  p_nome: nomeCliente.trim(),
  p_senha_tracking: senhaTracking.trim(),
  p_contatos: contatos.map(c => ({
    tipo: c.canal,
    identificador: c.valor.trim(),
    ordem: c.ordem,
    tipo_uso: c.uso,
    nome_pessoa: c.pessoa?.trim() || null,
    observacao: c.observacao?.trim() || null,
  })),
  // Só envia se for gestor; operador não precisa (RPC força self)
  p_operador_responsavel_id: papel === "gestor" ? operadorSelecionado : null,
  p_notes: observacoes?.trim() || null,
});
```

**Resposta de sucesso:**
```json
{
  "ok": true,
  "documento": "12889035000293",
  "nome": "INOVAMED",
  "operador_responsavel_id": "af386131-...",
  "contatos_inseridos": 3,
  "dominios_inferidos": ["inovamed.com.br"]
}
```

Mostra toast verde: `Cliente INOVAMED cadastrado. 3 contatos + 1 domínio inferido.` Redireciona pra listagem.

**Erros possíveis (vêm como `error.message`):**
- "Documento inválido: deve ter 11 (CPF) ou 14 (CNPJ) dígitos numéricos. Recebido: 123"
- "Senha de tracking SSW é obrigatória — sem ela o agente não consegue rastrear o cliente"
- "Email inválido: xpto"
- "Cliente precisa de pelo menos 1 contato do tipo email — sem ele Cockpit não envia mensagens"
- "Cliente {documento} já está cadastrado e atribuído a outro operador. Só gestor pode reatribuir."

Mostra como toast vermelho com a mensagem exata.

---

## Desativar cliente

Botão 🚫 na listagem chama RPC `desativar_cliente`. Confirma com modal: **"Desativar cliente {nome}? Os contatos param de ser usados pelo Cockpit imediatamente. Você pode reativar editando depois."**

```ts
const { data, error } = await supabase.rpc("desativar_cliente", {
  p_documento: documento,
});
```

Após sucesso: toast `Cliente desativado.` + refresh da listagem.

**Reativar**: editar o cliente e salvar — o RPC `cadastrar_cliente_completo` faz upsert com `ativo=true` sempre, então qualquer save re-ativa.

---

## Detalhes finos

- **Máscara CNPJ/CPF na exibição**: formata sempre — `12.889.035/0002-93` ou `136.485.306-07`. No banco, fica só dígitos.
- **Domínio NÃO aparece na UI**: o RPC auto-gera linhas `tipo=dominio` pra cada email único. Listagem agrega só email + whatsapp na coluna "Contatos" — ignora linhas tipo=dominio (essas são uso interno do vinculador pra match de remetente).
- **Edição preserva ordem dos contatos** — mantém os campos como estavam no último save.
- **Senha tracking** é mostrada em claro mesmo (campo `input type="text"`). Operadora confere e edita à vontade. NÃO use `type="password"` — Caio decidiu visível.
- **Loading states**: spinner no botão "Salvar" enquanto RPC executa.
- **Cache**: invalida React Query (ou equivalente) das queries de `tracking_credentials` e `contatos_cliente` após cadastrar/desativar.

---

## Schema das tabelas (referência)

Não precisa migrar nada — banco já tem tudo.

**`tracking_credentials`** (1 linha por cliente):
- `documento` (PK, text, 11 ou 14 dígitos)
- `nome_amigavel` (text, NOT NULL)
- `senha` (text)
- `notes` (text)
- `ativo` (boolean)
- `operador_responsavel_id` (uuid, FK operadores)
- `updated_by` (uuid)
- `created_at`, `updated_at`

**`contatos_cliente`** (N linhas por cliente):
- `id` (PK, bigserial)
- `documento_cliente` (text)
- `tipo` (`email` | `whatsapp` | `dominio`)
- `identificador` (text — o email/wpp/domínio)
- `ordem` (int)
- `tipo_uso` (`geral` | `cobranca` | `logistico` | `financeiro` | `comercial`)
- `nome_pessoa`, `cargo`, `observacao` (text, opcionais)
- `ativo` (boolean)
- `operador_responsavel_id` (uuid)

**`operadores`** (pra dropdown de gestor):
- `id` (uuid)
- `nome`, `email` (text)
- `papel` (`operador` | `gestor`)
- `ativo` (boolean)

**RLS**: ambas tabelas filtram automaticamente — operador só vê os clientes onde `operador_responsavel_id = self`; gestor vê tudo. Não precisa filtrar no front, banco já força.

---

## Resumo do que entregar

1. Item de menu **CADASTROS** logo abaixo de AUDITORIA.
2. Listagem com search, filtros, tabela de clientes com ações editar/desativar.
3. Form (criar/editar) com seções Dados Básicos + Contatos.
4. Modal de confirmação pra desativar.
5. Integração com RPCs `cadastrar_cliente_completo` e `desativar_cliente`.
6. Tratamento de erros do RPC (toast com mensagem exata do back).
7. Loading/empty states caprichados.

Visual: segue o padrão existente do Cockpit (mesma tipografia, cores, espaçamentos). Não inventa novo design system — replica o que já está nas outras abas.

# Lovable — PATCH: "Reportar erro de lançamento" libera TODAS as ocorrências

**Data:** 2026-06-20
**Backend:** nada a fazer — já está 100% pronto e deployado.
**Escopo:** SÓ o dropdown "QUAL ERA A OCORRÊNCIA CORRETA?" do modal **"Reportar erro de
lançamento de ocorrência"** (botão ⚠️ no histórico SSW do card).

---

## Problema (Caio 2026-06-20)

A base/operação lança uma ocorrência errada que deveria ser do Relacionamento. Ao tentar
**reportar o erro**, o dropdown "Qual era a ocorrência correta?" só lista ~15 ocorrências
fixas (hardcoded). Quando a oc correta não está nessa lista curta, o operador **não tem
como reportar** — fica travado.

## Correção

Trocar a lista **hardcoded** por busca dinâmica do catálogo completo (as 58 ocorrências da
empresa) na tabela `ocorrencias_dicionario`. É exatamente o mesmo padrão que o modal de
**ação emergencial** (`lovable-acao-executada-emergencial.md`) já usa em produção — então a
query, RLS e grants já estão validados.

- Mantém a 1ª opção especial **"⭐ A MESMA (oc=X está correta, problema é na evidência)"**.
- Lista TODAS as ocorrências do dicionário (menos a própria oc reportada — pra essa o
  operador escolhe "A MESMA").
- Agrupa por **setor responsável** (`<optgroup>`), com **Relacionamento no topo** — é o
  caso mais comum ("operação lançou, mas era do Relacionamento").
- **Submit não muda em nada.** A RPC `reportar_erro_lancamento` já aceita qualquer código.

---

## Backend que o front consome (já existe, NÃO precisa criar)

**Catálogo (fonte das opções):** tabela `ocorrencias_dicionario` — colunas `codigo` (int,
PK), `descricao` (text), `responsabilidade` (text: `Operação` | `Relacionamento` |
`Cliente` | `Perdas` | `Ressarcimento` | `Devolução` | `Agendamento`). RLS: `SELECT`
liberado pra `authenticated`. 58 linhas.

```ts
const { data } = await supabase
  .from('ocorrencias_dicionario')
  .select('codigo, descricao, responsabilidade')
  .order('codigo');
```

**Submit (inalterado):** `supabase.rpc('reportar_erro_lancamento', { ... })` — mesmos
parâmetros de hoje. `p_codigo_oc_correta` aceita QUALQUER um dos 58 códigos.

---

## Substituir o `buildDropdown` hardcoded

**Remover** o array fixo `buildDropdown(ocReportada)` (as ~15 ocs `{ tipo: "diferente", ... }`).
**Adicionar** carregamento do catálogo + montagem dinâmica:

```tsx
type SetorResp =
  | 'Relacionamento' | 'Cliente' | 'Operação'
  | 'Devolução' | 'Perdas' | 'Ressarcimento' | 'Agendamento';

interface OcDicionario {
  codigo: number;
  descricao: string;
  responsabilidade: SetorResp;
}

// Relacionamento primeiro (caso mais comum), depois o resto.
const ORDEM_SETOR: SetorResp[] = [
  'Relacionamento', 'Cliente', 'Operação',
  'Devolução', 'Perdas', 'Ressarcimento', 'Agendamento',
];

// Carrega o catálogo completo quando o modal abre.
const [ocsCatalogo, setOcsCatalogo] = useState<OcDicionario[]>([]);

useEffect(() => {
  if (!isOpen) return;
  supabase
    .from('ocorrencias_dicionario')
    .select('codigo, descricao, responsabilidade')
    .order('codigo')
    .then(({ data }) => setOcsCatalogo((data ?? []) as OcDicionario[]));
}, [isOpen]);

// Monta os grupos do dropdown: exclui a própria oc reportada
// (pra ela o operador usa "A MESMA").
const gruposPorSetor = ORDEM_SETOR
  .map((setor) => ({
    setor,
    ocs: ocsCatalogo
      .filter((o) => o.responsabilidade === setor && o.codigo !== ocReportada)
      .sort((a, b) => a.codigo - b.codigo),
  }))
  .filter((g) => g.ocs.length > 0);
```

## Render do `<select>` (com optgroups)

```tsx
// value: "mesma"  -> oc reportada está correta (problema é evidência)
//        "<codigo>" -> oc correta diferente
<select
  value={
    ocCorretaSelecionada == null
      ? ''
      : ocCorretaSelecionada.tipo === 'mesma'
        ? 'mesma'
        : String(ocCorretaSelecionada.codigo)
  }
  onChange={(e) => {
    const v = e.target.value;
    if (!v) { setOcCorretaSelecionada(null); return; }
    setOcCorretaSelecionada(
      v === 'mesma'
        ? { tipo: 'mesma', codigo: ocReportada }
        : { tipo: 'diferente', codigo: Number(v) }
    );
  }}
>
  <option value="">Selecione...</option>

  {/* 1ª opção especial — fluxo de evidência incompleta */}
  <option value="mesma">
    ⭐ A MESMA (oc={ocReportada} está correta, problema é na evidência)
  </option>

  {/* Catálogo completo, agrupado por setor responsável */}
  {gruposPorSetor.map((g) => (
    <optgroup key={g.setor} label={g.setor}>
      {g.ocs.map((o) => (
        <option key={o.codigo} value={o.codigo}>
          {o.codigo} — {o.descricao}
        </option>
      ))}
    </optgroup>
  ))}
</select>
```

> Se hoje o componente lê `ocCorretaSelecionada.tipo` como `"mesma" | "diferente"`, mantenha
> esse mesmo shape — o resto da lógica condicional (badge "EVIDÊNCIA INCOMPLETA", textarea
> obrigatória ≥10 chars quando `tipo === "mesma"`, motivo opcional 300 chars quando
> `"diferente"`) **continua igual**. Só a origem da lista muda.

## Submit (inalterado — não mexer)

```ts
const isMesma = ocCorretaSelecionada.tipo === 'mesma';
await supabase.rpc('reportar_erro_lancamento', {
  p_card_id: cardId,
  p_codigo_oc_errada: ocReportada,
  p_codigo_oc_correta: ocCorretaSelecionada.codigo,
  p_descricao_oc_errada: descricaoOcReportada,
  p_data_oc_errada: dataOcReportada,
  p_base_responsavel: baseResponsavel,
  p_usuario_responsavel: usuarioResponsavel,
  p_motivo: motivoTexto.trim() || null,
  p_motivo_categoria: isMesma ? 'EVIDENCIA_INCOMPLETA' : 'OC_DIFERENTE',
});
```

## Critério de aceite

1. Abrir o modal "Reportar erro de lançamento" em qualquer oc do histórico SSW.
2. O dropdown "Qual era a ocorrência correta?" lista as **58 ocorrências** da empresa,
   agrupadas por setor (Relacionamento primeiro), com a própria oc reportada **fora** da
   lista de diferentes.
3. "⭐ A MESMA" continua no topo e dispara o fluxo de evidência incompleta.
4. Reportar uma oc que **antes não existia na lista** (ex.: era do Relacionamento) grava
   sem erro e fecha o modal.
5. Loading: enquanto o catálogo carrega, mostrar "Selecione..." (sem travar o modal).

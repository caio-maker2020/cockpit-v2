---
description: Auditoria periódica da auto-memory do Cockpit — detecta memories stale, conflitantes, redundantes, e regras de negócio que divergiram do código
---

# /memory-audit — Auditoria de Auto-Memory

Roda em sequência (não pula etapas). Produz um RELATÓRIO de saúde da memory + recomendações de ação. **Não apaga nada sozinho** — Caio decide o quê remover/consolidar/atualizar.

## Configuração

```bash
MEMORY_DIR="/Users/caiodevasconcelos/.claude/projects/-Users-caiodevasconcelos-Documents--code-cockpit-v2-/memory"
PROJECT_DIR="/Users/caiodevasconcelos/Documents/:code:cockpit-v2 /cockpit-v2-starter"
LIMITE_AVISO=60         # acima desse número de entries, alerta
LIMITE_IDADE_DIAS=30    # acima dessa idade sem update, marca stale
```

## Fase 1 — Inventário

```bash
echo "=== INVENTÁRIO ==="
TOTAL=$(ls "$MEMORY_DIR"/*.md 2>/dev/null | grep -v MEMORY.md | wc -l | tr -d ' ')
echo "Total de memory files (excluindo MEMORY.md): $TOTAL"
echo "Limite de aviso: $LIMITE_AVISO"
if [ "$TOTAL" -gt "$LIMITE_AVISO" ]; then
  echo "ALERTA: passou do limite. Considere consolidações."
fi
echo ""
echo "Por tipo:"
for tipo in user feedback project reference; do
  COUNT=$(ls "$MEMORY_DIR"/${tipo}_*.md 2>/dev/null | wc -l | tr -d ' ')
  echo "  ${tipo}: ${COUNT}"
done
echo ""
echo "MEMORY.md tamanho (linhas):"
wc -l "$MEMORY_DIR/MEMORY.md" | awk '{print $1}'
echo "  (>200 linhas trunca em sessões novas)"
```

## Fase 2 — Memory files stale (>30 dias)

```bash
echo ""
echo "=== STALE (sem update há > $LIMITE_IDADE_DIAS dias) ==="
find "$MEMORY_DIR" -name "*.md" -not -name "MEMORY.md" -mtime +$LIMITE_IDADE_DIAS -printf "%T@ %p\n" 2>/dev/null | sort -n | while read ts path; do
  fname=$(basename "$path")
  dias=$(( ( $(date +%s) - ${ts%.*} ) / 86400 ))
  echo "  ${dias}d  $fname"
done
# Fallback se find -printf não existe (macOS)
find "$MEMORY_DIR" -name "*.md" -not -name "MEMORY.md" -mtime +$LIMITE_IDADE_DIAS 2>/dev/null | while read path; do
  fname=$(basename "$path")
  dias=$(( ( $(date +%s) - $(stat -f %m "$path") ) / 86400 ))
  printf "  %3dd  %s\n" "$dias" "$fname"
done | sort -rn
```

## Fase 3 — MEMORY.md entries apontando pra arquivos inexistentes

```bash
echo ""
echo "=== ENTRIES ÓRFÃS NO MEMORY.md ==="
grep -oE '\[.+?\]\(([^)]+\.md)\)' "$MEMORY_DIR/MEMORY.md" | grep -oE '\([^)]+\)' | tr -d '()' | while read referenced; do
  if [ ! -f "$MEMORY_DIR/$referenced" ]; then
    echo "  $referenced — apontado em MEMORY.md mas ARQUIVO NÃO EXISTE"
  fi
done
echo "(vazio = OK)"
```

## Fase 4 — Memory files que citam arquivos do código que não existem mais

```bash
echo ""
echo "=== MEMORY CITANDO CÓDIGO INEXISTENTE ==="
cd "$PROJECT_DIR"
grep -rEho '(supabase/functions|lib|prompts|migration)/[a-zA-Z0-9_\-/]+\.(ts|sql|md)' "$MEMORY_DIR" 2>/dev/null | sort -u | while read filepath; do
  if [ ! -f "$PROJECT_DIR/$filepath" ]; then
    # Onde a referência está
    files=$(grep -lR "$filepath" "$MEMORY_DIR" 2>/dev/null | xargs -n1 basename | sort -u | tr '\n' ',' | sed 's/,$//')
    echo "  $filepath  ←  referenciado em: $files"
  fi
done
echo "(vazio = OK)"
```

## Fase 5 — Memory citando símbolos (funções/constantes) que não existem mais

```bash
echo ""
echo "=== MEMORY CITANDO SÍMBOLOS POSSIVELMENTE OBSOLETOS ==="
# Detecta menções tipo `funcaoName(...)` ou `CONSTANTE_NOME` em memories,
# grep no código pra ver se ainda existe. Apenas patterns CamelCase/SNAKE_CASE
# pra evitar ruído de palavras comuns.
cd "$PROJECT_DIR"
grep -rhoE '\b([A-Z][A-Z_]{4,}|[a-z][a-zA-Z]{4,}[A-Z][a-zA-Z]+)\b' "$MEMORY_DIR" 2>/dev/null \
  | sort -u | head -300 | while read sym; do
  # Pula símbolos genéricos demais
  case "$sym" in
    TRUE|FALSE|NULL|AGUARDANDO_*|EXECUTANDO_*|ACAO_*|RESOLVIDO|CANCELADO|TRANSFERIDO|TRATATIVA_*) continue;;
    AcaoExecutada|RespostaEnviada|BastaoCardAtualizado|*Evento*|*Event*) continue;;
    HEAD|GET|POST|PATCH|DELETE|true|false|null) continue;;
    ssw_*|gmail_*|SSW_*|GMAIL_*|SUPABASE_*) continue;;
  esac
  # Grep rápido — só verifica se o símbolo existe no codebase
  if ! grep -rqE "\b$sym\b" --include='*.ts' --include='*.sql' supabase lib migration 2>/dev/null; then
    files=$(grep -rlE "\b$sym\b" "$MEMORY_DIR" 2>/dev/null | xargs -n1 basename | sort -u | head -3 | tr '\n' ',' | sed 's/,$//')
    echo "  $sym  ←  citado em: $files (não encontrado no código)"
  fi
done
echo "(vazio = OK; pode ter falsos positivos — verificar manualmente)"
```

## Fase 6 — Bonus: regras de negócio que divergiram do código

```bash
echo ""
echo "=== REGRAS DE NEGÓCIO POSSIVELMENTE DIVERGENTES ==="
cd "$PROJECT_DIR"

# Set OCORRENCIAS_DE_RELACIONAMENTO no código atual
SET_ATUAL=$(grep -A 4 'export const OCORRENCIAS_DE_RELACIONAMENTO' lib/bastao-rules.ts | grep -oE '[0-9]+' | sort -n | tr '\n' ',' | sed 's/,$//')
echo "Set OCORRENCIAS_DE_RELACIONAMENTO no código (lib/): $SET_ATUAL"

# Procura memories que mencionam o set explicitamente com valores
echo ""
echo "Memories que citam o set com valores específicos:"
grep -rEH 'OCORRENCIAS_DE_RELACIONAMENTO.*\{[^}]+\}|\{ ?3.*52' "$MEMORY_DIR" 2>/dev/null | while read line; do
  file=$(basename "${line%%:*}")
  match=$(echo "$line" | grep -oE '\{[^}]+\}' | head -1)
  echo "  $file  →  $match"
done
echo "(verificar manualmente se cada uma bate com o set atual)"

# Janelas (30min, 60min) em memories — checar se ainda são essas as janelas no código
echo ""
echo "Janelas de tempo nas memories vs código:"
echo "  Pass A janela voltouParaRelacionamento (codigo): $(grep -oE 'JANELA_REABERTURA_MS = [0-9]+ \* 60_000' supabase/functions/sync-bastao/index.ts)"
echo "  Pass G janela bastao_avancou (codigo): $(grep -oE 'JANELA_BASTAO_AVANCOU_MS = [0-9]+ \* 60 \* 1000' supabase/functions/sync-bastao/index.ts)"
echo ""
grep -rEh '[0-9]+min\b|JANELA_[A-Z_]+' "$MEMORY_DIR" 2>/dev/null | grep -oE '[0-9]+min' | sort -u | while read janela; do
  files=$(grep -rlE "\b$janela\b" "$MEMORY_DIR" 2>/dev/null | xargs -n1 basename | sort -u | head -3 | tr '\n' ',' | sed 's/,$//')
  echo "  $janela  →  citado em: $files"
done
```

## Fase 7 — Tópicos sobrepostos (possível redundância)

```bash
echo ""
echo "=== TÓPICOS SOBREPOSTOS (possível redundância) ==="
# Identifica grupos de memory files com nomes parecidos
ls "$MEMORY_DIR" | grep -v MEMORY.md | grep -v "^$" | awk -F'_' '{print $1"_"$2}' | sort | uniq -c | sort -rn | while read count prefix; do
  if [ "$count" -ge 2 ]; then
    echo "  ${count}× prefixo '${prefix}':"
    ls "$MEMORY_DIR" | grep "^${prefix}_" | sed 's/^/    /'
  fi
done
echo "(grupos com 2+ entries cobrindo mesmo tópico merecem revisão de consolidação)"
```

## Fase 8 — Sumário e ações sugeridas

Reúne resultados das fases 1-7 e produz:

```
MEMORY AUDIT — <data/hora>
==========================
Total files:       X (limite aviso: 60)
MEMORY.md:         Y linhas (limite truncamento: 200)
Stale (>30d):      Z entries
Órfãs no index:    N apontamentos quebrados
Código inexistente: M referências
Símbolos obsoletos: K menções
Janelas/regras divergentes: J casos
Grupos sobrepostos: G

AÇÕES SUGERIDAS (prioridade alta primeiro):
1. [APAGAR]      memory_file.md — referencia código que não existe há 45d
2. [ATUALIZAR]   project_pass_g.md — janela 30min cita linha que mudou
3. [CONSOLIDAR]  project_protecao_* (3 files) — tópicos sobrepostos
4. [REVISAR]     feedback_*.md com 60d sem update

Próximo audit recomendado: <data+7d>
```

## Regras de execução

- **Não apagar nada sozinho.** Audit é diagnóstico. Caio decide.
- **Não invocar outras skills.** Audit é isolado.
- Falsos positivos esperados na Fase 5 (símbolos) — revisar manualmente.
- Falsos positivos esperados na Fase 6 (regras) — comparar contexto.
- Se uma fase falhar (ex: comando não suportado no shell), reportar como N/A e continuar.

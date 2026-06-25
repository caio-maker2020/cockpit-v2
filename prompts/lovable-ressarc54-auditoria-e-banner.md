# Lovable — Agente "relançar 54 por ressarcimento" (REUSAR o card padrão do agente)

⚠️ **Correção (Caio 2026-06-25):** a 1ª versão saiu fora do padrão (um banner azul
próprio com "Reportar erro"). **NÃO criar componente novo.** Esta recomendação tem que
renderizar **com o MESMO componente "RECOMENDADO PELO AGENTE IA"** já usado pelas ocs
padrão (10/19/35) — aquele card roxo com **título da ação**, **Confiança: alta (xx%)**,
botão **"✓ Aprovar"**, **"Ver outras opções →"** e o feedback **"✓ IA acertou · ✗ IA errou"**.

## De onde vêm os dados (já no ar no backend)

O agente escreve em `cards.aviso_alteracao_oc` no **mesmo contrato** das ocs padrão:

```json
{
  "tipo": "ressarcimento_relancar_54",
  "proposta_destacada": 54,
  "sem_email": true,
  "confianca": 0.95,
  "tier": "A",
  "observacao_orquestrador": "🔁 RESSARCIMENTO PEDIU PRA RELANÇAR A 54: ...",
  "template_email_sugerido": null,
  "oc46_data": "23/06/26 17:18",
  "oc54_data": "02/06/26 16:05"
}
```

## O que fazer no front

1. **No mesmo switch/branch que renderiza `tipo: "ia_sugestao_ocs_padrao"`**, tratar
   também `tipo: "ressarcimento_relancar_54"` usando **o MESMO componente de card**
   (RECOMENDADO PELO AGENTE IA). Nada de layout novo.
   - **Título do card:** a ação da proposta destacada → "Lançar oc=54 (sem e-mail) — reiteração do ressarcimento".
   - **Chip de confiança:** `confianca` (0.95 → "alta (95%)"), igual às ocs padrão.
   - **Texto:** `observacao_orquestrador`.
   - **Chip do tier:** mostrar `tier` (A/B) como tag pequena.

2. **Proposta destacada / botão Aprovar:** `proposta_destacada = 54` **com `sem_email = true`**
   → destacar e aprovar a proposta **"Lançar SÓ oc 54 (sem email)"** do menu (a que tem
   `proposta_payload.meta.sem_email_explicito = true`), **NÃO** a "54 + email". O botão é
   o **"✓ Aprovar oc=54 (sem e-mail)"** padrão (lança direto, sem abrir editor de e-mail).
   "Ver outras opções →" abre o resto do menu, igual hoje.

3. **Feedback IA acertou/errou (taxa de acertos):** usar os **mesmos botões** do card padrão.
   - **✓ IA acertou** → implícito quando o operador aprova a proposta destacada (nada extra a fazer).
   - **✗ IA errou** → como a oc 49 está fora do escopo do RPC padrão (`registrar_feedback_ocs_padrao_ia`
     só aceita oc 10/11/19/35), chamar o RPC específico:
     ```ts
     await supabase.rpc('reportar_erro_ressarc54', { p_card_id: cardId, p_motivo: motivo /* obrigatório */ });
     ```

## Aba AUDITORIA — seção "🔁 Agente relançar-54 (ressarcimento)"

⚠️ **Uma seção só por agente (não duplicar).** Ideal: uma área única "Auditoria de
Agentes" com abas (Extravios | Relançar-54), e cada aba = **[números no topo] + [lista
filtrável]**, usando o MESMO componente.

### a) Números no topo — view `v_ressarc54_resumo` (1 linha, global)
`sugeriu_total` (`sugeriu_tier_a` / `sugeriu_tier_b`), `lancou_total`
(`lancou_autonomo` 🤖 / `lancou_operador` 👤), `nao_rodou_total`, `recomendou_pendente`,
`reportado_errado_total`. Taxa de acerto = `lancou_total / sugeriu_total`.

### b) Lista filtrável card-a-card — view `v_ressarc54_painel`
Colunas: `nf`, `operador`, `tier`, `categoria`, `lancado_por` (autonomo/operador),
`instrucao_49`, `state`, `lancado_em`, `ultima_acao` + flags `foi_recomendado` /
`foi_lancado` / `teve_nao_rodou` / `reportado_errado`.
- **Filtro (3 botões/abas):**
  - **LANÇOU** → `foi_lancado = true` (mostrar `lancado_por`: 🤖 autônomo / 👤 operador)
  - **RECOMENDOU** → `foi_recomendado = true` (funil — inclui os já lançados)
  - **NÃO RODOU** → `teve_nao_rodou = true AND foi_lancado = false`
- `categoria` já traz o status primário (LANCOU > RECOMENDOU > NAO_RODOU) se quiser uma coluna única.

Ambas `security_invoker` (operador vê só os cards dele; gestor vê todos). O botão
**"✗ IA errou"** de cada linha chama `reportar_erro_ressarc54(p_card_id, p_motivo)`.

> As views `v_ressarc54_metricas` (por operador) e `v_ressarc54_auditoria` (timeline) seguem
> existindo pra drill-down, mas pro painel principal use **resumo + painel** (não repita contadores).

É essa aba + o "IA errou" que o Caio usa pra validar a taxa antes de ligar o autônomo.

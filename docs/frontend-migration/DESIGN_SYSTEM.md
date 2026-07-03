# Design System — Cockpit v2 (front próprio)

> **Status:** DRAFT de direção (Fase 0). Baseado nas respostas do Caio. Detalhes finos (tipografia, escala) a **validar no Dia 0** com referências visuais. Não bloqueia o baseline (a cara nova vem na refatoração, não na cópia do export).
> **Data:** 2026-07-03.

## Direção (respostas do Caio)
- **Visual:** **Minimalista SaaS moderno** — limpo, cantos suaves, base neutra. Afastar do creme/editorial atual do Lovable.
- **Marca Sal:** **forte** — vermelho Sal + logo presentes (header/login/rodapé). Modernizar layout mantendo personalidade.
- **Densidade:** **equilibrada** — listas/kanban legíveis sem poluição; um card por vez no detalhe.
- **Storytelling das tratativas:** **híbrido** — narrativa em português por cima ("Cliente respondeu 14h → agente sugeriu oc 54 → você aprovou → e-mail enviado"), cada passo expande no evento técnico (`card_events`/payload) pra auditoria.
- **Velocidade × visual:** **velocidade operacional ganha** — atalhos de teclado, latência mínima, pouca animação, realtime > polling.
- **Dor a resolver:** consistência e estabilidade (a inconsistência entre telas do Lovable some com um design system único).

## Princípios
1. **O front some, o trabalho aparece.** Nada de enfeite que atrase o operador.
2. **Consistência > originalidade por tela.** Um só sistema de tokens/componentes.
3. **Marca Sal como acento confiante**, não como tema pesado: neutro na base, vermelho no que importa (ações-chave, estado AVH, alertas, logo).
4. **Densidade equilibrada:** informação suficiente sem poluir; hierarquia clara.
5. **Acessível:** contraste AA, foco visível, navegação por teclado.

## Tokens (manter o sistema de CSS custom properties do export)
O export já usa variáveis (`--signal`, `--bg`, `--bg-subtle`, `--c-border`, `--c-ink`, `--c-ink-soft`, `--c-ink-mute`, `--warning`, `--danger`). **Reaproveitar o mecanismo**, retematizando os valores pro visual SaaS-moderno:
- `--bg` / `--bg-subtle`: base neutra clara (branco/cinza levíssimo).
- `--c-ink` / `--c-ink-soft` / `--c-ink-mute`: escala de texto.
- `--c-border`: hairline neutro.
- `--signal`: **vermelho Sal** (acento primário — ações, AVH, badge).
- `--warning`: âmbar (atenção, ex.: canc. reentrega precisa-ação).
- `--danger`: vermelho destrutivo (conflitos, erro).
- Estados: positivo (verde discreto), neutro/mute.
> Definir dark mode? Login do Lovable era dark cinematográfico; decidir no Dia 0 se mantém login dark ou unifica claro.

## Tipografia (decisão do Dia 0)
- **Opção A (recomendada a avaliar):** neutra moderna (Inter/Geist) para UI + **JetBrains Mono** para dados técnicos (NF, CTRC, timestamps, códigos oc). Combina com "SaaS moderno".
- **Opção B:** manter Bricolage Grotesque. Menos "SaaS", mais autoral.
- Timestamps sempre **BRT** (America/Sao_Paulo, UTC−3) — nunca UTC (regra do Caio, ver memória `feedback_reportar_horarios_em_brt`).

## Componentes-chave a padronizar
- **Kanban/lista de cards** (Inbox): card compacto, badge de estado, canal, tempo relativo, dono.
- **Banner de IA unificado**: hoje há muitos (`BannerSugestaoIA`, evidência, bounce, preexistente, mudança-suspeita). Unificar num componente com variantes (sugestão / autônoma-executada / analisando / falhou / atenção).
- **Timeline híbrida** (storytelling): narrativa legível + expandir evento técnico.
- **Composer de e-mail** + modal de edição (`EditarEmailModal`): revisar antes de enviar; Cmd/Ctrl+Enter envia.
- **Ações propostas** (`ProposedActions`): destaque da ação recomendada, aprovar/rejeitar, extras por OC.
- **Empty/loading/erro** padronizados (skeleton, empty com microcopy, erro com retry).

## Navegação por teclado (velocidade)
- Inbox: mover entre cards (j/k), abrir (enter), aprovar/rejeitar com atalho, buscar (/). Definir mapa completo na Fase de redesign.

## Mobile
- **Go-live:** triagem — abrir card, **aprovar, rejeitar, responder**. Layout responsivo Tailwind.
- Telas pesadas (Indicadores/Cadastros/Admin/editar e-mail longo): **usáveis sem quebrar**, podem ser **desktop-first** no 1º go-live; mobile caprichado dessas = fase 2.

## Referências
- Norte default (sem refs do Caio ainda): **Linear** e **Vercel dashboard** ("SaaS limpo + denso o suficiente") com marca Sal por cima.
- **Pendente:** Caio enviar 2–3 refs que gosta / que NÃO quer copiar, antes do Dia 0.

## O que NÃO copiar do Lovable
- Inconsistência visual entre telas · God-components · estados vazios/erro ad-hoc · qualquer polling agressivo · estética creme editorial (decisão do Caio de mudar).

// =============================================================================
// interpretador-resposta-cliente — agente IA Sonnet que lê resposta do cliente
// + email da Larissa pré-resposta + lista de anexos enviados, e sugere a
// próxima oc + detecta pendências (cliente respondeu parcial?) + identifica
// padrão de ressarcimento (combo 33+44).
//
// v3 (Caio 2026-05-12 NF 920161): IA agora compara perguntas Larissa vs
// respostas cliente. Detecta casos como "Larissa pediu romaneio mas cliente
// respondeu sem anexar". Sugere combo 33+44 quando cliente autorizou
// devolução E Larissa pediu romaneio (= caso ressarcimento).
//
// Input:  { card_id, message_id }
// Output: { ok, oc_sugerida, confianca, motivo, instrucao_reentrega_sugerida?,
//          pendencias_resposta_cliente, sugere_combo_33_44, motivo_combo? }
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  createAnthropicClient,
  readAnthropicEnvFromProcess,
} from "../_shared/anthropic-client.ts";
import { makeUsageRecorder } from "../_shared/anthropic-usage-logger.ts";
import { reconciliarSugestaoInterpretador } from "../_shared/regras-interpretador-resposta.ts";
import {
  degradarLeituraParcial,
  deveDesistirDoLlm,
  montarSugestaoDegradada,
} from "../_shared/interpretador-degradacao.ts";
import { resolverExclusaoCombos } from "../_shared/exclusao-combos.ts";
import { aplicarPacoteOc11PosResposta } from "../_shared/oc11-pos-resposta.ts";
import { aplicarInstrucaoEmailNaProposta21 } from "../_shared/instrucao-email-21.ts";
import { gravarDestaqueRespostaCliente } from "../_shared/destaque-resposta-cliente.ts";
import { aplicarTexto56NaProposta } from "../_shared/texto-56-sugerido.ts";
import { detectarPedidoDeRessalva, resolverRessalvaExistente } from "../_shared/resolver-pedido-ressalva.ts";
import { aplicarAnexosSugeridos33 } from "../_shared/anexos-33-sugeridos.ts";
import { ehRespostaSemAcao, STATES_DEVOLVIVEIS, type LeituraPraDevolucao } from "../_shared/resposta-sem-acao.ts";
import { agendarAcaoAutonomaSeElegivel } from "../_shared/veto-agendamento.ts";
import {
  avaliarDossie,
  classificarOc33,
  decidirGateOc33,
  deveProcessarDossie,
  dossieVazio,
  lerExtravioParcial,
  mergeEvidencia,
  montarEvidenciasRecebidas,
  montarSeedRomaneio,
  type AnexoHistorico,
  type EvidenciasRecebidas,
  type MensagemHistorico,
  type OcHistSsw,
} from "../_shared/extravio-parcial-dossie.ts";

const MODEL = "claude-sonnet-4-6";

const SYSTEM_PROMPT = `Você é o agente que interpreta a resposta de um cliente farmacêutico depois que a Sal Express lançou oc=54 ("aguardando posicionamento do cliente pagador") sobre uma NF com problema (recusa total/parcial, problema endereço, falta volume, etc).

Você recebe 3 informações:
1. **Email enviado pela operadora pré-resposta** (perguntas/solicitações feitas ao cliente). O nome real da operadora vem no campo OPERADORA do contexto — use-o se precisar referenciar a operadora no output.
2. **Texto da resposta do cliente** (o que ele devolveu).
3. **Lista de anexos enviados pelo cliente** (filenames/mime types — pode ser vazio).

Sua tarefa: comparar o que a operadora pediu vs. o que o cliente respondeu, e produzir:

(a) **Sugestão de próxima oc** — uma de 6 opções:
- **44 (RETORNO DE CARGA / DEVOLUÇÃO)**: cliente autorizou devolução **em 1ª pessoa, sem ambiguidade**. Ex: "pode devolver", "autorizo a devolução", "ok, devolve", "liberado pra abrir NFD", "prossiga com a devolução". **Inclui o caso em que cliente envia anexo (ex: romaneio) e autoriza devolução — o anexo NÃO move pra oc=56, ele resolve a pendência. A oc principal continua sendo 44.**

  **⚠️ Falsos positivos comuns — NÃO classifique como oc=44:**
  - "**Orientar o cliente a emitir NFD**" / "Orientem o destinatário a abrir NFD" — verbo na 3ª pessoa, dirigido a TERCEIRO (cliente final). Cliente NÃO autorizou — só pediu pra Sal Express conversar com outra pessoa. → oc=54, confianca<0.5, pendência ressaltando ambiguidade.
  - "**Vamos verificar**" / "Aguarde retorno" / "Vou consultar a área X" — cliente está adiando decisão. → oc=54.
  - "**NFD**" mencionado isoladamente sem verbo de autorização (autorizo / pode / liberado / prossiga / ok) → ambíguo. → oc=54.
  - "**Gentileza fazer X**" onde X é uma instrução **pra Sal Express agir** (não confirmação do cliente) — verbo no imperativo dirigido à transportadora, não autorização. → oc=54.
- **33 (REVERSÃO DE PERDAS / INDENIZAÇÃO — SEM devolução)**: usado em casos de **extravio total** ou outro cenário em que NÃO existe volume físico pra devolver pro cliente. Cliente envia o romaneio e/ou autoriza prosseguir, mas como não há devolução, só faz sentido iniciar o processo de indenização (33), SEM encadear 44. Detectar pelo email da operadora: se assunto/corpo menciona "extravio total" / "perda total" / "extravio de toda a carga" / "100% extraviada" / similar, esse é o cenário.
- **21 (REENTREGA SOLICITADA)**: cliente **CONFIRMOU** que quer nova tentativa de entrega — aval claro e PRESENTE, não intenção futura. Ex: "podem tentar de novo", "pode reenviar", "segue o novo endereço: ...", "estou liberando a reentrega para amanhã".

  **CASO PROBLEMA COM ENDEREÇO (Padronização oc 11 — Isadora 07/08/2026):** quando o e-mail da operadora trata de PROBLEMA COM ENDEREÇO (pede confirmação/correção do endereço, contato ou orientação pra localizar o destino):
  - Cliente respondeu com a INFORMAÇÃO CONCRETA — **novo/confirmado endereço** (rua, número, bairro, CC-e), **telefone de contato**, ou **dado que destrava a entrega** (referência do local, horário, responsável por receber) → **oc=21**. Preencha instrucao_reentrega_sugerida com o dado VERBATIM resumido (ex: "Entregar na Rua X, 123, bairro Y — falar com Sr. Z, tel (31) 9...").
  - Cliente respondeu SEM a informação — encaminhamento interno ("repassei pro setor X", "vou verificar com a filial"), pergunta de volta, promessa vaga, ou texto sem nexo com a correção → **oc=54** + pendência ex: "Faltou o endereço/contato corrigido pra liberar a reentrega" + motivo orientando a operadora a RESPONDER O E-MAIL cobrando a informação completa (não lançar oc antes de ter o dado).

  **⚠️ Falsos positivos comuns — NÃO classifique como oc=21 (use oc=54 + pendência):**
  - "**Estamos alinhando a reentrega**" / "vou verificar a melhor data" / "aguarde que retorno com o endereço" / "estou tratando internamente / com a área X" — cliente sinaliza INTENÇÃO mas ainda NÃO confirmou. → oc=54 + pendência "Cliente não confirmou endereço/data da reentrega".
  - "**Aguarde confirmação**" / "depois confirmo" / "assim que definir eu aviso" — está adiando a decisão. → oc=54.
  - Cliente fala em reentrega MAS **não fornece nem confirma** o endereço/data quando esses dados são necessários. → oc=54 + pendência.

  **REGRA DE COERÊNCIA INVIOLÁVEL (Caio 2026-06-23, NF 16480 SUPER INDUSTRIA C.):** oc=21 significa reentrega CONFIRMADA. Se você listar QUALQUER pendência sobre os dados da reentrega (endereço / data / confirmação não fornecidos), você NÃO PODE sugerir oc=21 — sugira oc=54. "Lançar reentrega" e "cliente ainda não confirmou os dados da reentrega" é uma contradição. O Cockpit rebaixa 21→54 automaticamente quando isso ocorre, então prefira já sugerir 54 + a pendência (= responder cobrando antes de lançar).

  **Caso especial — REENTREGA SEM PAGAR**: se cliente autoriza reentrega de forma EXPLÍCITA MAS se nega explicitamente a pagar pela nova viagem (ex: "podem tentar de novo mas não vou pagar essa viagem", "ok pode reentregar sem cobrar", "vocês que erraram, refaçam sem custo"), continua oc_sugerida=21 + marca o flag cliente_autorizou_reentrega_sem_pagar=true e preenche motivo_cliente_recusa_pagar avaliando se o argumento do cliente é razoável (ver bloco (d) abaixo). Esse é o ÚNICO caso em que oc=21 pode conviver com pendência.
- **55 (AUTORIZAR SEGUIR ENTREGA / PARCIAL)** (Caio 2026-05-20): cliente autorizou **seguir com a entrega do que está disponível AGORA**, sem solicitar reentrega completa. Caso âncora NF 343885: cliente respondeu "podem seguir com a entrega parcial", "entreguem o que tem", "autorizo entrega parcial", "pode liberar pra entregar mesmo sem o volume X", "sigam com o restante". **Diferença crítica vs oc=21:**
  - oc=21 = nova tentativa de entrega COMPLETA (cliente quer receber tudo numa próxima viagem).
  - oc=55 = seguir com o que está disponível NESSA viagem, abrindo mão do volume faltante / aceitando a carga avariada / dispensando reentrega.
  - oc=44 = cliente pediu pra DEVOLVER (carga volta pro remetente). Em oc=55, carga continua pra entrega.
  Se cliente diz literalmente "podem entregar mesmo assim" / "pode prosseguir com a entrega" / "libero a entrega parcial" → oc=55.
  Caso âncora NF 343885: operadora pediu romaneio + posicionamento. Cliente ainda não devolveu o romaneio assinado MAS autorizou seguir a entrega parcialmente — oc_sugerida=55, pendencias_resposta_cliente inclui "Cliente não anexou romaneio assinado — operadora vai informar isso ao lançar oc=55".
- **56 (FALTA INFO OPERACIONAL)**: cliente **QUESTIONOU evidência/foto** OU pediu informação que **Operação precisa revisar** antes de qualquer decisão. Ex: "a foto não mostra a recusa", "preciso ver como foi a entrega", "esse pedido nem é nosso, podem verificar?". **NÃO use 56 quando cliente JÁ enviou o documento que a operadora pediu** — nesse caso a pendência foi resolvida pelo cliente; a próxima ação é seguir o processo (44, 33-solo ou combo 33+44).
  **TEXTO DA 56 (plano de veto, Caio 25/08):** sempre que sugerir oc=56, VOCÊ escreve o texto da instrução em **texto_56_sugerido** — é a descrição que vai direto pro SSW pedindo à Operação exatamente o que falta. Escreva como a operadora escreveria: objetivo, 1-3 frases, citando O QUE o cliente questionou/pediu (ex: "Cliente questiona a evidência de entrega — foto não mostra a recusa. Verificar com a equipe de entrega e retornar com nova evidência/posicionamento."). Nada genérico; o texto nasce da resposta REAL do cliente.
- **54 (RE-LANÇAR — manter aguardando)**: resposta inconclusiva / cliente pediu prazo / não decidiu.

(b) **Pendências** — lista descritiva (até 3 itens) do que a operadora pediu mas o cliente NÃO respondeu / NÃO anexou. Cada item curto (≤120 chars). Use termo neutro ("a operadora", "Sal Express") OU o nome real vindo do campo OPERADORA — NUNCA cite outro nome. Exemplos:
- "Cliente não anexou o romaneio de coleta assinado que a operadora pediu"
- "Cliente não respondeu se autoriza a devolução"
- "Faltou confirmar o novo endereço pra reentrega"

Se cliente respondeu TUDO que a operadora pediu, retorna array vazio [].

(c) **Indenização — combo 33+44 OU oc=33 SOLO** (escolha 1, mutuamente exclusivos):

**Significado das ocs no processo Sal Express:**
- **oc=33** = INÍCIO do processo de INDENIZAÇÃO pelo time de Perdas. A operadora só consegue abrir esse processo COM o romaneio assinado pelo cliente em mãos.
- **oc=44** = autorização de devolução do volume físico (o que está com a Sal) ao cliente.

**REGRA CRÍTICA — extravio total**: Se o email da operadora indica **extravio total** (assunto/corpo com "extravio total", "perda total", "extravio de toda a carga", "100% extraviada", ou contexto equivalente), **NÃO EXISTE volume pra devolver pro cliente** — então NUNCA sugira combo 33+44 (oc=44 não faz sentido). Use oc=33 solo. Detalhe: em extravio total, a operadora pede o romaneio APENAS pra iniciar a indenização, não pra autorizar devolução.

**Quando sugerir cada uma:**

- Operadora pediu romaneio/ressarcimento E cliente autorizou devolução E NÃO é extravio total → sugere_combo_33_44=true e oc_sugerida=44.
- Operadora pediu romaneio/ressarcimento E cliente forneceu E **É extravio total** → sugere_oc33_solo=true e oc_sugerida=33.
- Nenhuma das condições acima → ambos false; oc_sugerida segue a regra (a).

**As DUAS naturezas da oc=33 (Caio 2026-07-01, NF 66193 — leia com atenção):**
- **oc=33 OPERACIONAL (combo com 44)** — Caso DEVOLUÇÃO / recusa: o cliente autoriza devolver e manda o **romaneio**. A oc=33 aqui só INICIA o processo e destrava a devolução (oc=44). O cliente NÃO precisa mandar descrição/valor AGORA — ele só vai saber os itens/valor faltantes DEPOIS que a devolução voltar pra mão dele. Então o combo 33+44 exige **SÓ o romaneio**.
- **oc=33 de COMPLETUDE de indenização** — extravio PARCIAL entregue (sem devolução): o cliente já recebeu com falta, então JÁ sabe os itens/valor. Aqui a oc=33 é o handoff final pro Ressarcimento e exige as **3 informações: romaneio + descrição dos itens + valor dos itens**.

Combo 33+44 (OPERACIONAL) precisa TODAS as condições:
- (i) Operadora pediu romaneio OU mencionou "ressarcimento" / "análise de perdas" / "indenização" / devolução no email
- (ii) Cliente autorizou devolução (texto explícito OU envio do romaneio anexo confirma autorização)
- (iii) **NÃO é extravio total** (se for, vira oc33_solo — não há volume pra devolver)
- (iv) Cliente enviou o **romaneio assinado** (anexo OU corpo). Descrição/valor NÃO são exigidos aqui — virão depois da devolução.

**REGRA DE COMPLETUDE (Caio 2026-06-24 NF 148558; refinada 2026-07-01 NF 66193):** se a operadora pediu decisão (devolver x reentregar) E o cliente só disser "pode devolver" SEM mandar o romaneio:
- NÃO marque sugere_combo_33_44 (o combo precisa do romaneio anexado).
- oc_sugerida = 44 se autorizou devolução, OU 54 se nem isso ficou claro.
- pendencias_resposta_cliente lista o que falta, ex: "Cliente autorizou devolução mas não enviou o romaneio assinado — ainda falta pra abrir o ressarcimento (oc=33)".

oc=33 solo precisa:
- (i) Email da operadora indica extravio total
- (ii) Cliente forneceu romaneio OU autorizou prosseguir

**Caso âncora combo (Caso 2)**: Operadora notifica extravio parcial + pergunta seguir/devolver + pede romaneio. Cliente responde "podem devolver" + anexa romaneio → combo 33+44 (SÓ romaneio; descrição/valor virão após a devolução).

**Caso âncora incompleto (NF 148558)**: Cliente responde só "pode devolver", SEM romaneio, e o contexto NÃO é extravio parcial → oc_sugerida=44, sugere_combo_33_44=false, pendencias listando o romaneio faltante. **SE for extravio parcial, use o combo 44+59 abaixo.**

**Combo 44+59 — EXTRAVIO PARCIAL + devolução autorizada + romaneio AINDA não veio (Caio 2026-07-15, separação 54/59):** é um contexto DIFERENTE do combo 33+44 — NÃO confunda os dois. Marque **sugere_combo_44_59=true e oc_sugerida=44** quando TODAS: (i) contexto_extravio_parcial=true (houve extravio de PARTE dos volumes — alguns ficaram, outros se perderam); (ii) o cliente AUTORIZOU a devolução do que ficou conosco; (iii) o cliente NÃO enviou o romaneio/descrição nesta resposta (evidencias_recebidas SEM romaneio). Significado: devolve os volumes que permaneceram (oc 44) E abre a indenização (oc 59) mandando e-mail que PEDE o romaneio + descrição + valor dos volumes EXTRAVIADOS.
- Diferença CRÍTICA vs combo 33+44: o 33+44 exige o romaneio JÁ ANEXADO (cliente mandou). O 44+59 é o OPOSTO — o romaneio ainda FALTA e o e-mail vai pedir. São contextos completamente diferentes e NUNCA coexistem.

**Caso âncora oc33_solo**: assunto "EXTRAVIO TOTAL NF 607458" + Cliente responde com romaneio → oc=33 solo. NUNCA combo (não há devolução possível).

NUNCA marcar mais de um entre sugere_combo_33_44, sugere_oc33_solo e sugere_combo_44_59 ao mesmo tempo — os TRÊS são mutuamente exclusivos: romaneio JÁ anexado = 33+44; extravio TOTAL = 33 solo; extravio PARCIAL + devolução + romaneio ausente = 44+59.

(c2) **CONTEXTO DE EXTRAVIO PARCIAL + evidências (Caio 2026-07-01, NF 66193)** — preencha SEMPRE:
- **contexto_extravio_parcial**: true quando o e-mail da operadora é uma tratativa de **extravio parcial** que pede ao cliente romaneio + descrição dos itens + valor dos itens pra abrir o ressarcimento (oc=33). false caso contrário (recusa comum, reentrega, extravio total, etc). É o gatilho pra rastrear as 3 evidências.
- **evidencias_recebidas**: quais das 3 o cliente ENVIOU nesta resposta. Para cada uma que veio, informe a **fonte** ("corpo" se está escrita no texto do e-mail; "anexo" se veio num arquivo) e, quando fonte="corpo", copie **VERBATIM** (sem parafrasear, sem reformatar, sem resumir) o trecho exato do corpo do cliente em **trecho_verbatim**; quando fonte="anexo", informe o **anexo_filename** correspondente da lista de anexos. Regras:
  - **romaneio**: normalmente um anexo (PDF/imagem "romaneio"/"coleta"). Se o cliente escreveu no corpo que anexou/assinou, ainda assim marque presente com o anexo.
  - **descricao**: lista/descrição dos itens faltantes (ex: "item 1 paracetamol: 30 unidades"). Pode vir no corpo OU anexo/planilha.
  - **valor**: valor a indenizar dos itens (ex: "R$300,00"). Pode vir no corpo OU anexo.
  - Só marque uma evidência quando ela DE FATO está presente. Não invente. Se nada das 3 veio, omita evidencias_recebidas ou retorne objeto vazio.

(d) **Reentrega sem cobrança ao cliente** (Caio 2026-05-18) — marque cliente_autorizou_reentrega_sem_pagar=true somente quando AMBAS as condições forem atendidas:
- (i) Cliente autorizou reentrega de forma explícita (ex: "podem tentar de novo", "ok pode reentregar", "manda de novo", "pode reenviar")
- (ii) Cliente se nega de forma explícita a pagar a nova viagem (ex: "não vou pagar", "sem cobrar/custo", "vocês que erraram", "é responsabilidade de vocês", "essa viagem é por conta da transportadora")

Quando flag=true:
- oc_sugerida deve ser **21** (não 54, não combo, não 33)
- Preencha motivo_cliente_recusa_pagar com 1-2 frases avaliando se o argumento do cliente é razoável. Exemplos:
  - "Argumento procede: insucesso documentado como erro Sal (entrega no endereço errado / sem tentativa) — cliente justifica recusa de pagamento."
  - "Argumento procede parcialmente: cliente alega erro Sal mas evidência sugere ausência do destinatário; vale negociação."
  - "Argumento NÃO procede claramente: cliente recusou entrega legítima, recusa de pagamento parece tentativa de transferir custo."
- O Cockpit vai usar essa flag pra pré-marcar checkbox no modal "Cancelar reentrega automaticamente em 24h". O motivo da IA pode virar a descrição usada no cancelamento SSW.

NÃO marque essa flag quando: (1) cliente só pediu reentrega sem mencionar pagamento; (2) cliente reclama de custo mas não autoriza reentrega; (3) qualquer ambiguidade — prefere flag=false.

**Separação 54/59 (Caio 2026-07-13):** olhe a "Última oc registrada antes da resposta". Se for **59** (RETORNO INDENIZAÇÃO — já pedimos romaneio/descrição/valor), o card está no trilho de INDENIZAÇÃO: quando o cliente enviar o romaneio, a próxima é **33** (combo 33+44 ou 33 solo, conforme extravio total/parcial); se a resposta for inconclusiva, use **oc_sugerida=59** (re-aguardar cliente, NÃO 54). Tanto 54 quanto 59 são "aguardando cliente". Se a última oc for **54** (RETORNO TRATATIVA), siga as regras normais acima (21/44/55/56/54).

Retorne EXCLUSIVAMENTE um JSON válido neste schema:
{
  "oc_sugerida": 44 | 33 | 21 | 55 | 56 | 54 | 59,
  "confianca": 0.0 a 1.0,
  "motivo": "1-2 frases — português direto",
  "instrucao_reentrega_sugerida": "se oc_sugerida=21: até 250 chars com novo endereço/contato/horário do cliente. Senão omite.",
  "texto_56_sugerido": "se oc_sugerida=56: até 400 chars com a instrução pronta pra Operação (o que o cliente questionou + o que precisa ser verificado). Senão omite.",
  "pendencias_resposta_cliente": ["string ≤120 chars", ...] (array, vazio se sem pendências),
  "sugere_combo_33_44": true | false,
  "sugere_oc33_solo": true | false,
  "sugere_combo_44_59": true | false,
  "motivo_combo": "1 frase — por que combo 33+44, oc=33 solo OU combo 44+59 (só se UM dos três booleans é true; senão omite)",
  "cliente_autorizou_reentrega_sem_pagar": true | false,
  "motivo_cliente_recusa_pagar": "1-2 frases avaliando se o argumento do cliente procede (só preencha quando cliente_autorizou_reentrega_sem_pagar=true; senão omite)",
  "contexto_extravio_parcial": true | false,
  "evidencias_recebidas": {
    "romaneio": { "fonte": "corpo" | "anexo", "anexo_filename": "nome do arquivo (se fonte=anexo)", "trecho_verbatim": "trecho exato do corpo, ≤200 chars (se fonte=corpo)" },
    "descricao": { "fonte": "corpo" | "anexo", "anexo_filename": "...", "trecho_verbatim": "≤200 chars" },
    "valor": { "fonte": "corpo" | "anexo", "anexo_filename": "...", "trecho_verbatim": "≤200 chars" }
  }
}

LIMITES DE TAMANHO (o Cockpit corta o excedente — passar do limite só desperdiça
e corre risco de a resposta ser truncada no meio): "motivo" ≤500 chars,
"motivo_combo" ≤300, "motivo_cliente_recusa_pagar" ≤300,
"instrucao_reentrega_sugerida" ≤250, "texto_56_sugerido" ≤400, cada pendência ≤120 (máx. 3),
cada "trecho_verbatim" ≤200. Sem quebra de linha dentro dos textos.
(em evidencias_recebidas inclua SÓ as chaves das evidências realmente enviadas nesta resposta; omita as ausentes. trecho_verbatim é cópia LITERAL do corpo — nunca reescreva.)

Regras:
- Confiança alta (≥0.8) só com cliente explícito.
- Confiança baixa (<0.5) → prefere oc=54 ou 56.
- Cliente reclama de algo novo → oc=56 ou 54.
- NÃO inventa outras ocs.
- **Resposta institucional / auto-reply / setor errado** (Caio 2026-05-19, NF 2305441): se o corpo do email contém marcadores típicos de redirecionamento automatizado — "atenção:", "este e-mail é destinado exclusivamente", "redirecione para [outro endereço]", "encaminhe para o setor X", "não tratamos este assunto aqui", "pendencialog/coletareversa/frete/fatpedidos não responde [tipo]", auto-assinaturas com listagem de outros emails da empresa — **a resposta NÃO é uma decisão clara do cliente pagador**. Mesmo que haja palavras como "NFD" ou "devolução" no corpo, trate como inconclusivo. → oc_sugerida=54, confianca≤0.5, pendencias_resposta_cliente inclui "Resposta veio com auto-reply / outro setor — cliente não respondeu diretamente".
- Português direto, sem ornamentação.
- Pendências: só do que a operadora REALMENTE pediu no email. Não inventa.
- Se IA não tem o email da operadora (campo ausente), pendencias = [] e sugere_combo_33_44 = false (não dá pra inferir).
## APRENDIZADOS DA GESTÃO (inseridos pelo Loop de Aprendizado — PR automática; não editar à mão)
<!-- INICIO-APRENDIZADOS-GESTAO -->
<!-- FIM-APRENDIZADOS-GESTAO -->

- **Nome da operadora**: NUNCA invente um nome (ex: "Larissa", "Duilio"). Se precisar referenciar a pessoa, use o nome real do campo OPERADORA no contexto, ou termos neutros ("a operadora", "Sal Express"). Cada card tem uma operadora diferente — citar nome errado é erro grave.`;

interface InputBody {
  card_id?: string;
  message_id?: string;
}

interface EvidenciaLlm {
  fonte?: "corpo" | "anexo";
  anexo_filename?: string;
  trecho_verbatim?: string;
}

interface IaSugestao {
  oc_sugerida: number;
  confianca: number;
  motivo: string;
  instrucao_reentrega_sugerida?: string;
  texto_56_sugerido?: string;
  pendencias_resposta_cliente?: string[];
  sugere_combo_33_44?: boolean;
  sugere_oc33_solo?: boolean;
  /** Caio 2026-07-15: extravio PARCIAL + devolução autorizada + romaneio AINDA não veio → combo 44 (devolver o que ficou) + 59 (indenização, e-mail pede romaneio/descrição/valor). Contexto OPOSTO ao 33+44 (que exige romaneio já anexado). */
  sugere_combo_44_59?: boolean;
  motivo_combo?: string;
  /** Caio 2026-05-18: cliente autorizou reentrega mas se nega a pagar. */
  cliente_autorizou_reentrega_sem_pagar?: boolean;
  /** Avaliação IA se o argumento do cliente procede. Só preenchido quando flag acima = true. */
  motivo_cliente_recusa_pagar?: string;
  /** Caio 2026-07-01 (NF 66193): e-mail da operadora é tratativa de extravio parcial (pede as 3 infos)? */
  contexto_extravio_parcial?: boolean;
  /** Quais das 3 evidências (romaneio/descrição/valor) o cliente enviou nesta resposta. */
  evidencias_recebidas?: {
    romaneio?: EvidenciaLlm;
    descricao?: EvidenciaLlm;
    valor?: EvidenciaLlm;
  };
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  try {
    const env = Deno.env.toObject();
    const supabase = createClient(
      env["SUPABASE_URL"]!,
      env["SUPABASE_SERVICE_ROLE_KEY"]!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const anthropic = createAnthropicClient({
      env: readAnthropicEnvFromProcess(env),
      onUsage: makeUsageRecorder(supabase, {
        functionName: "interpretador-resposta-cliente",
        agentName: "interpretador-resposta-cliente",
      }),
    });

    const body = await req.json().catch(() => null) as InputBody | null;
    if (!body?.card_id || !body?.message_id) {
      return json({ ok: false, error: "card_id e message_id obrigatórios" }, 400);
    }

    const { data: card } = await supabase
      .from("cards")
      .select("id, nf, empresa_cliente, cod_ultima_ocorrencia, agent_state, responsavel_relacionamento, historico_ssw")
      .eq("id", body.card_id)
      .maybeSingle();
    if (!card) return json({ ok: false, error: "card não encontrado" }, 404);

    const { data: msg } = await supabase
      .from("messages_inbox")
      // HOTFIX (Caio 2026-07-01): messages_inbox NÃO tem colunas gmail_message_id/
      // gmail_thread_id — elas vivem em raw_payload (jsonb). O select antigo dessas
      // colunas ERRAVA pra TODO card (coluna inexistente → msg null → 404).
      // gmail_message_id/thread/operador_id são guardados no dossiê p/ RE-BUSCAR o
      // romaneio do e-mail depois (o binário no bucket é apagado pós-envio; a fonte
      // durável é o próprio e-mail, da caixa do operador que recebeu o inbound).
      .select("conteudo, remetente, recebido_em, raw_payload")
      .eq("id", body.message_id)
      .maybeSingle();
    if (!msg) return json({ ok: false, error: "message não encontrada" }, 404);

    const rawPayload = (msg.raw_payload ?? {}) as Record<string, unknown>;
    const gmailMessageId = (rawPayload["gmail_message_id"] as string | null) ?? null;
    const gmailThreadId = (rawPayload["gmail_thread_id"] as string | null) ?? null;
    const operadorIdInbound = (rawPayload["operador_id"] as string | null) ?? null;

    const conteudo = (msg.conteudo as string | null) ?? "";
    if (!conteudo.trim()) {
      return json({ ok: false, error: "mensagem sem conteúdo" }, 400);
    }

    // Caio 2026-05-12: carrega último email outbound da operadora pra contexto.
    const { data: ultimoOutbound } = await supabase
      .from("cards_emails_outbound")
      .select("corpo_renderizado, subject, sent_at")
      .eq("card_id", body.card_id)
      .lt("sent_at", msg.recebido_em as string)
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const emailOperadora = (ultimoOutbound as { corpo_renderizado?: string | null } | null)?.corpo_renderizado ?? "";
    const operadoraNome = (card.responsavel_relacionamento as string | null) ?? "a operadora";

    // Anexos inbound dessa mensagem
    const { data: anexosRaw } = await supabase
      .from("email_anexos")
      .select("filename, mime_type, size_bytes")
      .eq("message_inbox_id", body.message_id)
      .eq("origem", "inbound");
    const anexos = (anexosRaw ?? []) as Array<{ filename: string; mime_type: string; size_bytes: number }>;
    const anexosDescritos = anexos.length === 0
      ? "(nenhum anexo)"
      : anexos.map((a) => `- ${a.filename} (${a.mime_type}, ${Math.round(a.size_bytes / 1024)}KB)`).join("\n");

    const agentState = (card.agent_state ?? {}) as Record<string, unknown>;
    const userPrompt = [
      `OPERADORA: ${operadoraNome}`,
      `Cliente: ${card.empresa_cliente ?? "?"}`,
      `NF: ${card.nf ?? "?"}`,
      `Última oc registrada antes da resposta: ${card.cod_ultima_ocorrencia ?? "?"}`,
      `Contexto da NF: ${(agentState["instrucao_ultima_ocorrencia"] as string | null) ?? "(sem contexto)"}`,
      "",
      `EMAIL DA OPERADORA (${operadoraNome}, pré-resposta):`,
      "---",
      emailOperadora ? emailOperadora.slice(0, 2000) : "(email da operadora não disponível — sem contexto pré-resposta)",
      "---",
      "",
      "TEXTO DA RESPOSTA DO CLIENTE:",
      "---",
      conteudo.slice(0, 3000),
      "---",
      "",
      "ANEXOS ENVIADOS PELO CLIENTE:",
      anexosDescritos,
      "",
      "Decida oc + pendências + combo 33+44. Responda só JSON.",
    ].join("\n");

    // Quantas vezes o LLM já falhou NESTA mensagem? (INV-055) Sem essa conta,
    // cada falha voltava pela fila de pendentes a cada 5 min pra sempre —
    // 137 falhas no mesmo card em 10h no domingo 26/07.
    //
    // O marcador `InterpretadorFalhasZeradas` reabre o crédito de tentativas:
    // é o que o retroativo usa pra dizer "as falhas velhas foram do bug do
    // teto, tenta de novo de verdade" — sem ele, os cards do incidente
    // cairiam direto no determinístico e nunca ganhariam leitura real.
    const { data: resetRow } = await supabase
      .from("card_events")
      .select("created_at")
      .eq("card_id", body.card_id)
      .eq("event_type", "InterpretadorFalhasZeradas")
      .eq("payload->>message_id", body.message_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    let queryFalhas = supabase
      .from("card_events")
      .select("id", { count: "exact", head: true })
      .eq("card_id", body.card_id)
      .eq("event_type", "InterpretadorRespostaClienteFalhou")
      .eq("payload->>message_id", body.message_id);
    const resetEm = (resetRow as { created_at?: string } | null)?.created_at ?? null;
    if (resetEm) queryFalhas = queryFalhas.gt("created_at", resetEm);
    const { count: falhasAnteriores } = await queryFalhas;

    let sugestao: IaSugestao;
    let leituraParcial = false;
    let leituraDegradada = false;

    if (deveDesistirDoLlm(falhasAnteriores ?? 0)) {
      // Passo 4 da rede de segurança: o card SEGUE com sugestão + ações
      // (conservadoras) em vez de ficar órfão. Nada de LLM aqui.
      sugestao = montarSugestaoDegradada(card.cod_ultima_ocorrencia as number | null) as IaSugestao;
      leituraDegradada = true;
      await supabase.from("card_events").insert({
        card_id: body.card_id,
        event_type: "InterpretadorRespostaClienteDegradado",
        actor_type: "agent",
        actor_id: "interpretador-resposta-cliente",
        payload: {
          message_id: body.message_id,
          falhas_anteriores: falhasAnteriores ?? 0,
          motivo: "limite de tentativas do LLM atingido — sugestão determinística aplicada",
        },
      });
    } else {
      try {
        sugestao = await anthropic.completeJson<IaSugestao>({
          model: MODEL,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userPrompt }],
          // Teto compatível com o schema (evidencias_recebidas traz 3 trechos
          // verbatim + motivos). 700 cortava respostas legítimas de extravio
          // no meio — raiz do incidente 26/07.
          maxTokens: 1800,
          temperature: 0.2,
          meta: { cardId: body.card_id, messageId: body.message_id },
          onJsonReparado: () => {
            leituraParcial = true;
          },
        });
        if (leituraParcial) sugestao = degradarLeituraParcial(sugestao);
      } catch (err) {
        const msgErr = err instanceof Error ? err.message : String(err);
        console.error("interpretador IA falhou:", msgErr);
        await supabase.from("card_events").insert({
          card_id: body.card_id,
          event_type: "InterpretadorRespostaClienteFalhou",
          actor_type: "agent",
          actor_id: "interpretador-resposta-cliente",
          payload: { message_id: body.message_id, motivo: msgErr },
        });
        // Ainda há tentativas: deixa a fila reprocessar (o modelo pode acertar
        // na próxima). Na última, o ramo degradado acima assume e encerra.
        return json({ ok: false, error: msgErr }, 200);
      }
    }

    const ocsValidas = new Set([21, 33, 44, 54, 55, 56, 59]);
    if (!ocsValidas.has(sugestao.oc_sugerida)) {
      return json({ ok: false, error: `oc_sugerida ${sugestao.oc_sugerida} fora da lista válida` }, 200);
    }
    const confianca = Math.max(0, Math.min(1, Number(sugestao.confianca) || 0));

    // Normaliza output
    const instrucaoReentrega =
      sugestao.oc_sugerida === 21 && typeof sugestao.instrucao_reentrega_sugerida === "string"
        ? sugestao.instrucao_reentrega_sugerida.slice(0, 250).trim()
        : "";

    // Etapa C do plano de veto (Caio 25/08): o agente SABE o que falta —
    // escreve o texto da instrução da 56 (vai pro SSW; operadora edita no painel).
    const texto56Sugerido =
      sugestao.oc_sugerida === 56 && typeof sugestao.texto_56_sugerido === "string"
        ? sugestao.texto_56_sugerido.slice(0, 400).trim()
        : "";

    const pendencias = Array.isArray(sugestao.pendencias_resposta_cliente)
      ? sugestao.pendencias_resposta_cliente
          .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
          .map((p) => p.slice(0, 120).trim())
          .slice(0, 3)
      : [];

    // Caio 2026-05-12: combo e oc33_solo são mutuamente exclusivos.
    // Se IA marcar os dois, dá preferência ao oc33_solo (extravio total —
    // mais conservador, evita lançar oc=44 num caso onde não há volume).
    // Caio 2026-07-15: exclusão mútua determinística dos 3 combos de indenização
    // (33+44 = romaneio já anexado; oc33 solo = extravio total; 44+59 = extravio
    // parcial + devolução + romaneio AINDA não veio). O romaneio é o desempate
    // semântico. Autoridade em _shared/exclusao-combos.ts (testada).
    const combosResolvidos = resolverExclusaoCombos({
      sugere_combo_33_44: sugestao.sugere_combo_33_44 === true,
      sugere_oc33_solo: sugestao.sugere_oc33_solo === true,
      sugere_combo_44_59: sugestao.sugere_combo_44_59 === true,
      romaneio_veio: !!sugestao.evidencias_recebidas?.romaneio,
    });
    const sugereCombo = combosResolvidos.combo3344;
    const sugereOc33Solo = combosResolvidos.oc33Solo;
    const sugereCombo4459 = combosResolvidos.combo4459;

    const motivoCombo =
      (sugereCombo || sugereOc33Solo || sugereCombo4459) && typeof sugestao.motivo_combo === "string"
        ? sugestao.motivo_combo.slice(0, 300).trim()
        : "";

    const semPagar = sugestao.cliente_autorizou_reentrega_sem_pagar === true;
    const motivoRecusaPagar =
      semPagar && typeof sugestao.motivo_cliente_recusa_pagar === "string"
        ? sugestao.motivo_cliente_recusa_pagar.slice(0, 300).trim()
        : "";

    // INV-017 (Caio 2026-06-23, NF 16480): a sugestão não pode contradizer as
    // próprias pendências. oc=21 (reentrega CONFIRMADA) + pendência aberta →
    // rebaixa pra 54 deterministicamente (independe de o prompt acertar).
    const recon = reconciliarSugestaoInterpretador({
      oc_sugerida: sugestao.oc_sugerida,
      confianca,
      instrucao_reentrega_sugerida: instrucaoReentrega,
      pendencias_resposta_cliente: pendencias,
      cliente_autorizou_reentrega_sem_pagar: semPagar,
    });
    const rebaixou = recon.rebaixou_oc21_por_pendencia;

    // Quando rebaixa, deixa o motivo explícito pro operador (o banner passa a
    // mostrar oc=54). A decisão crua da IA fica preservada no card_event abaixo.
    const motivoIa = sugestao.motivo.slice(0, 500);
    const motivoFinal = rebaixou
      ? `Cliente ainda não confirmou os dados da reentrega (ver pendências) — manter aguardando e responder cobrando antes de lançar oc 21. [IA havia sugerido oc 21]`
      : motivoIa;

    // Caio 2026-07-13 (separação 54/59): card no trilho INDENIZAÇÃO (oc-âncora 59) —
    // o "re-aguardar / inconclusivo" relança 59 (não 54). Determinístico, independe
    // do prompt. Demais sugestões (33/44/21/55/56) passam intactas.
    let ocSugeridaTrilho =
      recon.sugestao.oc_sugerida === 54 && card.cod_ultima_ocorrencia === 59
        ? 59
        : recon.sugestao.oc_sugerida;

    // R2 ANTI-VETO (playbook 02/09; âncoras NFs 898554/919288): cliente PEDE a
    // ressalva e ela JÁ EXISTE → RESPONDER (54), nunca pedir de novo (56).
    // Determinístico, pós-LLM (mesmo padrão do INV-017 e da separação 54/59).
    // - foto transcrita (IA Vision) → 54 normal (elegível ao veto);
    // - só texto "NÃO ASSINOU/RECUSOU ASSINAR" → 54 SEMPRE MANUAL (Caio 02/09):
    //   guard abaixo impede a armação da janela + banner avisa "sem imagem".
    let ressalvaResolvida: ReturnType<typeof resolverRessalvaExistente> = null;
    if (ocSugeridaTrilho === 56 && detectarPedidoDeRessalva(conteudo)) {
      const avisoOc = ((card.agent_state ?? {}) as Record<string, unknown>)["aviso_alteracao_oc"] as
        | { tem_ressalva?: boolean; ressalva_texto?: string | null }
        | undefined;
      const historicoCard = Array.isArray(card.historico_ssw)
        ? (card.historico_ssw as Array<{ codigo?: number | null; instrucao?: string | null }>).map((o) => ({
          codigo: typeof o.codigo === "number" ? o.codigo : Number(o.codigo) || null,
          instrucao: o.instrucao ?? null,
        }))
        : [];
      ressalvaResolvida = resolverRessalvaExistente({
        historico: historicoCard,
        temRessalvaFoto: avisoOc?.tem_ressalva === true,
        ressalvaTexto: avisoOc?.ressalva_texto ?? null,
      });
      if (ressalvaResolvida) {
        ocSugeridaTrilho = 54;
      }
    }

    // R2: motivo didático quando a ressalva foi resolvida (o banner conta a
    // história; o operador vê o texto sem abrir a foto).
    const motivoComRessalva = ressalvaResolvida
      ? (ressalvaResolvida.tipo === "foto_transcrita"
        ? `Cliente pede a ressalva — ela JÁ EXISTE (oc ${ressalvaResolvida.oc_origem}, transcrita da foto): ` +
          `"${ressalvaResolvida.texto.slice(0, 200)}". Responder com 54 enviando a ressalva ao cliente — não pedir de novo à Operação.`
        : `Cliente pede a ressalva/comprovante — SEM IMAGEM: só o texto da oc ${ressalvaResolvida.oc_origem} ` +
          `("${ressalvaResolvida.texto.slice(0, 160)}"). Sugerir 54 + e-mail COM VALIDAÇÃO DO OPERADOR ` +
          `(regra Caio 02/09: casos tipo CLIENTE NÃO ASSINOU — avisar o cliente com o texto, deixando claro que não há foto).`)
      : null;

    const sugestaoFull = {
      oc_sugerida: ocSugeridaTrilho,
      confianca: recon.sugestao.confianca,
      motivo: motivoComRessalva ?? motivoFinal,
      sugerido_em: new Date().toISOString(),
      message_id: body.message_id,
      instrucao_reentrega_sugerida: recon.sugestao.instrucao_reentrega_sugerida,
      texto_56_sugerido: texto56Sugerido,
      pendencias_resposta_cliente: pendencias,
      sugere_combo_33_44: sugereCombo,
      sugere_oc33_solo: sugereOc33Solo,
      sugere_combo_44_59: sugereCombo4459,
      motivo_combo: motivoCombo,
      cliente_autorizou_reentrega_sem_pagar: semPagar,
      motivo_cliente_recusa_pagar: motivoRecusaPagar,
      // Marca de auditoria pro front/eval saberem que houve rebaixamento.
      rebaixado_de_oc21_por_pendencia: rebaixou,
      // R2 anti-veto (playbook 02/09): 56→54 porque a ressalva pedida já existe.
      // tipo 'texto_sem_assinatura' = SEM imagem → nunca arma janela de veto.
      ressalva_resolvida: ressalvaResolvida,
      // INV-055: a leitura NÃO foi completa. O card tem sugestão e ações, mas
      // pede olho humano — `parcial` = JSON remendado, `degradada` = sem LLM.
      leitura_parcial: leituraParcial,
      leitura_degradada: leituraDegradada,
    };

    await supabase
      .from("cards")
      .update({ ia_sugestao_oc_resposta: sugestaoFull })
      .eq("id", body.card_id);

    // Etapa 2 da padronização oc 11 (Isadora 07/08; Caio 08/08): decisão final
    // 21 num card do fluxo-endereço → o todo de 21 ganha texto pro SSW +
    // cancelamento da reentrega. Best-effort: a sugestão já está persistida;
    // o outro call site (propostas-pos-resposta) cobre a ordem inversa.
    try {
      await aplicarPacoteOc11PosResposta(supabase, body.card_id, "interpretador-resposta-cliente");
    } catch (e) {
      console.warn(`pacote oc11 pós-resposta falhou (card ${body.card_id}): ${e instanceof Error ? e.message : e}`);
    }

    // Enxerto da instrução do E-MAIL na proposta 21 ativa (Caio 2026-08-14,
    // NF 674757 Würth): decisão final 21 + instrucao_reentrega_sugerida →
    // args.descricao do todo 21 ganha os dados do e-mail (senão o quick-approve
    // da ⭐ RECOMENDADA lança o texto velho — a oc 21 não abre painel de input).
    // Best-effort; o outro call site (propostas-pos-resposta) cobre a ordem
    // inversa (todos criados depois da decisão).
    try {
      await aplicarInstrucaoEmailNaProposta21(supabase, body.card_id, "interpretador-resposta-cliente");
    } catch (e) {
      console.warn(`enxerto e-mail→21 falhou (card ${body.card_id}): ${e instanceof Error ? e.message : e}`);
    }

    // Etapa C do plano de veto (Caio 25/08): decisão 56 → o texto gerado pela
    // IA vai pro todo 56 (SSW + prefill do painel). Best-effort; o outro call
    // site cobre a ordem inversa.
    await aplicarTexto56NaProposta(supabase, body.card_id, "interpretador-resposta-cliente");

    // Etapa C (onda 2, 25/08): o agente pré-seleciona os anexos da oc 33
    // (dossiê aponta o romaneio) — o card mostra o que será anexado.
    await aplicarAnexosSugeridos33(supabase, body.card_id, "interpretador-resposta-cliente");

    // Etapa B do plano de veto (Caio 25/08): resolve e PERSISTE a ação
    // destacada EXATA (acao_key + todo_id) — o front lê o campo; a heurística
    // de clique vira fallback. Depois dos enxertos (o todo 21 pode ter mudado).
    // Best-effort; propostas-pos-resposta cobre a ordem inversa.
    const destaqueVeto = await gravarDestaqueRespostaCliente(
      supabase, body.card_id, "interpretador-resposta-cliente",
    );

    // Etapa D (25/08): destaque exato resolvido → tenta AGENDAR a ação
    // autônoma com janela de veto (inclui o 'aguardar'). Todas as cercas +
    // flag master + degrau da escada decidem; inelegível = fluxo de hoje.
    // R2 anti-veto (Caio 02/09): ressalva resolvida SÓ POR TEXTO (sem imagem)
    // = validação do operador OBRIGATÓRIA — nunca arma a janela de veto.
    const vetoBloqueadoPorRessalvaSemImagem =
      ressalvaResolvida?.tipo === "texto_sem_assinatura";
    if (destaqueVeto?.acao_key && !vetoBloqueadoPorRessalvaSemImagem) {
      await agendarAcaoAutonomaSeElegivel(supabase, {
        cardId: body.card_id,
        agentName: "interpretador-resposta-cliente",
        acaoKey: destaqueVeto.acao_key,
        ocCard: card.cod_ultima_ocorrencia ?? null,
        ocSugerida: ocSugeridaTrilho ?? null,
        confianca: recon.sugestao.confianca ?? null,
      });
    }

    // ── Devolução ao terminal (Caio 27/08, NF 660746) ───────────────────────
    // Card TERMINAL reaberto pela resposta + leitura "nada a fazer" → volta
    // sozinho pro estado anterior (resposta anexada, leitura registrada,
    // todos da reabertura cancelados, veto desarmado). Best-effort.
    try {
      await devolverAoTerminalSeSemAcao(supabase as ReturnType<typeof createClient>, body.card_id, {
        oc_sugerida: ocSugeridaTrilho ?? null,
        pendencias,
        sugere_oc33_solo: sugereOc33Solo,
        sugere_combo_33_44: sugereCombo,
        sugere_combo_44_59: sugereCombo4459,
        leitura_parcial: leituraParcial,
        leitura_degradada: leituraDegradada,
        tipo_destaque: (destaqueVeto?.acao_key ?? "").startsWith("ignorar_e_aguardar") ? "aguardar" : null,
      });
    } catch (e) {
      console.warn(`devolução ao terminal falhou (card ${body.card_id}): ${e instanceof Error ? e.message : e}`);
    }

    // ── Dossiê de extravio parcial (Caio 2026-07-01, NF 66193) ──────────────
    // Rastreia as 3 evidências (romaneio + descrição + valor) que chegam
    // fatiadas ao longo das respostas. Atrás da flag master (shadow-first): só
    // popula quando o contexto é extravio parcial. O GATE que bloqueia a oc 33
    // de completude lê este dossiê (mas só ENFORCE com a 2ª flag).
    // Blocker 1 (Codex): processa o dossiê quando o LLM marcou o contexto OU o
    // card JÁ tem dossiê (reabertura Caso 2 — o LLM pode esquecer a flag numa
    // resposta curta de descrição/valor).
    if (deveProcessarDossie(sugestao.contexto_extravio_parcial, lerExtravioParcial(card) !== null)) {
      const { data: flagDossie } = await supabase
        .from("feature_flags")
        .select("enabled")
        .eq("key", "extravio_parcial_dossie_enabled")
        .maybeSingle();
      if ((flagDossie as { enabled?: boolean } | null)?.enabled === true) {
        const recebidas = montarEvidenciasRecebidas(
          sugestao.evidencias_recebidas,
          anexos,
          conteudo, // corpo original — valida trecho_verbatim (nada inventado entra no dossiê)
          {
            message_inbox_id: body.message_id,
            gmail_message_id: gmailMessageId,
            gmail_thread_id: gmailThreadId,
            operador_id: operadorIdInbound, // caixa Gmail p/ re-buscar o romaneio (Fase 2)
            visto_em: new Date().toISOString(),
          },
        );
        const estadoAtual = lerExtravioParcial(card);
        const dossieAntes = estadoAtual?.dossie ?? dossieVazio();

        // Seed HISTÓRICO do romaneio (Codex 2026-07-02, NF 575330): evidência
        // anterior ao nascimento do dossiê — romaneio já recebido num e-mail
        // ANTERIOR (email_anexos) ou já aceito pelo Ressarcimento (oc 33 + oc 49
        // pedindo só descrição/valor) — não pode virar falso "faltando romaneio".
        // Determinístico (nunca via LLM), SÓ romaneio, SÓ enquanto ausente
        // (monotônico). Carrega metadados p/ re-busca (emenda 2 Codex).
        let seedRomaneio: EvidenciasRecebidas = {};
        if (dossieAntes.romaneio?.presente !== true) {
          const { data: anexosCard } = await supabase
            .from("email_anexos")
            .select("message_inbox_id, filename, mime_type, size_bytes, origem")
            .eq("card_id", body.card_id)
            .eq("origem", "inbound");
          const anexosHist = (anexosCard ?? []) as AnexoHistorico[];
          const inboxIds = [
            ...new Set(anexosHist.map((a) => a.message_inbox_id).filter((x): x is string => !!x)),
          ];
          let mensagensHist: MensagemHistorico[] = [];
          if (inboxIds.length > 0) {
            const { data: msgsHist } = await supabase
              .from("messages_inbox")
              .select("id, conteudo, remetente, raw_payload, recebido_em")
              .in("id", inboxIds);
            mensagensHist = ((msgsHist ?? []) as Array<Record<string, unknown>>).map((mm) => {
              const rp = (mm.raw_payload ?? {}) as Record<string, unknown>;
              return {
                message_inbox_id: mm.id as string,
                conteudo: (mm.conteudo as string | null) ?? null,
                remetente: (mm.remetente as string | null) ?? null,
                gmail_message_id: (rp["gmail_message_id"] as string | null) ?? null,
                gmail_thread_id: (rp["gmail_thread_id"] as string | null) ?? null,
                operador_id: (rp["operador_id"] as string | null) ?? null,
                recebido_em: (mm.recebido_em as string | null) ?? null,
              };
            });
          }
          const historicoSsw = (card.historico_ssw ?? []) as OcHistSsw[];
          seedRomaneio = montarSeedRomaneio(anexosHist, mensagensHist, historicoSsw);
        }
        const seedRomaneioFonte = seedRomaneio.romaneio ? (seedRomaneio.romaneio.fonte ?? "anexo") : null;
        const dossieDepois = mergeEvidencia(mergeEvidencia(dossieAntes, seedRomaneio), recebidas);
        const av = avaliarDossie(dossieDepois);
        // Caso 2 (devolução) quando a resposta é o combo operacional; senão
        // Caso 1 (entregue com falta, sem devolução).
        const caso: "1" | "2" = estadoAtual?.caso ?? ((sugereCombo || sugereCombo4459) ? "2" : "1");
        const agentStateNovo = {
          ...((card.agent_state ?? {}) as Record<string, unknown>),
          extravio_parcial: {
            caso,
            fase: av.completo ? "completo" : "coletando",
            dossie: dossieDepois,
          },
        };
        await supabase.from("cards").update({ agent_state: agentStateNovo }).eq("id", body.card_id);
        await supabase.from("card_events").insert({
          card_id: body.card_id,
          event_type: "DossieExtravioAtualizado",
          actor_type: "agent",
          actor_id: "interpretador-resposta-cliente",
          payload: {
            message_id: body.message_id,
            caso,
            completo: av.completo,
            faltando: av.faltando,
            evidencias_recebidas_nesta_resposta: Object.keys(recebidas),
            // Codex 2026-07-02: fonte do romaneio semeado do histórico (null se
            // nenhum seed nesta passada) — "anexo" (Nível 1) | "ssw" (Nível 2).
            seed_romaneio: seedRomaneioFonte,
          },
        });

        // Blocker 4 (auditoria): REPATCH dos todos ativos de oc 33 do card com o
        // gate do dossiê ATUAL. Sem isso, propostas criadas ANTES do dossiê nascer
        // ficam sem meta.gate_oc33 e o front/banner fica cego. O executor já é
        // autoritativo, mas o shadow/aviso depende da anotação estar no todo.
        const { data: todosAtivos } = await supabase
          .from("todos")
          .select("id, proposta_payload")
          .eq("card_id", body.card_id)
          .in("status", ["pendente", "aprovado"]);
        for (const t of (todosAtivos ?? []) as Array<{ id: string; proposta_payload: Record<string, unknown> | null }>) {
          const pp = t.proposta_payload;
          if (!pp) continue;
          const natureza = classificarOc33(pp, caso);
          if (!natureza) continue;
          const g = decidirGateOc33(natureza, dossieDepois);
          const metaAtual = (pp["meta"] ?? {}) as Record<string, unknown>;
          const gateNovo = { natureza, bloqueada: g.bloqueada, faltando: g.faltando };
          const metaAntiga = metaAtual["gate_oc33"];
          // Só grava se mudou (evita UPDATE ruidoso a cada resposta).
          if (JSON.stringify(metaAntiga) === JSON.stringify(gateNovo)) continue;
          await supabase
            .from("todos")
            .update({ proposta_payload: { ...pp, meta: { ...metaAtual, gate_oc33: gateNovo } } })
            .eq("id", t.id);
        }
      }
    }

    await supabase.from("card_events").insert({
      card_id: body.card_id,
      event_type: "InterpretadorRespostaClienteConcluido",
      actor_type: "agent",
      actor_id: "interpretador-resposta-cliente",
      payload: { ...sugestaoFull, oc_sugerida_ia_crua: sugestao.oc_sugerida, motivo_ia_cru: motivoIa },
    });

    // INV-017: card_event dedicado quando o guard dispara (trilha de auditoria +
    // alimenta corpus pra entender quando o prompt erra a oc=21).
    if (rebaixou) {
      await supabase.from("card_events").insert({
        card_id: body.card_id,
        event_type: "SugestaoOc21RebaixadaPorPendencia",
        actor_type: "agent",
        actor_id: "interpretador-resposta-cliente",
        payload: {
          oc_sugerida_ia: recon.oc_original,
          oc_sugerida_final: 54,
          confianca_ia: confianca,
          pendencias: pendencias,
          message_id: body.message_id,
          motivo_ia_cru: motivoIa,
        },
      });
    }

    return json({ ok: true, ...sugestaoFull }, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("interpretador-resposta-cliente fatal:", msg);
    return json({ ok: false, error: msg }, 500);
  }
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}



/** Devolução ao terminal (Caio 27/08, NF 660746): ver _shared/resposta-sem-acao.ts. */
async function devolverAoTerminalSeSemAcao(
  supabase: ReturnType<typeof createClient>,
  cardId: string,
  leitura: LeituraPraDevolucao,
): Promise<void> {
  // 1. este acionamento veio de reabertura de TERMINAL? (evento dos últimos 30min)
  const { data: reaberturas } = await supabase
    .from("card_events")
    .select("created_at, payload")
    .eq("card_id", cardId)
    .eq("event_type", "RetornoClienteEmAguardo")
    .gte("created_at", new Date(Date.now() - 30 * 60 * 1000).toISOString())
    .order("created_at", { ascending: false })
    .limit(1);
  const reab = (reaberturas ?? [])[0] as { created_at: string; payload: { previous_state?: string } } | undefined;
  const previousState = reab?.payload?.previous_state ?? null;
  if (!reab || !previousState || !STATES_DEVOLVIVEIS.has(previousState)) return;

  // 2. última oc lançada COM SUCESSO pelo Cockpit (imune à defasagem do Bastão)
  const { data: ult } = await supabase
    .from("acoes_executadas_ssw")
    .select("codigo_oc")
    .eq("card_id", cardId)
    .eq("sucesso", true)
    .order("iniciado_em", { ascending: false })
    .limit(1)
    .maybeSingle();
  const ultimaOcCockpit = (ult as { codigo_oc?: number } | null)?.codigo_oc ?? null;

  if (!ehRespostaSemAcao(leitura, ultimaOcCockpit)) return;

  // 3. cancela os todos PENDENTES criados na reabertura (senão viram órfãos)
  const { data: todosNovos } = await supabase
    .from("todos")
    .select("id")
    .eq("card_id", cardId)
    .eq("status", "pendente")
    .gte("created_at", reab.created_at);
  const ids = ((todosNovos ?? []) as Array<{ id: string }>).map((t) => t.id);
  if (ids.length > 0) {
    await supabase.from("todos").update({ status: "cancelado" }).in("id", ids);
  }

  // 4. desarma veto que porventura tenha sido armado nesta rodada
  await supabase
    .from("acoes_agendadas")
    .update({ status: "cancelado", cancelado_motivo: "card devolvido ao terminal (resposta sem ação)", processed_at: new Date().toISOString() })
    .eq("card_id", cardId)
    .eq("tipo", "executar_acao_autonoma")
    .eq("status", "pendente");

  // 5. devolve o card ao estado anterior
  await supabase
    .from("cards")
    .update({ state: previousState, lock_aguardando_validacao: false })
    .eq("id", cardId);

  await supabase.from("card_events").insert({
    card_id: cardId,
    event_type: "CardDevolvidoAoTerminalSemAcao",
    actor_type: "system",
    actor_id: "interpretador-resposta-cliente",
    payload: {
      previous_state: previousState,
      oc_sugerida: leitura.oc_sugerida,
      ultima_oc_cockpit: ultimaOcCockpit,
      tipo_destaque: leitura.tipo_destaque ?? null,
      todos_cancelados: ids,
      motivo:
        "Caio 27/08 (NF 660746): resposta em card terminal reaberto não pede ação nenhuma — card volta ao estado anterior; a resposta e a leitura ficam registradas.",
    },
  });
  console.log(`[devolucao-terminal] card ${cardId} → ${previousState} (sem ação; ${ids.length} todos cancelados)`);
}

# Encaminhamento Gmail Larissa → Karoline (requisito Caio 2026-07-21)

**Objetivo:** as respostas dos clientes migrados (a threads que a Larissa já enviou pelo
Cockpit) devem cair **também na caixa Gmail da Karoline** — não só aparecer no card dentro
do Cockpit.

## ⚠️ Regra de ouro (senão quebra o Cockpit)
O poll do Cockpit lê a caixa da Larissa com a query `label:cockpit-tracked is:unread` e **só
depois** marca como lida (`gmail-poll-inbox` linhas 12/16). Portanto o filtro na caixa da
Larissa **DEVE ser forward-only**:

- ✅ **Encaminhar para** `karoline.eduarda@salexpress.com.br`
- ❌ **NÃO** marcar "Marcar como lida" / "Read"
- ❌ **NÃO** "Arquivar" / "Pular Caixa de Entrada" / "Skip Inbox"
- ❌ **NÃO** "Excluir"

Motivo: se marcar como lida antes do poll rodar, o poll pula (`is:unread`) e o Cockpit
**para de capturar** a resposta → o card da Karoline não atualiza. Forward-only preserva o
Cockpit **e** entrega a cópia na caixa da Karoline. A cópia encaminhada que chega na caixa da
Karoline **não** é reprocessada pelo poll dela (não tem o label `cockpit-tracked`), então não
duplica card.

## Pré-requisito (uma vez)
Na conta Gmail da Larissa (`relacionamento.farmaceutico@salexpress.com.br`):
**Configurações → Encaminhamento e POP/IMAP → Adicionar endereço de encaminhamento →**
`karoline.eduarda@salexpress.com.br`. O Gmail manda um código de confirmação pra caixa da
Karoline — confirmar. (Filtros só encaminham pra endereços verificados.)

## Filtro (Larissa → Criar filtro)
No campo **"De"** (From) cole exatamente:

```
from:(@acacia.med.br OR @alfalagos.com.br OR @ativahospitalar.com.br OR @cepalab.com.br OR @futuramedicamentos.com.br OR @hdlhospitalar.com.br OR @inovamedhospitalar.com OR @jpdiagnostica.com.br OR @lifenutri.com.br OR @medcentercomercial.com.br OR @multifarma.com.br OR @rioclarense.com.br OR @sameh.com.br OR @siriopharma.com.br OR @somahospitalar.com.br OR @unionlab.com.br)
```

→ **Criar filtro** → marcar **apenas** "Encaminhar para: `karoline.eduarda@salexpress.com.br`"
→ (opcional) "Aplicar também aos e-mails correspondentes" pra pegar respostas recentes.

## 16 domínios cobertos (dos 21 clientes migrados)
acacia.med.br · alfalagos.com.br · ativahospitalar.com.br · cepalab.com.br ·
futuramedicamentos.com.br · hdlhospitalar.com.br · inovamedhospitalar.com · jpdiagnostica.com.br ·
lifenutri.com.br · medcentercomercial.com.br · multifarma.com.br · rioclarense.com.br ·
sameh.com.br · siriopharma.com.br · somahospitalar.com.br · unionlab.com.br

> Nota: `jpdiagnostica.com.br` é o contato da CENTERVIDA; `lifenutri.com.br` cobre os 3 CNPJs
> LEONE. Se algum cliente responder de um domínio pessoal (gmail/hotmail) fora dessa lista, a
> resposta ainda aparece no **card** (via poll da Larissa) mas não é encaminhada — adicionar o
> domínio ao filtro se acontecer.

## O que NÃO precisa (já garantido pelo Cockpit)
- Aparecer no **card** da Karoline: já funciona pós-migração (match thread→card→dono).
- Karoline responder: quando ela responder pelo Cockpit uma thread da Larissa, o sistema já
  manda como thread nova da caixa dela (`responder-email-cliente:144-161`) e a partir daí as
  respostas vêm direto pra caixa da Karoline (poll dela captura).

## Guarda permanente
**NÃO desconectar a Gmail da Larissa** enquanto houver threads vivas desses clientes — o poll
dela é o que captura as respostas pro Cockpit. Vale mesmo se a Larissa for reduzida/sair.

# Remanejar cliente de operador — manual (Carlos autorizado)

Desde a mig 360, trocar um cliente de operador NÃO é mais migration: é uma
chamada da função canônica `remanejar_cliente_operador`, que executa a receita
completa das migs 288/301/333/359 (7 camadas + pós-checks) de forma atômica.
**Política** (docs/POLITICA_MIGRATIONS.md): remanejo VIA ESTA FUNÇÃO o Carlos
pode executar sozinho; remanejo à mão (UPDATE avulso) continua SÓ com o Caio.

## Antes de rodar (obrigatório)

1. **Trocar a espécie/responsável do cliente NO SSW primeiro.** O trigger que
   dá dono a card novo casa por NOME vindo do SSW e não olha a carteira — sem
   essa troca, cards novos voltam pro operador antigo (caso SULMEDIC 17-19/08).
2. Saber o CNPJ exato (14 dígitos) e o operador de destino (nome como está em
   `operadores.nome`, ex.: FELIPE).

## Como rodar

```bash
psql "$SUPABASE_DB_URL" -c "SELECT jsonb_pretty(public.remanejar_cliente_operador(
  p_cnpj             => '86368206000194',
  p_operador_destino => 'VICTOR',
  p_motivo           => 'Vinculado incorretamente na planilha; cliente e do segmento de cosmeticos',
  p_autorizado_por   => 'CARLOS'
));"
```

Opcionais:
- `p_segmento_codigo => '006', p_segmento_nome => 'DISTRIBUIDOR DE COSMETICOS'`
  — só quando o segmento do cliente também muda (os dois juntos).
- `p_cliente_novo_ok => true` — só se a função recusar por "CNPJ desconhecido"
  e você tiver CERTEZA de que não é erro de digitação.

## O que ela faz (tudo ou nada)

carteira (remove de todos + adiciona no destino) · contatos · tracking ·
**desarma ação autônoma armada** (dono novo não viu a proposta — devolve pro
humano com evento) · TODOS os cards (inclusive terminais) + `card_event`
`OperadorReatribuido` por card · alertas não lidos. Depois roda os 9
pós-checks da mig 359; qualquer falha = EXCEPTION = **reverte tudo sozinha**.

## Depois de rodar

- Conferir o relatório JSON (contatos/tracking/cards/veto_desarmado) e ler o
  campo `avisos`.
- Colar o relatório no canal/PR onde a troca foi pedida (trilha de quem
  autorizou fica também no `card_event` de cada card).
- Se aparecer `veto_desarmado > 0`: normal — a ação volta como sugestão
  comum pro operador novo decidir.

## O que NÃO fazer

- NUNCA reproduzir as camadas à mão (UPDATE direto em cards/operadores) — é
  exatamente o risco que esta função elimina, e é TIPO B (só Caio).
- Não rodar com dúvida no CNPJ: o guard recusa CNPJ desconhecido, mas um CNPJ
  VÁLIDO porém errado move um cliente real — confira antes.

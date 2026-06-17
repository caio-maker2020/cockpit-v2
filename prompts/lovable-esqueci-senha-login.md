# Lovable — "Esqueci minha senha" na tela de login

Adicionar um link **"Esqueci minha senha"** na tela de login. Ao clicar, abre um
campo pra digitar o e-mail; ao enviar, o sistema gera uma senha nova e envia por
e-mail pro endereço cadastrado do operador (o mesmo que ele usa pra acessar o
Cockpit). Depois é só logar com a senha que chegou.

Backend pronto: edge function pública `recuperar-senha-operador` (já deployada).

## Chamada (usuário NÃO está logado — usa a chave anon do client)
```js
const { data } = await supabase.functions.invoke('recuperar-senha-operador', {
  body: { email: emailDigitado.trim() }
});
// SEMPRE retorna data.ok === true com data.message genérica
// (por segurança, não revela se o e-mail existe ou não).
```

## UX
- Link discreto abaixo do botão de login: "Esqueci minha senha".
- Ao clicar: mostrar um campo de e-mail (ou um pequeno modal) + botão "Enviar
  nova senha".
- Após enviar, SEMPRE mostrar a mesma mensagem de sucesso (independente de o
  e-mail existir):
  "Se o e-mail estiver cadastrado, você receberá uma nova senha em instantes.
   Confira a caixa de entrada (e o spam)."
- Não mostrar erro de "e-mail não encontrado" (a resposta é genérica de propósito).
- Pode haver um pequeno atraso e um limite (1 envio a cada ~5 min por e-mail) —
  se a pessoa clicar de novo logo em seguida, a mensagem é a mesma; não precisa
  tratamento especial.

## Importante
- O e-mail com a nova senha chega no endereço cadastrado do operador (o login).
- Recomende no texto da tela que a pessoa troque a senha depois de entrar (não é
  obrigatório no MVP, mas é boa prática).

# Lovable — Painel admin (SÓ Caio): trocar login/senha de operadores

Criar uma área administrativa visível **apenas** para o login
`caio@salexpress.com.br`, que lista os operadores e permite trocar o **login
(e-mail)** e/ou a **senha** de qualquer um. (Para operador sem login ainda, o
mesmo formulário cria o acesso informando e-mail + senha.)

Backend pronto: edge function `admin-operadores` (já deployada). A AUTORIZAÇÃO
real é no backend — a função confere que o caller logado é o Caio. O gate no
front é só pra esconder a UI.

## Visibilidade
Mostrar o item de menu / página "Administração" SOMENTE se o e-mail do usuário
logado === `caio@salexpress.com.br` (ex.: `session.user.email`). Para os demais,
nem renderizar a rota.

## Chamadas (Supabase Edge Functions — o token de sessão vai automático)

### Listar operadores
```js
const { data } = await supabase.functions.invoke('admin-operadores', {
  body: { action: 'listar' }
});
// data.ok === true
// data.operadores: [{ id, nome, email, papel, cockpit_ativo, tem_login }]
```

### Trocar login/senha (ou criar login)
```js
const { data } = await supabase.functions.invoke('admin-operadores', {
  body: {
    action: 'set_credenciais',
    operador_id: <id do operador>,
    novo_email: '<novo e-mail>',   // opcional
    nova_senha: '<nova senha>'     // opcional (mín. 8 chars)
  }
});
// sucesso: data.ok === true, data.acoes: ['admin_set_login','admin_set_senha',...]
// erro:    data.ok === false, data.error: '<mensagem pra exibir>'
```
Regras: enviar pelo menos um de novo_email / nova_senha. Senha mínima 8
caracteres. Se o operador não tem login (tem_login === false), os DOIS campos
(novo_email + nova_senha) são obrigatórios — a função cria o acesso.

## UI sugerida
- Tabela de operadores: Nome | E-mail (login) | Papel | Tem login? | Ação.
- Botão "Editar credenciais" abre modal com:
  - Campo "Novo e-mail (login)" (pré-preenchido com o e-mail atual; opcional).
  - Campo "Nova senha" + "Confirmar nova senha" (opcional; validar igualdade e
    mín. 8). Botão de mostrar/ocultar senha.
  - Se tem_login === false: rótulo "Este operador ainda não tem acesso — informe
    e-mail e senha para criar o login."
- Ao salvar: chamar set_credenciais; em sucesso, toast "Credenciais atualizadas"
  e recarregar a lista; em erro, mostrar data.error.
- NÃO exibir senhas em nenhum lugar (só campos de input).

## Observação
A troca de e-mail aqui também atualiza o e-mail de login do operador no Supabase
Auth e na tabela operadores (ficam em sincronia). O operador passa a logar com o
novo e-mail + senha definidos.

# Lovable — Upload de anexo: mostrar o erro REAL (não "Falha no upload" genérico)

## Problema

Quando a operadora adiciona um anexo no e-mail (botão "+ ADICIONAR ARQUIVO"), o front chama a edge function `upload-anexo-email`. Se ela retorna um status não-2xx, o front hoje mostra um toast genérico **"Falha no upload — Edge Function returned a non-2xx status code"**, escondendo a causa real. A operadora não sabe o que fazer.

A função **já retorna uma mensagem clara** no corpo da resposta, ex.:
- `"Tipo de arquivo não suportado (.heic). Aceitos: PDF, JPG, PNG, GIF, WEBP, Word (.doc/.docx), Excel (.xls/.xlsx), CSV e TXT. Fotos de iPhone (.heic) precisam ser convertidas para JPG/PNG antes de anexar."` (status 400)
- `"Arquivo excede 10MB (recebido: 12.4MB)"` (status 400)
- `"Limite de 20 anexos pendentes por card atingido..."` (status 400)

O front só precisa **ler e exibir** essa mensagem.

## O que corrigir no front

Onde chama o upload (provavelmente `supabase.functions.invoke('upload-anexo-email', ...)`):

O cliente supabase-js lança `FunctionsHttpError` em status não-2xx, e o corpo da resposta fica em `error.context` (um objeto `Response`). É preciso ler o JSON de lá:

```ts
const { data, error } = await supabase.functions.invoke('upload-anexo-email', {
  body: formData, // FormData com file + card_id
});

if (error) {
  let msg = 'Falha no upload do anexo.';
  // supabase-js: corpo do erro vem em error.context (Response)
  try {
    const corpo = await (error as any).context?.json?.();
    if (corpo?.error) msg = corpo.error;   // mensagem clara da function
  } catch (_) { /* mantém msg padrão */ }
  toast.error(msg);   // mostra a mensagem REAL pra operadora
  return;
}
// sucesso: data.anexo_id, data.filename, etc.
```

## Validação client-side (opcional, melhora UX)

Antes de enviar, dá pra barrar tipos não suportados já no front e mostrar a mensagem na hora, sem ida ao servidor. Extensões aceitas: `pdf, jpg, jpeg, png, gif, webp, doc, docx, xls, xlsx, csv, txt`. Se o arquivo for `.heic` (foto de iPhone), avisar pra converter pra JPG/PNG.

## Observação

Não muda contrato da function (mesmo `file` + `card_id` no FormData, mesmo shape de sucesso). É só ler `error.context` no caso de erro. Nenhuma mudança de tabela/RPC.

# Livro-caixa da Tâmara (CPF e CNPJ / MEI)

Responda em português, passo a passo e sem jargão. Livro-caixa da Tâmara Cavalcante (Personal Organizer): conta
CPF e conta CNPJ, Previsão do negócio (contador, mídia, DAS/INSS, pró-labore), IR e metas.
É separado do Financeiro_Solano (objetivos diferentes); o layout segue o dele, mas não misture dados nem regras.

Trabalho no PC: ver bicalho743/meu-enxoval-em-dia/docs/CLAUDE-NO-PC.md (guia de migração para o Claude Code do PC Windows "Notebook_Solano").

## Tipo e ids
- **Site** de um arquivo só (`index.html`, sem build). Publicação: **GitHub Pages** em
  https://bicalho743.github.io/LIVRO_CAIXA_TAMARA/ (sai sozinho a cada push na `main`).
- Supabase: projeto `ejbnjpucrlnnxvqyoduj` (login e dados). Função `supabase/functions/resumo-whatsapp`: resumo
  diário das metas às 8h pelo CallMeBot (passo a passo em `supabase/LEIA-ME.md`).
- Não tem bundle, loja, Codemagic, Expo, RevenueCat nem Render.

## Regras
- Conferir antes de publicar: `node --check` no script e abrir no Playwright em 390 px e 1366 px, sem erros.
- Trabalhe numa branch e leve para a `main` por PR.

## Onde paramos (26/11/2026)
- **No ar (11/11):** importar a fatura do cartão por prints do app do BB (OCR no navegador).
- **Decisão pendente da Tâmara:** ativar o CallMeBot no WhatsApp dela ("vai ativar, mas não agora"); enquanto isso o
  resumo diário não chega. Os resumos do Solano e da Tâmara têm de sair separados.
- **Nada em andamento.**

# Resumo diário no WhatsApp

Todo dia às 8h (horário de Brasília) o Supabase monta o resumo das metas e envia para o seu WhatsApp.
É o mesmo texto que aparece em **Pessoal › Metas › Resumo para WhatsApp**.
Tudo é feito pelo painel do Supabase, sem instalar nada.

## 1. Ativar o CallMeBot (grátis, envia só para o seu número)
1. Veja em https://www.callmebot.com/blog/free-api-whatsapp-messages/ o número atual do bot e salve nos contatos.
2. Mande para ele pelo WhatsApp: `I allow callmebot to send me messages`
3. Ele responde com a sua **apikey**. Guarde.

## 2. Criar a função
Painel do Supabase › **Edge Functions** › *Deploy a new function* › *Via editor*
- Nome: `resumo-whatsapp`
- Cole o conteúdo de `supabase/functions/resumo-whatsapp/index.ts` e clique em *Deploy*.
- Em *Details* da função, **desligue "Verify JWT"** (a função usa a própria senha, `CRON_SECRET`).

## 3. Cadastrar os secrets
Edge Functions › **Secrets** › adicione:

| Nome | Valor |
|---|---|
| `LC_USER_ID` | seu id em Authentication › Users (coluna UID) |
| `WA_TELEFONE` | `55` + DDD + número, ex: `5531999998888` |
| `CALLMEBOT_APIKEY` | a apikey do passo 1 |
| `CRON_SECRET` | uma senha qualquer, ex: `lc-8h-2026-xyz` |

## 4. Testar
No navegador ou no terminal (troque a senha):
```
curl -H "x-cron-secret: SUA_SENHA" "https://ejbnjpucrlnnxvqyoduj.supabase.co/functions/v1/resumo-whatsapp?teste=1"
```
`?teste=1` só mostra o texto. Sem ele, envia de verdade.

## 5. Agendar todo dia às 8h
Painel › **SQL Editor**, rode (troque a senha):
```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'resumo-whatsapp-8h',
  '0 11 * * *',   -- 11h UTC = 8h em Brasília
  $$
  select net.http_post(
    url := 'https://ejbnjpucrlnnxvqyoduj.supabase.co/functions/v1/resumo-whatsapp',
    headers := '{"Content-Type":"application/json","x-cron-secret":"SUA_SENHA"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
```
Para mudar o horário: `select cron.unschedule('resumo-whatsapp-8h');` e rode de novo com outra hora.

## Limites
- O resumo só mostra o que já foi **importado** no app. O BB não manda extrato sozinho, então importe o extrato/fatura com frequência para o número refletir o dia.
- CallMeBot é um serviço gratuito de terceiros, sem garantia. Para algo mais robusto: Z-API (pago, brasileiro) ou a API oficial do WhatsApp (Meta), que exige conta Business e modelo de mensagem aprovado. Só a função `enviarWhatsApp` muda.

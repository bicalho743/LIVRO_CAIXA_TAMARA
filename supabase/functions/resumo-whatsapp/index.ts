// Supabase Edge Function: envia todo dia o resumo das metas do Livro-caixa pelo WhatsApp.
// Chamado pelo agendamento (pg_cron) descrito em supabase/LEIA-ME.md.
//
// Secrets necessários (supabase secrets set ...):
//   LC_USER_ID        id do seu usuário (Authentication › Users no painel do Supabase)
//   WA_TELEFONE       seu número com DDI, ex: 5531999998888
//   CALLMEBOT_APIKEY  chave que o CallMeBot manda depois que você ativa o bot
//   CRON_SECRET       uma senha qualquer, a mesma usada no agendamento
// SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já existem automaticamente nas Edge Functions.

import { createClient } from "npm:@supabase/supabase-js@2";

type Lanc = { data: string; valor: number; categoria: string; vinculo: string; ignorado?: boolean };

// mesmas regras do index.html
const CAT_PL = "Pró-labore (retirada MEI)";
const CATS_FORA = new Set(["Cartão de crédito", "Aplicação e resgate", "Transferência entre minhas contas"]);
const CATS_SO_NEGOCIO = new Set(["Receita de cliente", "Serviços do negócio", "Produtos para venda", "Material de trabalho", "Marketing"]);
const RECEITA_CATS = new Set(["Receita de cliente", "Produtos para venda"]);
const MESES = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];

const ehNegocio = (l: Lanc) => l.vinculo === "PJ" || CATS_SO_NEGOCIO.has(l.categoria);
const ehMov = (l: Lanc) => !CATS_FORA.has(l.categoria);
const ehRetirada = (l: Lanc) => l.categoria === CAT_PL && l.valor < 0 && ehNegocio(l);
const reais0 = (v: number) => "R$ " + Math.round(v).toLocaleString("pt-BR");

function hojeSP(): string {
  // data de hoje no fuso de Brasília (AAAA-MM-DD)
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
}

function gastosMes(ls: Lanc[], conta: "cpf" | "pj", ym: string) {
  const pc: Record<string, number> = {};
  for (const l of ls) {
    if (l.ignorado || !ehMov(l) || l.data.slice(0, 7) !== ym) continue;
    if ((conta === "pj") !== ehNegocio(l)) continue;
    if (conta === "pj" && ehRetirada(l)) continue;
    pc[l.categoria] = (pc[l.categoria] || 0) + l.valor;
  }
  const r: Record<string, number> = {};
  for (const c in pc) if (pc[c] < 0) r[c] = -pc[c];
  return r;
}

// uma mensagem por conta: "cpf" (Pessoal) ou "pj" (Negócio) — mesmo texto do app (textoWhatsApp no index.html)
function montarTexto(dados: any, conta: "cpf" | "pj"): string {
  const ls: Lanc[] = dados.lancamentos || [];
  const metas = dados.metas || { cpf: {}, pj: {}, faturamento: 0 };
  const nome = conta === "pj" ? "Negócio" : "Pessoal";
  const daC = (l: Lanc) => (conta === "pj") === ehNegocio(l);
  const hoje = hojeSP(), ym = hoje.slice(0, 7);
  const dm = (d: string) => d.slice(8, 10) + "/" + d.slice(5, 7);
  const [a, m] = ym.split("-").map(Number);
  const diasMes = new Date(a, m, 0).getDate(), dia = +hoje.slice(8, 10);

  const linhas = ["*Livro-caixa · " + nome + " · " + dm(hoje) + "*"];
  const ult = ls.reduce((mx, l) => (l.data <= hoje && l.data > mx && daC(l) ? l.data : mx), "");
  if (ult) {
    const gd = ls.filter((l) => l.data === ult && daC(l) && !l.ignorado && ehMov(l) && l.valor < 0 && !ehRetirada(l))
      .reduce((s, l) => s - l.valor, 0);
    linhas.push("Último dia com lançamentos: " + dm(ult) + " — gastou " + reais0(gd));
  }
  const g = gastosMes(ls, conta, ym);
  const totG = Object.values(g).reduce((x, y) => x + y, 0);
  const mesNome = MESES[m - 1].charAt(0).toUpperCase() + MESES[m - 1].slice(1);
  linhas.push("", "*" + mesNome + "*" + (dia < diasMes ? " (dia " + dia + " de " + diasMes + ")" : ""));
  if (conta === "pj") {
    const rec = ls.filter((l) => !l.ignorado && l.valor > 0 && ehNegocio(l) && RECEITA_CATS.has(l.categoria) && l.data.slice(0, 7) === ym)
      .reduce((s, l) => s + l.valor, 0);
    linhas.push("Faturou " + reais0(rec) + (metas.faturamento
      ? " de " + reais0(metas.faturamento) + " (" + Math.round((rec / metas.faturamento) * 100) + "%)" : ""));
    linhas.push("Gastou " + reais0(totG) + " · " + (rec - totG < 0 ? "prejuízo " : "lucro ") + reais0(Math.abs(rec - totG)));
  } else linhas.push("Gastou " + reais0(totG));

  const mt: Record<string, number> = metas[conta] || {};
  const cs = Object.keys(mt).filter((c) => mt[c] > 0).sort((x, y) => (g[y] || 0) / mt[y] - (g[x] || 0) / mt[x]);
  linhas.push("", "*Metas*");
  if (!cs.length) linhas.push("Nenhuma meta cadastrada ainda.");
  for (const c of cs) {
    const v = g[c] || 0, meta = mt[c], pct = v / meta;
    const proj = dia < diasMes ? (v / dia) * diasMes : v;
    const ic = pct > 1 ? "🔴" : pct >= 0.8 || (dia < diasMes && proj > meta * 1.05) ? "🟡" : "🟢";
    linhas.push(ic + " " + c + ": " + reais0(v) + " de " + reais0(meta) +
      (pct > 1 ? " (+" + reais0(v - meta) + ")" : " (" + Math.round(pct * 100) + "%)"));
  }
  return linhas.join("\n");
}

async function enviarWhatsApp(texto: string) {
  // CallMeBot: gratuito, só envia para o seu próprio número (ideal para lembrete pessoal).
  // Para trocar por Z-API, Evolution API ou a API oficial da Meta, basta mudar esta função.
  let fone = (Deno.env.get("WA_TELEFONE") || "").replace(/[^\d+]/g, "");
  if (!fone.startsWith("+")) fone = "+" + fone;
  const url = "https://api.callmebot.com/whatsapp.php?phone=" + encodeURIComponent(fone) +
    "&text=" + encodeURIComponent(texto) + "&apikey=" + encodeURIComponent((Deno.env.get("CALLMEBOT_APIKEY") || "").trim());
  const r = await fetch(url);
  // o CallMeBot responde HTML e muitas vezes status 200 mesmo quando recusa; guardamos o texto para diagnóstico
  const bruto = await r.text();
  console.log("CallMeBot bruto", r.status, bruto.slice(0, 4000)); // resposta completa, para diagnóstico
  const corpo = bruto.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (!r.ok) throw new Error("CallMeBot " + r.status + ": " + corpo.slice(0, 300));
  return corpo;
}

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) {
    return new Response("não autorizado", { status: 401 });
  }
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEY"))!);
    const { data, error } = await sb.from("livro_caixa").select("valor")
      .eq("user_id", Deno.env.get("LC_USER_ID")!).eq("chave", "livro-caixa:v1").maybeSingle();
    if (error) throw error;
    if (!data) return new Response("sem dados", { status: 404 });
    const curto = new URL(req.url).searchParams.get("curto") === "1"; // ?curto=1 manda só uma linha de teste
    const soTeste = new URL(req.url).searchParams.get("teste") === "1"; // ?teste=1 mostra os textos sem enviar
    const textos = curto ? ["Teste do Livro-caixa: envio funcionando."]
      : [montarTexto(data.valor, "cpf"), montarTexto(data.valor, "pj")];
    if (soTeste) return new Response(textos.join("\n\n----------\n\n"), { headers: { "content-type": "text/plain; charset=utf-8" } });
    // envia em segundo plano: o agendamento (pg_net) desiste de esperar após 5 s, e duas mensagens levam mais que isso
    const enviarTodas = async () => {
      for (let i = 0; i < textos.length; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 4000)); // intervalo entre as mensagens (limite do CallMeBot)
        try { await enviarWhatsApp(textos[i]); } catch (e) { console.error("falha no envio " + (i + 1), e); }
      }
    };
    // @ts-ignore EdgeRuntime existe nas Edge Functions do Supabase
    EdgeRuntime.waitUntil(enviarTodas());
    return new Response("Enviando " + textos.length + " mensagem(ns). Resultado do CallMeBot fica em Edge Functions › Logs.\n\n" +
      textos.join("\n\n----------\n\n"), { headers: { "content-type": "text/plain; charset=utf-8" } });
  } catch (e) {
    console.error(e);
    return new Response("erro: " + (e as Error).message, { status: 500 });
  }
});

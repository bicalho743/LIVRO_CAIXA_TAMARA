// Supabase Edge Function: envia todo dia, pelo WhatsApp, só o saldo da conta CPF e da conta CNPJ.
// (?completo=1 envia o resumo antigo: metas do mês + link da planilha, uma mensagem por conta.)
// O resumo antigo, abaixo, continua no arquivo para uso com ?completo=1.
// Cada mensagem (Pessoal e Negócio) traz o link da planilha do mês no layout da aba LANÇAMENTOS.
// O link aponta para esta própria função (?planilha=AAAA-MM&conta=cpf|pj&k=...), que gera o .xlsx na hora.
// Chamado pelo agendamento (pg_cron) descrito em supabase/LEIA-ME.md.
//
// Secrets necessários (supabase secrets set ...):
//   LC_USER_ID        id do seu usuário (Authentication › Users no painel do Supabase)
//   WA_TELEFONE       seu número com DDI, ex: 5531999998888
//   CALLMEBOT_APIKEY  chave que o CallMeBot manda depois que você ativa o bot
//   CRON_SECRET       uma senha qualquer, a mesma usada no agendamento
// SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já existem automaticamente nas Edge Functions.

import { createClient } from "npm:@supabase/supabase-js@2";
import * as XLSX from "npm:xlsx@0.18.5";

type Lanc = { data: string; valor: number; categoria: string; vinculo: string; ignorado?: boolean;
              hist?: string; origem?: string; doc?: string; tipo?: string };

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

// ---- planilha do mês (mesmo layout da aba LANÇAMENTOS do Solano) ----
// colunas a partir da B: DATA | HISTÓRICO | VALOR | BANCO | CATEGORIA | SUBCATEGORIA | FIXO/VARIÁVEL | MÊS
const MES_PL = ["JAN","FEV","MAR","ABR","MAI","JUN","JUL","AGO","SET","OUT","NOV","DEZ"];
const GRUPO_PL: Record<string, string> = {
  "Receita de cliente": "receita", "Reembolso e estorno": "receita", "Rendimento": "receita", "Transferência recebida": "receita",
  "Mercado e padaria": "supermercado", "Alimentação fora": "bar/restaurante", "Farmácia": "saúde",
  "Casa e manutenção": "casa", "Telefone e internet": "casa", "Assinaturas digitais": "casa",
  "Transporte": "transporte", "Estética e cuidados": "diversos", "Vestuário e acessórios": "diversos",
  "Presentes e doações": "diversos", "Compras físicas": "diversos", "Compras online": "diversos",
  "Lazer e entretenimento": "lazer", "Juros e IOF": "financiamento e dividas", "Seguros": "financiamento e dividas",
  "Material de trabalho": "negócio", "Marketing": "negócio", "Serviços do negócio": "negócio", "Produtos para venda": "negócio",
  "Impostos e taxas": "negócio", "Pró-labore (retirada MEI)": "negócio",
  "Aplicação e resgate": "investimento", "Transferência entre minhas contas": "transferência",
  "Transferência enviada": "transferência", "Transferência família": "transferência", "Cartão de crédito": "cartão",
};
const pareceBanco = (h: string) => /^(PIX|PAY|RSCSS|RSHOP|RSCCS|DEV PIX|REND|SISPAG|INT |DA |TED|DOC|COR |JUROS|DDA|SAQUE|FATURA|FINANC|CONTRB|TAR|ON |BOLETO|COMPRA|Pix -|Compra com)/i.test(h);
const bancoPL = (l: Lanc) => l.origem === "cartao" ? (String(l.doc || "").trim() || "cartão") : l.origem === "pj" ? "CNPJ" : "CPF";
const tipoPL = (l: Lanc) => l.tipo || (l.data.slice(8, 10) === "01" && !pareceBanco(l.hist || "") ? "FIXO" : "VARIÁVEL");

function planilhaMes(ls: Lanc[], ym: string, conta: "cpf" | "pj"): Uint8Array {
  const doMes = ls.filter((l) => !l.ignorado && l.data.slice(0, 7) === ym && (conta === "pj") === ehNegocio(l))
    .sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
  const aoa: any[][] = [["◀  VOLTAR AO ÍNDICE"], [], ["", "  LANÇAMENTOS  —  " + (conta === "pj" ? "NEGÓCIO" : "PESSOAL")]];
  for (const l of doMes) {
    const [a, m, d] = l.data.split("-").map(Number);
    const cat = l.categoria || "Sem categoria";
    aoa.push(["", Date.UTC(a, m - 1, d) / 864e5 + 25569, l.hist || "", l.valor, bancoPL(l),
      cat === "Sem categoria" ? "" : (GRUPO_PL[cat] || "diversos"), cat === "Sem categoria" ? "" : cat.toLowerCase(), tipoPL(l), MES_PL[m - 1]]);
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  for (let i = 4; i <= aoa.length; i++) {
    if (ws["B" + i]) ws["B" + i].z = "dd/mm/yyyy";
    if (ws["D" + i]) ws["D" + i].z = "#,##0.00_);[Red](#,##0.00)";
  }
  ws["!cols"] = [{ wch: 4 }, { wch: 12 }, { wch: 40 }, { wch: 12 }, { wch: 10 }, { wch: 20 }, { wch: 24 }, { wch: 10 }, { wch: 6 }];
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }, { s: { r: 2, c: 1 }, e: { r: 2, c: 8 } }];
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "LANÇAMENTOS");
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
}

// chave do link: HMAC com o CRON_SECRET (só quem recebeu a mensagem consegue baixar)
async function chaveLink(ym: string, conta: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(Deno.env.get("CRON_SECRET") || ""),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode("planilha:" + ym + ":" + conta)));
  return [...sig.slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function linkPlanilha(ym: string, conta: string) {
  return Deno.env.get("SUPABASE_URL") + "/functions/v1/resumo-whatsapp?planilha=" + ym + "&conta=" + conta + "&k=" + await chaveLink(ym, conta);
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

// ---- mensagem diária: só o saldo da conta CPF e da conta CNPJ ----
// saldo = último saldo conhecido (do extrato importado ou digitado no app, em dados.saldosDia)
//         + lançamentos da conta depois dessa data (mesma conta do painel "Saldos nos bancos" do app)
function saldoBanco(dados: any, o: "pf" | "pj", hoje: string): { v: number; ate: string } | null {
  const sd: Record<string, number> = (dados.saldosDia || {})[o] || {};
  const base = Object.keys(sd).filter((x) => x <= hoje).sort().pop();
  if (!base) return null;
  let mov = 0, ate = base;
  for (const l of (dados.lancamentos || []) as Lanc[]) {
    if (l.ignorado || l.origem === "cartao" || (l.origem === "pj") !== (o === "pj")) continue;
    if (l.data > base && l.data <= hoje) { mov += l.valor; if (l.data > ate) ate = l.data; }
  }
  return { v: Math.round((+sd[base] + mov) * 100) / 100, ate };
}
const reais2 = (v: number) => (v < 0 ? "-" : "") + "R$ " + Math.abs(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function textoSaldos(dados: any): string {
  const hoje = hojeSP();
  const ontem = new Date(hoje + "T12:00:00"); ontem.setDate(ontem.getDate() - 1);
  const limite = ontem.toISOString().slice(0, 10);
  const dm = (d: string) => d.slice(8, 10) + "/" + d.slice(5, 7);
  const linha = (o: "pf" | "pj", nome: string) => {
    const s = saldoBanco(dados, o, hoje);
    if (!s) return nome + ": sem saldo (digite no app)";
    // se os lançamentos importados terminam antes de ontem, avisa até que dia o valor vale
    return nome + ": " + reais2(s.v) + (s.ate < limite ? " (até " + dm(s.ate) + ")" : "");
  };
  return "*Saldo · " + dm(hoje) + "*\n" + linha("pf", "Conta CPF") + "\n" + linha("pj", "Conta CNPJ");
}

Deno.serve(async (req) => {
  const q = new URL(req.url).searchParams;
  const pl = q.get("planilha"), plConta = q.get("conta");
  if (!pl && req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) {
    return new Response("não autorizado", { status: 401 });
  }
  try {
    if (pl && (!/^\d{4}-\d{2}$/.test(pl) || (plConta !== "cpf" && plConta !== "pj") || q.get("k") !== await chaveLink(pl, plConta))) {
      return new Response("link inválido", { status: 403 });
    }
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEY"))!);
    const { data, error } = await sb.from("livro_caixa").select("valor")
      .eq("user_id", Deno.env.get("LC_USER_ID")!).eq("chave", "livro-caixa:v1").maybeSingle();
    if (error) throw error;
    if (!data) return new Response("sem dados", { status: 404 });
    // download da planilha pelo link da mensagem
    if (pl) {
      return new Response(planilhaMes(data.valor.lancamentos || [], pl, plConta as "cpf" | "pj"), { headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": 'attachment; filename="livro-caixa-' + (plConta === "pj" ? "negocio" : "pessoal") + "-" + pl + '.xlsx"' } });
    }
    const curto = q.get("curto") === "1"; // ?curto=1 manda só uma linha de teste
    const soTeste = q.get("teste") === "1"; // ?teste=1 mostra os textos sem enviar
    const textos = curto ? ["Teste do Livro-caixa: envio funcionando."]
      : q.get("completo") !== "1" ? [textoSaldos(data.valor)]
      : await Promise.all((["cpf", "pj"] as const).map(async (c) => {
          const ym = hojeSP().slice(0, 7);
          const n = (data.valor.lancamentos || []).filter((l: Lanc) => !l.ignorado && l.data.slice(0, 7) === ym && (c === "pj") === ehNegocio(l)).length;
          return montarTexto(data.valor, c) + (n ? "\n\n📊 Planilha do mês (" + n + " lançamentos):\n" + await linkPlanilha(ym, c) : "");
        }));
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

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const portfolioUserId = "d5c24678-1079-48da-91f1-d7be47b9f975";
const responseHeaders = { "content-type": "application/json; charset=utf-8" };

const kstDate = () => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
};

function portfolioState(rows: any[]) {
  const holdings = new Map<string, { ticker: string; quantity: number; cost: number }>();
  let cash = 0;
  for (const row of [...rows].sort((a, b) => String(a.traded_at).localeCompare(String(b.traded_at)))) {
    const amount = Number(row.amount) || 0;
    const fee = Number(row.fee) || 0;
    const quantity = Number(row.quantity) || 0;
    if (row.trade_type === "DEPOSIT") cash += amount;
    else if (row.trade_type === "WITHDRAW") cash -= amount;
    else if (row.trade_type === "BUY") {
      cash -= amount + fee;
      const holding = holdings.get(row.ticker) || { ticker: row.ticker, quantity: 0, cost: 0 };
      holding.quantity += quantity;
      holding.cost += amount + fee;
      holdings.set(row.ticker, holding);
    } else if (row.trade_type === "SELL") {
      cash += amount - fee;
      const holding = holdings.get(row.ticker);
      if (!holding || holding.quantity <= 0) continue;
      const sold = Math.min(holding.quantity, quantity);
      holding.cost *= (holding.quantity - sold) / holding.quantity;
      holding.quantity -= sold;
      holdings.set(row.ticker, holding);
    }
  }
  return { cash, holdings: [...holdings.values()].filter((holding) => holding.quantity > 1e-7) };
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response(JSON.stringify({ error: "POST 요청만 허용됩니다." }), { status: 405, headers: responseHeaders });
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(url, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: transactions, error: transactionError } = await supabase
    .from("transactions").select("traded_at,ticker,trade_type,quantity,price,amount,fee")
    .eq("user_id", portfolioUserId).order("traded_at", { ascending: true });
  if (transactionError) return new Response(JSON.stringify({ error: "거래 내역을 읽지 못했습니다." }), { status: 502, headers: responseHeaders });

  const { cash, holdings } = portfolioState(transactions || []);
  const tickers = holdings.map((holding) => holding.ticker);
  const quoteResponse = tickers.length ? await fetch(`${url}/functions/v1/market-quotes`, {
    method: "POST",
    headers: { apikey: serviceRole, Authorization: `Bearer ${serviceRole}`, "content-type": "application/json" },
    body: JSON.stringify({ tickers }),
  }) : null;
  const quotePayload = quoteResponse?.ok ? await quoteResponse.json() : { quotes: [] };
  const prices = new Map((Array.isArray(quotePayload.quotes) ? quotePayload.quotes : [])
    .filter((quote: any) => Number.isFinite(Number(quote.price)))
    .map((quote: any) => [quote.ticker, Number(quote.price)]));
  const snapshotHoldings = holdings.map((holding) => ({
    ticker: holding.ticker,
    quantity: holding.quantity,
    price: prices.get(holding.ticker) ?? holding.cost / holding.quantity,
  }));
  const totalEquity = Math.max(0, cash) + snapshotHoldings.reduce((sum, holding) => sum + holding.quantity * holding.price, 0);
  const totalCost = Math.max(0, cash) + holdings.reduce((sum, holding) => sum + holding.cost, 0);
  const snapshotDate = kstDate();
  const { data: previous } = await supabase.from("daily_snapshots")
    .select("total_equity,total_cost").eq("user_id", portfolioUserId)
    .lt("snapshot_date", snapshotDate).order("snapshot_date", { ascending: false }).limit(1).maybeSingle();
  const netCashFlow = totalCost - Number(previous?.total_cost || 0);
  const dailyReturn = previous?.total_equity ? (totalEquity - netCashFlow - Number(previous.total_equity)) / Number(previous.total_equity) : 0;
  const { error: saveError } = await supabase.from("daily_snapshots").upsert({
    user_id: portfolioUserId, snapshot_date: snapshotDate, total_equity: totalEquity, total_cost: totalCost,
    cash_balance: cash, holdings: snapshotHoldings, daily_return: dailyReturn, updated_at: new Date().toISOString(),
  }, { onConflict: "user_id,snapshot_date" });
  if (saveError) return new Response(JSON.stringify({ error: "평가 스냅샷을 저장하지 못했습니다." }), { status: 502, headers: responseHeaders });
  return new Response(JSON.stringify({ ok: true, snapshotDate, totalEquity, quoteCount: prices.size }), { headers: responseHeaders });
});

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const responseHeaders = { "content-type": "application/json; charset=utf-8" };
const asNumber = (value: unknown) => Number(value) || 0;
const kstDate = (value: string | Date = new Date()) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date(value));

type Transaction = { traded_at: string; ticker: string; trade_type: string; quantity: number; price: number; amount: number; fee: number };
type Adjustment = { adjusted_at: string; adjustment_amount: number; contribution_delta: number };
type Holding = { ticker: string; quantity: number; cost: number };

function portfolioState(rows: Transaction[], adjustments: Adjustment[] = [], throughDate?: string) {
  const holdings = new Map<string, Holding>();
  let cash = 0, deposits = 0, withdrawals = 0;
  const ordered = [...rows].sort((a, b) => String(a.traded_at).localeCompare(String(b.traded_at)));
  for (const row of ordered) {
    if (throughDate && kstDate(row.traded_at) > throughDate) continue;
    const amount = asNumber(row.amount), quantity = asNumber(row.quantity);
    if (row.trade_type === "DEPOSIT") { cash += amount; deposits += amount; }
    else if (row.trade_type === "WITHDRAW") { cash -= amount; withdrawals += amount; }
    else if (row.trade_type === "BUY") {
      cash -= amount;
      const holding = holdings.get(row.ticker) || { ticker: row.ticker, quantity: 0, cost: 0 };
      holding.quantity += quantity;
      holding.cost += amount;
      holdings.set(row.ticker, holding);
    } else if (row.trade_type === "SELL") {
      cash += amount;
      const holding = holdings.get(row.ticker);
      if (!holding || holding.quantity <= 0) continue;
      const sold = Math.min(holding.quantity, quantity);
      holding.cost *= (holding.quantity - sold) / holding.quantity;
      holding.quantity -= sold;
      holdings.set(row.ticker, holding);
    }
  }
  for (const row of adjustments) {
    if (throughDate && kstDate(row.adjusted_at) > throughDate) continue;
    cash += asNumber(row.adjustment_amount);
    const contribution = asNumber(row.contribution_delta);
    if (contribution >= 0) deposits += contribution;
    else withdrawals += -contribution;
  }
  return { cash, netContributions: deposits - withdrawals, holdings: [...holdings.values()].filter(item => item.quantity > 1e-7) };
}

async function currentPrices(url: string, serviceRole: string, holdings: Holding[]) {
  const tickers = holdings.map(item => item.ticker);
  if (!tickers.length) return new Map<string, number>();
  const response = await fetch(`${url}/functions/v1/market-quotes`, {
    method: "POST",
    headers: { apikey: serviceRole, Authorization: `Bearer ${serviceRole}`, "content-type": "application/json" },
    body: JSON.stringify({ tickers }),
  });
  const payload = response.ok ? await response.json() : { quotes: [] };
  return new Map((Array.isArray(payload.quotes) ? payload.quotes : [])
    .filter((quote: any) => Number.isFinite(Number(quote.price)))
    .map((quote: any) => [String(quote.ticker), Number(quote.price)]));
}

async function priceHistory(ticker: string, from: string) {
  const period1 = Math.floor(new Date(`${from}T00:00:00Z`).getTime() / 1000) - 86400 * 7;
  const period2 = Math.floor(Date.now() / 1000) + 86400;
  const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${period1}&period2=${period2}&interval=1d&events=splits`, { headers: { "user-agent": "Mozilla/5.0 portfolio-dashboard" } });
  if (!response.ok) return new Map<string, number>();
  const result = (await response.json())?.chart?.result?.[0];
  const timestamps = result?.timestamp || [], closes = result?.indicators?.quote?.[0]?.close || [];
  return new Map(timestamps.map((timestamp: number, index: number) => [new Date(timestamp * 1000).toISOString().slice(0, 10), Number(closes[index])]).filter((entry: [string, number]) => Number.isFinite(entry[1])));
}

function priceOn(history: Map<string, number>, date: string) {
  let latest: number | undefined;
  for (const [priceDate, price] of history) { if (priceDate > date) break; latest = price; }
  return latest;
}

function valuation(state: ReturnType<typeof portfolioState>, prices: Map<string, number>) {
  const holdings = state.holdings.map(item => ({ ticker: item.ticker, quantity: item.quantity, price: prices.get(item.ticker) ?? item.cost / item.quantity }));
  return { holdings, totalEquity: state.cash + holdings.reduce((sum, item) => sum + item.quantity * item.price, 0) };
}

Deno.serve(async request => {
  if (request.method !== "POST") return new Response(JSON.stringify({ error: "POST 요청만 허용됩니다." }), { status: 405, headers: responseHeaders });
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const portfolioUserId = Deno.env.get("PORTFOLIO_USER_ID");
  if (!portfolioUserId) return new Response(JSON.stringify({ error: "운영 사용자 환경 변수가 없습니다." }), { status: 500, headers: responseHeaders });
  const supabase = createClient(url, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  let input: any = {};
  try { input = await request.json(); } catch {}

  const { data: transactions, error: transactionError } = await supabase.from("transactions")
    .select("traded_at,ticker,trade_type,quantity,price,amount,fee")
    .eq("user_id", portfolioUserId).order("traded_at", { ascending: true });
  if (transactionError) return new Response(JSON.stringify({ error: "거래 내역을 읽지 못했습니다." }), { status: 502, headers: responseHeaders });
  const rows = (transactions || []) as Transaction[];
  const { data: adjustmentData, error: adjustmentError } = await supabase.from("settlement_adjustments")
    .select("adjusted_at,adjustment_amount,contribution_delta").eq("user_id", portfolioUserId).order("adjusted_at", { ascending: true });
  if (adjustmentError) return new Response(JSON.stringify({ error: "잔액 보정 내역을 읽지 못했습니다." }), { status: 502, headers: responseHeaders });
  const adjustments = (adjustmentData || []) as Adjustment[];

  if (input.action === "cash-flow-boundary") {
    const state = portfolioState(rows, adjustments);
    const prices = await currentPrices(url, serviceRole, state.holdings);
    const value = valuation(state, prices);
    const { error } = await supabase.from("valuation_events").insert({
      user_id: portfolioUserId,
      occurred_at: input.occurredAt || new Date().toISOString(),
      equity_before_flow: value.totalEquity,
      cash_flow: asNumber(input.cashFlow),
      source: "transaction",
    });
    if (error) return new Response(JSON.stringify({ error: "현금흐름 경계값을 저장하지 못했습니다." }), { status: 502, headers: responseHeaders });
    return new Response(JSON.stringify({ ok: true, boundarySaved: true }), { headers: responseHeaders });
  }

  if (input.action === "rebuild") {
    const fromDate = kstDate(input.from || rows[0]?.traded_at || new Date());
    const { data: existing } = await supabase.from("daily_snapshots").select("snapshot_date")
      .eq("user_id", portfolioUserId).gte("snapshot_date", fromDate).order("snapshot_date", { ascending: true });
    const dates = [...new Set([...(existing || []).map(item => item.snapshot_date), kstDate()])].sort();
    const tickers = [...new Set(rows.filter(row => ["BUY", "SELL"].includes(row.trade_type)).map(row => row.ticker))];
    const histories = new Map<string, Map<string, number>>();
    await Promise.all(tickers.map(async ticker => histories.set(ticker, await priceHistory(ticker, fromDate))));
    const rebuilt = dates.map(date => {
      const state = portfolioState(rows, adjustments, date);
      const prices = new Map(state.holdings.map(item => [item.ticker, priceOn(histories.get(item.ticker) || new Map(), date) ?? item.cost / item.quantity]));
      const value = valuation(state, prices);
      return {
        user_id: portfolioUserId, snapshot_date: date, total_equity: value.totalEquity,
        total_cost: state.netContributions, net_contributions: state.netContributions,
        cash_balance: state.cash, holdings: value.holdings, twr_daily_return: null,
        twr_coverage_start: date === kstDate() ? date : null, updated_at: new Date().toISOString(),
      };
    });
    const { error } = await supabase.from("daily_snapshots").upsert(rebuilt, { onConflict: "user_id,snapshot_date" });
    if (error) return new Response(JSON.stringify({ error: "과거 평가 이력을 재구성하지 못했습니다." }), { status: 502, headers: responseHeaders });
    return new Response(JSON.stringify({ ok: true, rebuilt: rebuilt.length, fromDate }), { headers: responseHeaders });
  }

  const state = portfolioState(rows, adjustments);
  const prices = await currentPrices(url, serviceRole, state.holdings);
  const value = valuation(state, prices);
  const snapshotDate = kstDate();
  const { data: previous } = await supabase.from("daily_snapshots")
    .select("total_equity,snapshot_date,twr_coverage_start,updated_at").eq("user_id", portfolioUserId)
    .lt("snapshot_date", snapshotDate).order("snapshot_date", { ascending: false }).limit(1).maybeSingle();
  let twrDailyReturn: number | null = null;
  let coverageStart = previous?.twr_coverage_start || snapshotDate;
  const previousDay = previous?.snapshot_date ? new Date(`${previous.snapshot_date}T00:00:00Z`) : null;
  const currentDay = new Date(`${snapshotDate}T00:00:00Z`);
  const isConsecutive = previousDay && currentDay.getTime() - previousDay.getTime() === 86400000;
  if (previous?.total_equity && isConsecutive) {
    const { data: events } = await supabase.from("valuation_events").select("occurred_at,equity_before_flow,cash_flow")
      .eq("user_id", portfolioUserId).gt("occurred_at", previous.updated_at).lte("occurred_at", new Date().toISOString()).order("occurred_at", { ascending: true });
    let factor = 1, base = asNumber(previous.total_equity), exact = true;
    for (const event of events || []) {
      if (base <= 0 || asNumber(event.equity_before_flow) <= 0) { exact = false; break; }
      factor *= asNumber(event.equity_before_flow) / base;
      base = asNumber(event.equity_before_flow) + asNumber(event.cash_flow);
    }
    if (exact && base > 0) twrDailyReturn = factor * (value.totalEquity / base) - 1;
  } else if (previous?.total_equity) {
    // A missed snapshot makes the intervening cash-flow boundaries unknowable.
    // Restart the exact TWR series at today's neutral baseline instead of
    // reporting the whole gap as one day's market return.
    twrDailyReturn = 0;
    coverageStart = snapshotDate;
  }
  const { error: saveError } = await supabase.from("daily_snapshots").upsert({
    user_id: portfolioUserId, snapshot_date: snapshotDate, total_equity: value.totalEquity,
    total_cost: state.netContributions, net_contributions: state.netContributions,
    cash_balance: state.cash, holdings: value.holdings, twr_daily_return: twrDailyReturn,
    twr_coverage_start: coverageStart, updated_at: new Date().toISOString(),
  }, { onConflict: "user_id,snapshot_date" });
  if (saveError) return new Response(JSON.stringify({ error: "평가 스냅샷을 저장하지 못했습니다." }), { status: 502, headers: responseHeaders });
  return new Response(JSON.stringify({ ok: true, snapshotDate, totalEquity: value.totalEquity, quoteCount: prices.size, twrExact: twrDailyReturn !== null }), { headers: responseHeaders });
});

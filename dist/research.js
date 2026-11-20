const DAY = 86400000;
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;

export function alignHistories(histories, tickers = Object.keys(histories)) {
  const maps = Object.fromEntries(tickers.map(ticker => [ticker, new Map((histories[ticker] || []).map(point => [point.date, number(point.value)]))]));
  const dates = [...(maps[tickers[0]]?.keys() || [])].filter(date => tickers.every(ticker => maps[ticker].has(date) && maps[ticker].get(date) > 0)).sort();
  return dates.map(date => ({ date, prices: Object.fromEntries(tickers.map(ticker => [ticker, maps[ticker].get(date)])) }));
}

export function xirr(cashFlows) {
  if (!cashFlows.some(flow => flow.amount < 0) || !cashFlows.some(flow => flow.amount > 0)) return null;
  const start = new Date(cashFlows[0].date).getTime();
  const npv = rate => cashFlows.reduce((sum, flow) => sum + flow.amount / ((1 + rate) ** ((new Date(flow.date).getTime() - start) / (365.25 * DAY))), 0);
  let low = -0.999, high = 10;
  if (npv(low) * npv(high) > 0) return null;
  for (let index = 0; index < 120; index += 1) { const mid = (low + high) / 2; if (npv(low) * npv(mid) <= 0) high = mid; else low = mid; }
  return (low + high) / 2;
}

export function maximumDrawdown(values) {
  let peak = -Infinity, mdd = 0;
  values.forEach(value => { peak = Math.max(peak, value); if (peak > 0) mdd = Math.min(mdd, value / peak - 1); });
  return mdd;
}

export function simulateStrategy(input) {
  const tickers = Object.keys(input.weights).filter(ticker => number(input.weights[ticker]) > 0);
  const rows = alignHistories(input.histories, tickers).filter(row => (!input.startDate || row.date >= input.startDate) && (!input.endDate || row.date <= input.endDate));
  if (rows.length < 2) throw new Error('공통 가격 데이터가 충분하지 않습니다.');
  const target = Object.fromEntries(tickers.map(ticker => [ticker, number(input.weights[ticker]) / tickers.reduce((sum, key) => sum + number(input.weights[key]), 0)]));
  const quantities = Object.fromEntries(tickers.map(ticker => [ticker, 0]));
  const basis = Object.fromEntries(tickers.map(ticker => [ticker, 0]));
  const feeRate = number(input.feeRate) / 100;
  const taxRate = number(input.taxRate) / 100;
  const initial = Math.max(0, number(input.initial));
  const monthly = Math.max(0, number(input.monthly));
  const mode = input.mode || 'lump';
  const rebalanceMonths = Math.max(1, number(input.rebalanceMonths) || 12);
  let cash = 0, fees = 0, taxes = 0, contributions = 0, previousEquity = 0, twrIndex = 100, peakQQQ = 0, drawdownStage = 0, pendingStage = null;
  const curve = [], dailyReturns = [], flows = [];
  const value = prices => cash + tickers.reduce((sum, ticker) => sum + quantities[ticker] * prices[ticker], 0);
  const buyToWeights = (amount, prices, weights = target) => {
    if (amount <= 0) return;
    tickers.forEach(ticker => {
      const allocation = amount * (weights[ticker] || 0);
      const fee = allocation * feeRate;
      const spend = Math.max(0, allocation - fee);
      quantities[ticker] += spend / prices[ticker];
      basis[ticker] += allocation;
      fees += fee;
      cash -= allocation;
    });
  };
  const rebalance = (prices, weights = target) => {
    const equity = value(prices);
    tickers.forEach(ticker => {
      const current = quantities[ticker] * prices[ticker], desired = equity * (weights[ticker] || 0);
      if (current <= desired) return;
      const proceeds = current - desired, fraction = current ? proceeds / current : 0;
      const removedBasis = basis[ticker] * fraction;
      const gain = Math.max(0, proceeds - removedBasis);
      const fee = proceeds * feeRate, tax = gain * taxRate;
      quantities[ticker] *= 1 - fraction;
      basis[ticker] -= removedBasis;
      cash += proceeds - fee - tax;
      fees += fee; taxes += tax;
    });
    const available = Math.max(0, cash);
    const deficits = tickers.map(ticker => ({ ticker, gap: Math.max(0, equity * (weights[ticker] || 0) - quantities[ticker] * prices[ticker]) }));
    const totalGap = deficits.reduce((sum, item) => sum + item.gap, 0);
    deficits.forEach(item => {
      const allocation = totalGap ? available * item.gap / totalGap : 0;
      const fee = allocation * feeRate, spend = Math.max(0, allocation - fee);
      quantities[item.ticker] += spend / prices[item.ticker]; basis[item.ticker] += allocation; cash -= allocation; fees += fee;
    });
  };
  rows.forEach((row, index) => {
    const month = row.date.slice(0, 7), previousMonth = rows[index - 1]?.date.slice(0, 7);
    let flow = 0;
    if (index === 0 && (mode === 'lump' || mode === 'mixed')) flow += initial;
    if ((mode === 'monthly' || mode === 'mixed') && (index === 0 || month !== previousMonth)) flow += monthly;
    if (flow > 0) { cash += flow; contributions += flow; flows.push({ date: row.date, amount: -flow }); buyToWeights(flow, row.prices); }
    let triggerRebalance = index > 0 && month !== previousMonth && ((new Date(`${row.date}T00:00:00Z`).getUTCFullYear() * 12 + new Date(`${row.date}T00:00:00Z`).getUTCMonth()) % rebalanceMonths === 0);
    let activeTarget = target;
    if (input.drawdownRule && row.prices.QQQ && tickers.includes('QLD') && tickers.includes('SGOV')) {
      if (pendingStage !== null && pendingStage !== drawdownStage) { drawdownStage = pendingStage; triggerRebalance = true; }
      activeTarget = { ...target, QLD: Math.min(1, (target.QLD || 0) + drawdownStage * 0.10), SGOV: Math.max(0, (target.SGOV || 0) - drawdownStage * 0.10) };
    }
    if (triggerRebalance) rebalance(row.prices, activeTarget);
    const equity = value(row.prices);
    if (index > 0 && previousEquity + flow > 0) { const daily = equity / (previousEquity + flow) - 1; dailyReturns.push(daily); twrIndex *= 1 + daily; }
    previousEquity = equity;
    curve.push({ date: row.date, equity, twr: twrIndex, contributions });
    if (input.drawdownRule && row.prices.QQQ) {
      peakQQQ = Math.max(peakQQQ, row.prices.QQQ);
      const drawdown = row.prices.QQQ / peakQQQ - 1;
      pendingStage = drawdown <= -0.30 ? 2 : drawdown <= -0.20 ? 1 : drawdown > -0.05 ? 0 : drawdownStage;
    }
  });
  const finalEquity = curve.at(-1).equity;
  flows.push({ date: curve.at(-1).date, amount: finalEquity });
  const years = Math.max(1 / 365.25, (new Date(curve.at(-1).date) - new Date(curve[0].date)) / (365.25 * DAY));
  const twr = twrIndex / 100 - 1;
  const cagr = (1 + twr) ** (1 / years) - 1;
  const average = dailyReturns.reduce((sum, value) => sum + value, 0) / Math.max(1, dailyReturns.length);
  const deviation = Math.sqrt(dailyReturns.reduce((sum, value) => sum + (value - average) ** 2, 0) / Math.max(1, dailyReturns.length - 1));
  const mdd = maximumDrawdown(curve.map(point => point.twr));
  const sharpe = deviation ? average / deviation * Math.sqrt(252) : 0;
  return { finalEquity, contributions, profit: finalEquity - contributions, twr, xirr: xirr(flows), cagr, mdd, sharpe, calmar: mdd ? cagr / Math.abs(mdd) : null, fees, taxes, curve, assumptions: { adjustedPrices: true, feeRate, taxRate, rebalanceMonths } };
}

export function stressTest(result, weights, shocks) {
  const total = Object.values(weights).reduce((sum, value) => sum + number(value), 0) || 1;
  const impact = Object.entries(weights).reduce((sum, [ticker, weight]) => sum + number(weight) / total * number(shocks[ticker]) / 100, 0);
  return { impact, stressedEquity: result.finalEquity * (1 + impact) };
}

export function allocationCandidates(step = 10) {
  const candidates = [];
  for (let qqq = 0; qqq <= 100; qqq += step) for (let qld = 0; qld <= 100 - qqq; qld += step) candidates.push({ QQQ: qqq, QLD: qld, SGOV: 100 - qqq - qld });
  return candidates;
}

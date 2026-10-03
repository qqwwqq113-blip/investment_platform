export const TARGET_DEFAULTS = Object.freeze({ QQQ: 10, QLD: 70, SGOV: 20 });
export const INVESTMENT_TICKERS = Object.freeze(['QQQ', 'QLD', 'SGOV']);
export const STRATEGY_DEFAULTS = Object.freeze({
  targetQQQ: 10,
  targetQLD: 70,
  targetSGOV: 20,
  qqqTrigger1: -20,
  qqqTrigger1SgovPct: 50,
  qqqTrigger2: -30,
  qqqTrigger2RemainingPct: 100,
  qldRebalanceTrigger: 85,
});
export const TRANSACTION_REASONS = Object.freeze([
  'REGULAR_BUY', 'QQQ_DRAWDOWN_1', 'QQQ_DRAWDOWN_2', 'QLD_REBALANCE', 'NEW_CAPITAL', 'OTHER',
]);

const n = value => Number(value) || 0;
const ascending = rows => [...rows].sort((a, b) => String(a.traded_at).localeCompare(String(b.traded_at)));

export function normalizeStrategy(input = {}) {
  const source = input || {};
  return Object.fromEntries(Object.entries(STRATEGY_DEFAULTS).map(([key, fallback]) => {
    const value = Number(source[key]);
    return [key, Number.isFinite(value) ? value : fallback];
  }));
}

export function strategyTargets(settings) {
  const value = normalizeStrategy(settings);
  return { QQQ: value.targetQQQ, QLD: value.targetQLD, SGOV: value.targetSGOV };
}

export function strategyFromLegacyTargets(saved) {
  if (!saved || typeof saved !== 'object') return { ...STRATEGY_DEFAULTS };
  const candidate = normalizeStrategy({ targetQQQ: saved.QQQ, targetQLD: saved.QLD, targetSGOV: saved.SGOV });
  return validateStrategy(candidate) ? { ...STRATEGY_DEFAULTS } : candidate;
}

export function validateStrategy(input) {
  const value = normalizeStrategy(input);
  const targetTotal = value.targetQQQ + value.targetQLD + value.targetSGOV;
  if ([value.targetQQQ, value.targetQLD, value.targetSGOV].some(item => item < 0 || item > 100)) return '목표 비중은 0~100% 범위여야 합니다.';
  if (Math.abs(targetTotal - 100) > 1e-7) return `목표 비중 합계는 100%여야 합니다. 현재 ${targetTotal.toFixed(1)}%입니다.`;
  if (value.qqqTrigger1 >= 0 || value.qqqTrigger1 < -100 || value.qqqTrigger2 >= 0 || value.qqqTrigger2 < -100) return 'QQQ Trigger는 -100%보다 크고 0%보다 작은 값이어야 합니다.';
  if (value.qqqTrigger2 >= value.qqqTrigger1) return '2차 QQQ Trigger는 1차보다 더 깊어야 합니다.';
  if ([value.qqqTrigger1SgovPct, value.qqqTrigger2RemainingPct, value.qldRebalanceTrigger].some(item => item < 0 || item > 100)) return '사용 비율과 QLD Trigger는 0~100% 범위여야 합니다.';
  return null;
}

export function portfolioState(rows) {
  const holdings = new Map();
  let cash = 0;
  let deposits = 0;
  let withdrawals = 0;
  let realizedProfit = 0;

  for (const row of ascending(rows)) {
    const amount = n(row.amount);
    const quantity = n(row.quantity);
    if (row.trade_type === 'ADJUSTMENT') {
      cash += n(row.adjustment_amount);
      const contribution = n(row.contribution_delta);
      if (contribution >= 0) deposits += contribution;
      else withdrawals += -contribution;
      continue;
    }
    if (row.trade_type === 'DEPOSIT') {
      cash += amount;
      deposits += amount;
      continue;
    }
    if (row.trade_type === 'WITHDRAW') {
      cash -= amount;
      withdrawals += amount;
      continue;
    }
    const holding = holdings.get(row.ticker) || {
      ticker: row.ticker,
      quantity: 0,
      cost: 0,
      totalBought: 0,
      realizedProfit: 0,
    };
    if (row.trade_type === 'BUY') {
      const acquisitionCost = amount;
      cash -= acquisitionCost;
      holding.quantity += quantity;
      holding.cost += acquisitionCost;
      holding.totalBought += acquisitionCost;
    } else if (row.trade_type === 'SELL' && holding.quantity > 0) {
      const sold = Math.min(holding.quantity, quantity);
      const ratio = sold / holding.quantity;
      const removedCost = holding.cost * ratio;
      const netProceeds = quantity > 0 ? amount * (sold / quantity) : 0;
      const gain = netProceeds - removedCost;
      holding.cost -= removedCost;
      holding.quantity -= sold;
      holding.realizedProfit += gain;
      realizedProfit += gain;
      cash += amount;
    }
    holdings.set(row.ticker, holding);
  }

  return {
    cash,
    deposits,
    withdrawals,
    netContributions: deposits - withdrawals,
    realizedProfit,
    holdings: [...holdings.values()].filter(item => item.quantity > 1e-7),
  };
}

export function enrichHoldings(state, quotes = {}) {
  return state.holdings.map(holding => {
    const currentPrice = Number(quotes[holding.ticker]?.price);
    const hasQuote = Number.isFinite(currentPrice) && currentPrice >= 0;
    const value = hasQuote ? holding.quantity * currentPrice : holding.cost;
    const unrealizedProfit = value - holding.cost;
    return {
      ...holding,
      averagePrice: holding.quantity ? holding.cost / holding.quantity : 0,
      currentPrice: hasQuote ? currentPrice : null,
      value,
      unrealizedProfit,
      unrealizedReturn: holding.cost ? unrealizedProfit / holding.cost : 0,
    };
  });
}

export function accountMetrics(state, holdings) {
  const investedAssets = holdings.reduce((sum, item) => sum + item.value, 0);
  const equity = state.cash + investedAssets;
  const profit = equity - state.netContributions;
  return {
    investedAssets,
    equity,
    profit,
    principalReturn: state.netContributions > 0 ? profit / state.netContributions : null,
    cashWeight: equity > 0 ? state.cash / equity : 0,
  };
}

export function allocationMetrics(holdings, target = TARGET_DEFAULTS) {
  const values = Object.fromEntries(INVESTMENT_TICKERS.map(ticker => [ticker, 0]));
  for (const item of holdings) if (item.ticker in values) values[item.ticker] += item.value;
  const total = Object.values(values).reduce((sum, value) => sum + value, 0);
  const rows = INVESTMENT_TICKERS.map(ticker => {
    const currentWeight = total ? values[ticker] / total * 100 : 0;
    const targetWeight = n(target[ticker]);
    return {
      ticker,
      value: values[ticker],
      currentWeight,
      targetWeight,
      drift: currentWeight - targetWeight,
      targetValue: total * targetWeight / 100,
      difference: total * targetWeight / 100 - values[ticker],
    };
  });
  return { total, values, rows };
}

export function nextContributionAdvice(allocation) {
  const deficits = allocation.rows.filter(row => row.difference > 0.005).sort((a, b) => b.difference - a.difference);
  if (!deficits.length) return null;
  return { ticker: deficits[0].ticker, amount: deficits[0].difference };
}

export function twrFromSnapshots(snapshots) {
  const rows = [...snapshots]
    .filter(row => Number.isFinite(Number(row.twr_daily_return)))
    .sort((a, b) => String(a.snapshot_date).localeCompare(String(b.snapshot_date)));
  if (!rows.length) return { available: false, value: null, startDate: null, observations: 0 };
  const factor = rows.reduce((product, row) => product * (1 + Number(row.twr_daily_return)), 1);
  return { available: true, value: factor - 1, startDate: rows[0].snapshot_date, observations: rows.length };
}

export function maximumDrawdownFromReturns(snapshots) {
  const rows = [...snapshots]
    .filter(row => Number.isFinite(Number(row.twr_daily_return)))
    .sort((a, b) => String(a.snapshot_date).localeCompare(String(b.snapshot_date)));
  if (!rows.length) return { available: false, value: null };
  let index = 1;
  let peak = 1;
  let maximumDrawdown = 0;
  for (const row of rows) {
    index *= 1 + Number(row.twr_daily_return);
    peak = Math.max(peak, index);
    maximumDrawdown = Math.min(maximumDrawdown, index / peak - 1);
  }
  return { available: true, value: maximumDrawdown };
}

export function qqqDrawdown(prices, settings = STRATEGY_DEFAULTS) {
  const strategy = normalizeStrategy(settings);
  const trigger1 = strategy.qqqTrigger1 / 100;
  const trigger2 = strategy.qqqTrigger2 / 100;
  const points = prices
    .map(point => ({ date: String(point.date), close: Number(point.close) }))
    .filter(point => point.date && Number.isFinite(point.close) && point.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!points.length) return null;
  let peak = -Infinity;
  let peakIndex = 0;
  for (let index = 0; index < points.length; index += 1) {
    if (points[index].close >= peak) {
      peak = points[index].close;
      peakIndex = index;
    }
  }
  const cycle = points.slice(peakIndex);
  let minimum = 0;
  let first20 = null;
  let first30 = null;
  for (const point of cycle) {
    const drawdown = point.close / peak - 1;
    minimum = Math.min(minimum, drawdown);
    if (!first20 && drawdown <= trigger1 + 1e-10) first20 = point.date;
    if (!first30 && drawdown <= trigger2 + 1e-10) first30 = point.date;
  }
  const latest = points.at(-1);
  return {
    peak,
    peakDate: points[peakIndex].date,
    current: latest.close / peak - 1,
    cycleMinimum: minimum,
    stage: first30 ? 2 : first20 ? 1 : 0,
    first20,
    first30,
    latestPrice: latest.close,
    latestDate: latest.date,
    cycleId: `QQQ:${points[peakIndex].date}`,
  };
}

export function strategyAdvice({ drawdown, allocation, settings = STRATEGY_DEFAULTS, qldCycleId = null }) {
  const strategy = normalizeStrategy(settings);
  const qld = allocation.rows.find(row => row.ticker === 'QLD');
  if (qld && qld.currentWeight >= strategy.qldRebalanceTrigger) {
    return {
      kind: 'RESET_TARGET',
      title: '목표 포트폴리오 복귀 조건 충족',
      detail: `QQQ ${strategy.targetQQQ}% · QLD ${strategy.targetQLD}% · SGOV ${strategy.targetSGOV}%로 조정할 시점입니다.`,
      moves: allocation.rows.map(row => ({ ticker: row.ticker, amount: row.difference })),
      trigger: 'QLD_85',
      cycleId: qldCycleId,
    };
  }
  if (drawdown?.stage === 2) {
    return {
      kind: 'QQQ_30',
      title: '2차 리밸런싱 조건 충족',
      detail: `남은 SGOV의 ${strategy.qqqTrigger2RemainingPct}%를 QLD로 이동하는 전략 구간입니다.`,
      amount: (allocation.values.SGOV || 0) * strategy.qqqTrigger2RemainingPct / 100,
      trigger: 'QQQ_30',
      cycleId: drawdown.cycleId,
    };
  }
  if (drawdown?.stage === 1) {
    return {
      kind: 'QQQ_20',
      title: '1차 리밸런싱 조건 충족',
      detail: `현재 SGOV의 ${strategy.qqqTrigger1SgovPct}%를 QLD로 이동하는 전략 구간입니다.`,
      amount: (allocation.values.SGOV || 0) * strategy.qqqTrigger1SgovPct / 100,
      trigger: 'QQQ_20',
      cycleId: drawdown.cycleId,
    };
  }
  const contribution = nextContributionAdvice(allocation);
  return {
    kind: 'NORMAL',
    title: '정상 구간',
    detail: contribution
      ? `다음 투자금은 ${contribution.ticker}에 우선 배분하면 목표 비중에 가까워집니다.`
      : '현재 투자자산 비중이 목표에 가깝습니다.',
    contribution,
  };
}

export function strategyExecutionStatus(advice, rows) {
  if (!advice || !['QQQ_20', 'QQQ_30', 'RESET_TARGET'].includes(advice.kind)) return { required: false, executed: false, matches: [] };
  const reason = advice.kind === 'QQQ_20' ? 'QQQ_DRAWDOWN_1' : advice.kind === 'QQQ_30' ? 'QQQ_DRAWDOWN_2' : 'QLD_REBALANCE';
  const matches = rows.filter(row => row.reason === reason && ['BUY', 'SELL'].includes(row.trade_type)
    && row.strategy_cycle_id === advice.cycleId);
  return { required: true, executed: matches.length > 0, matches };
}

export function nominalNasdaqExposure(allocation) {
  if (!allocation.total) return 0;
  const qqq = allocation.rows.find(row => row.ticker === 'QQQ')?.currentWeight || 0;
  const qld = allocation.rows.find(row => row.ticker === 'QLD')?.currentWeight || 0;
  return (qqq + qld * 2) / 100;
}

export function sgovCapacity(allocation, settings = STRATEGY_DEFAULTS) {
  const strategy = normalizeStrategy(settings);
  const current = allocation.values.SGOV || 0;
  const first = current * strategy.qqqTrigger1SgovPct / 100;
  return {
    current,
    first,
    second: Math.max(0, current - first) * strategy.qqqTrigger2RemainingPct / 100,
  };
}

export function currentQldCycleId(snapshots, currentWeight, threshold, currentDate) {
  if (currentWeight < threshold) return null;
  let start = null;
  for (const snapshot of [...snapshots].sort((a, b) => String(a.snapshot_date).localeCompare(String(b.snapshot_date)))) {
    const values = Object.fromEntries(INVESTMENT_TICKERS.map(ticker => [ticker, 0]));
    for (const item of Array.isArray(snapshot.holdings) ? snapshot.holdings : []) {
      if (item.ticker in values) values[item.ticker] += n(item.quantity) * n(item.price);
    }
    const total = Object.values(values).reduce((sum, value) => sum + value, 0);
    const weight = total ? values.QLD / total * 100 : 0;
    if (weight >= threshold && !start) start = snapshot.snapshot_date;
    if (weight < threshold) start = null;
  }
  return `QLD:${start || currentDate}`;
}

export function benchmarkComparison(snapshots, benchmarkPoints) {
  const returns = [...snapshots]
    .filter(row => row.snapshot_date && Number.isFinite(Number(row.twr_daily_return)))
    .sort((a, b) => String(a.snapshot_date).localeCompare(String(b.snapshot_date)));
  let portfolioIndex = 1;
  const portfolio = new Map();
  for (const row of returns) {
    portfolioIndex *= 1 + Number(row.twr_daily_return);
    portfolio.set(String(row.snapshot_date), portfolioIndex);
  }
  const benchmark = new Map((benchmarkPoints || [])
    .map(point => [String(point.date), Number(point.value)])
    .filter(([, value]) => Number.isFinite(value) && value > 0));
  const dates = [...portfolio.keys()].filter(date => benchmark.has(date)).sort();
  if (!dates.length) return { available: false, points: [], startDate: null };
  const firstPortfolio = portfolio.get(dates[0]);
  const firstBenchmark = benchmark.get(dates[0]);
  const points = dates.map(date => {
    const portfolioValue = portfolio.get(date) / firstPortfolio * 100;
    const benchmarkValue = benchmark.get(date) / firstBenchmark * 100;
    return { date, portfolio: portfolioValue, benchmark: benchmarkValue, excess: portfolioValue / benchmarkValue - 1 };
  });
  return { available: true, points, startDate: dates[0] };
}

export function validateTransaction(input, currentState) {
  const type = input.trade_type;
  const quantity = n(input.quantity);
  const price = n(input.price);
  const amount = n(input.amount);
  if (!['BUY', 'SELL', 'DEPOSIT', 'WITHDRAW'].includes(type)) return '거래 유형을 확인하세요.';
  if ([quantity, price, amount].some(value => value < 0 || !Number.isFinite(value))) return '금액과 수량은 0 이상이어야 합니다.';
  if (['BUY', 'SELL'].includes(type) && (!input.ticker || quantity <= 0 || price <= 0)) return '종목, 수량, 단가를 확인하세요.';
  if (['DEPOSIT', 'WITHDRAW'].includes(type) && amount <= 0) return '금액을 확인하세요.';
  if (type === 'SELL') {
    const holding = currentState.holdings.find(item => item.ticker === input.ticker);
    if (!holding || quantity > holding.quantity + 1e-7) return '보유 수량보다 많이 매도할 수 없습니다.';
  }
  if (input.reason && !TRANSACTION_REASONS.includes(input.reason)) return '거래 사유를 확인하세요.';
  if (!['BUY', 'SELL'].includes(type) && input.reason) return '거래 사유는 매수·매도 거래에만 사용할 수 있습니다.';
  return null;
}

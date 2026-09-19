export const TARGET_DEFAULTS = Object.freeze({ QQQ: 10, QLD: 70, SGOV: 20 });
export const INVESTMENT_TICKERS = Object.freeze(['QQQ', 'QLD', 'SGOV']);

const n = value => Number(value) || 0;
const ascending = rows => [...rows].sort((a, b) => String(a.traded_at).localeCompare(String(b.traded_at)));

export function portfolioState(rows) {
  const holdings = new Map();
  let cash = 0;
  let deposits = 0;
  let withdrawals = 0;
  let realizedProfit = 0;

  for (const row of ascending(rows)) {
    const amount = n(row.amount);
    const fee = n(row.fee);
    const quantity = n(row.quantity);
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
      const acquisitionCost = amount + fee;
      cash -= acquisitionCost;
      holding.quantity += quantity;
      holding.cost += acquisitionCost;
      holding.totalBought += acquisitionCost;
    } else if (row.trade_type === 'SELL' && holding.quantity > 0) {
      const sold = Math.min(holding.quantity, quantity);
      const ratio = sold / holding.quantity;
      const removedCost = holding.cost * ratio;
      const netProceeds = quantity > 0 ? (amount - fee) * (sold / quantity) : 0;
      const gain = netProceeds - removedCost;
      holding.cost -= removedCost;
      holding.quantity -= sold;
      holding.realizedProfit += gain;
      realizedProfit += gain;
      cash += amount - fee;
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

export function qqqDrawdown(prices) {
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
    if (!first20 && drawdown <= -0.2 + 1e-10) first20 = point.date;
    if (!first30 && drawdown <= -0.3 + 1e-10) first30 = point.date;
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
  };
}

export function strategyAdvice({ drawdown, allocation }) {
  const qld = allocation.rows.find(row => row.ticker === 'QLD');
  if (qld && qld.currentWeight >= 85) {
    return {
      kind: 'RESET_TARGET',
      title: '목표 포트폴리오 복귀 조건 충족',
      detail: 'QQQ 10% · QLD 70% · SGOV 20%로 조정할 시점입니다.',
      moves: allocation.rows.map(row => ({ ticker: row.ticker, amount: row.difference })),
    };
  }
  if (drawdown?.stage === 2) {
    return {
      kind: 'QQQ_30',
      title: '2차 리밸런싱 조건 충족',
      detail: '남아 있는 SGOV를 QLD로 이동하는 전략 구간입니다.',
      amount: Math.min(allocation.values.SGOV || 0, allocation.total * 0.1),
    };
  }
  if (drawdown?.stage === 1) {
    return {
      kind: 'QQQ_20',
      title: '1차 리밸런싱 조건 충족',
      detail: 'SGOV 목표자산의 절반을 QLD로 이동하는 전략 구간입니다.',
      amount: Math.min(allocation.values.SGOV || 0, allocation.total * 0.1),
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

export function validateTransaction(input, currentState) {
  const type = input.trade_type;
  const quantity = n(input.quantity);
  const price = n(input.price);
  const amount = n(input.amount);
  const fee = n(input.fee);
  if (!['BUY', 'SELL', 'DEPOSIT', 'WITHDRAW'].includes(type)) return '거래 유형을 확인하세요.';
  if ([quantity, price, amount, fee].some(value => value < 0 || !Number.isFinite(value))) return '금액과 수량은 0 이상이어야 합니다.';
  if (['BUY', 'SELL'].includes(type) && (!input.ticker || quantity <= 0 || price <= 0)) return '종목, 수량, 단가를 확인하세요.';
  if (['DEPOSIT', 'WITHDRAW'].includes(type) && amount <= 0) return '금액을 확인하세요.';
  if (type === 'SELL') {
    const holding = currentState.holdings.find(item => item.ticker === input.ticker);
    if (!holding || quantity > holding.quantity + 1e-7) return '보유 수량보다 많이 매도할 수 없습니다.';
  }
  return null;
}

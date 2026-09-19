import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accountMetrics,
  allocationMetrics,
  maximumDrawdownFromReturns,
  portfolioState,
  qqqDrawdown,
  strategyAdvice,
  twrFromSnapshots,
  validateTransaction,
} from '../finance.js';

const row = (trade_type, ticker, quantity, price, amount, fee = 0, traded_at = '2026-01-01T00:00:00Z') => ({
  trade_type, ticker, quantity, price, amount, fee, traded_at,
});

test('평균원가와 실현손익을 계산한다', () => {
  const state = portfolioState([
    row('DEPOSIT', 'CASH', 0, 0, 2000),
    row('BUY', 'QQQ', 10, 100, 1000, 10, '2026-01-02T00:00:00Z'),
    row('SELL', 'QQQ', 4, 120, 480, 2, '2026-01-03T00:00:00Z'),
  ]);
  assert.equal(state.holdings[0].quantity, 6);
  assert.equal(state.holdings[0].cost, 606);
  assert.equal(state.realizedProfit, 74);
  assert.equal(state.cash, 1468);
});

test('계좌 손익은 순입금 원금과 비교한다', () => {
  const metrics = accountMetrics({ cash: 100, netContributions: 1000 }, [{ value: 1100 }]);
  assert.equal(metrics.equity, 1200);
  assert.equal(metrics.profit, 200);
  assert.equal(metrics.principalReturn, 0.2);
});

test('자산배분에서 현금을 제외한다', () => {
  const allocation = allocationMetrics([
    { ticker: 'QQQ', value: 100 }, { ticker: 'QLD', value: 700 }, { ticker: 'SGOV', value: 200 }, { ticker: 'CASH', value: 900 },
  ]);
  assert.equal(allocation.total, 1000);
  assert.deepEqual(allocation.rows.map(item => item.currentWeight), [10, 70, 20]);
});

test('TWR을 일별 수익률로 연결한다', () => {
  const result = twrFromSnapshots([
    { snapshot_date: '2026-01-01', twr_daily_return: 0.1 },
    { snapshot_date: '2026-01-02', twr_daily_return: -0.05 },
  ]);
  assert.ok(Math.abs(result.value - 0.045) < 1e-12);
});

test('TWR 성과지수에서 MDD를 계산한다', () => {
  const result = maximumDrawdownFromReturns([
    { snapshot_date: '2026-01-01', twr_daily_return: 0.1 },
    { snapshot_date: '2026-01-02', twr_daily_return: -0.2 },
    { snapshot_date: '2026-01-03', twr_daily_return: 0.1 },
  ]);
  assert.ok(Math.abs(result.value + 0.2) < 1e-12);
});

test('QQQ 트리거는 같은 사이클에서 한 번 결정되고 신고점에서 초기화된다', () => {
  const normal = qqqDrawdown([{ date: '1', close: 100 }, { date: '2', close: 90 }]);
  assert.equal(normal.stage, 0);
  const stage1 = qqqDrawdown([{ date: '1', close: 100 }, { date: '2', close: 80 }, { date: '3', close: 75 }, { date: '4', close: 79 }]);
  assert.equal(stage1.stage, 1);
  assert.equal(stage1.first20, '2');
  const stage2 = qqqDrawdown([{ date: '1', close: 100 }, { date: '2', close: 80 }, { date: '3', close: 70 }, { date: '4', close: 75 }, { date: '5', close: 70 }]);
  assert.equal(stage2.stage, 2);
  assert.equal(stage2.first30, '3');
  const reset = qqqDrawdown([{ date: '1', close: 100 }, { date: '2', close: 70 }, { date: '3', close: 101 }, { date: '4', close: 95 }]);
  assert.equal(reset.stage, 0);
  assert.equal(reset.peakDate, '3');
});

test('QLD 85% 조건이 QQQ 트리거보다 우선한다', () => {
  const below = allocationMetrics([{ ticker: 'QQQ', value: 51 }, { ticker: 'QLD', value: 849 }, { ticker: 'SGOV', value: 100 }]);
  assert.notEqual(strategyAdvice({ drawdown: { stage: 0 }, allocation: below }).kind, 'RESET_TARGET');
  const allocation = allocationMetrics([{ ticker: 'QQQ', value: 50 }, { ticker: 'QLD', value: 850 }, { ticker: 'SGOV', value: 100 }]);
  assert.equal(strategyAdvice({ drawdown: { stage: 2 }, allocation }).kind, 'RESET_TARGET');
});

test('보유 수량을 초과한 매도를 거부한다', () => {
  const state = portfolioState([row('BUY', 'QQQ', 2, 100, 200)]);
  assert.equal(validateTransaction({ trade_type: 'SELL', ticker: 'QQQ', quantity: 3, price: 110, amount: 330, fee: 0 }, state), '보유 수량보다 많이 매도할 수 없습니다.');
});

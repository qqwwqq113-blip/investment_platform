import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accountMetrics,
  allocationMetrics,
  benchmarkComparison,
  currentQldCycleId,
  maximumDrawdownFromReturns,
  nominalNasdaqExposure,
  normalizeStrategy,
  performanceForRange,
  portfolioState,
  qqqDrawdown,
  sgovCapacity,
  strategyAdvice,
  strategyExecutionStatus,
  strategyFromLegacyTargets,
  strategyTargets,
  twrFromSnapshots,
  validateTransaction,
  validateStrategy,
} from '../finance.js';
import { calculateMarketDrawdown, settlementBalance, validSettings as validServerSettings } from '../worker.js';

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
  assert.equal(state.holdings[0].cost, 600);
  assert.equal(state.realizedProfit, 80);
  assert.equal(state.cash, 1480);
});

test('거래 수수료는 포트폴리오 원가와 정산 잔액에서 제외한다', () => {
  const state = portfolioState([row('DEPOSIT', 'CASH', 0, 0, 1000), row('BUY', 'QLD', 10, 100, 1000, 25)]);
  assert.equal(state.cash, 0);
  assert.equal(state.holdings[0].cost, 1000);
});

test('종목 이동 후 남은 금액을 내부 정산 잔액으로 유지한다', () => {
  const rows = [
    row('DEPOSIT', 'CASH', 0, 0, 1000),
    row('BUY', 'SGOV', 10, 100, 1000, 5),
    row('SELL', 'SGOV', 5, 101, 505, 2),
    row('BUY', 'QLD', 5, 90, 450, 3),
  ];
  assert.equal(settlementBalance(rows), 55);
});

test('잔액 보정은 현금과 원금 반영 방식을 구분한다', () => {
  const state = portfolioState([
    row('DEPOSIT', 'CASH', 0, 0, 1000),
    { trade_type: 'ADJUSTMENT', traded_at: '2026-01-02T00:00:00Z', adjustment_amount: -5, contribution_delta: -5 },
    { trade_type: 'ADJUSTMENT', traded_at: '2026-01-03T00:00:00Z', adjustment_amount: 2, contribution_delta: 0 },
  ]);
  assert.equal(state.cash, 997);
  assert.equal(state.netContributions, 995);
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

test('선택 기간별 TWR과 MDD를 최신 스냅샷 기준으로 다시 계산한다', () => {
  const snapshots = [
    { snapshot_date: '2026-01-01', total_equity: 100, net_contributions: 100, twr_daily_return: null },
    { snapshot_date: '2026-10-01', total_equity: 120, net_contributions: 100, twr_daily_return: null },
    { snapshot_date: '2026-11-01', total_equity: 108, net_contributions: 100, twr_daily_return: null },
    { snapshot_date: '2026-11-20', total_equity: 118.8, net_contributions: 100, twr_daily_return: null },
  ];
  const month = performanceForRange(snapshots, '30');
  const all = performanceForRange(snapshots, 'ALL');
  assert.ok(Math.abs(month.value + 0.01) < 1e-12);
  assert.ok(Math.abs(month.mdd + 0.1) < 1e-12);
  assert.ok(Math.abs(all.value - 0.188) < 1e-12);
  assert.equal(month.startDate, '2026-11-01');
  assert.equal(month.observations, 2);
});

test('순입금 증가는 기간수익률로 잘못 계산하지 않는다', () => {
  const result = performanceForRange([
    { snapshot_date: '2026-01-01', total_equity: 100, net_contributions: 100, twr_daily_return: null },
    { snapshot_date: '2026-01-02', total_equity: 150, net_contributions: 150, twr_daily_return: null },
  ]);
  assert.equal(result.value, 0);
  assert.equal(result.derivedObservations, 1);
});

test('스냅샷 중단 후에는 새 TWR 측정 구간만 사용한다', () => {
  const snapshots = [
    { snapshot_date: '2026-10-03', twr_daily_return: 0.02, twr_coverage_start: '2026-09-20' },
    { snapshot_date: '2026-10-13', twr_daily_return: 0, twr_coverage_start: '2026-10-13' },
    { snapshot_date: '2026-10-14', twr_daily_return: 0.01, twr_coverage_start: '2026-10-13' },
  ];
  const twr = twrFromSnapshots(snapshots);
  const comparison = benchmarkComparison(snapshots, [
    { date: '2026-10-03', value: 100 },
    { date: '2026-10-13', value: 110 },
    { date: '2026-10-14', value: 111 },
  ]);
  assert.equal(twr.startDate, '2026-10-13');
  assert.ok(Math.abs(twr.value - 0.01) < 1e-12);
  assert.deepEqual(comparison.points.map(point => point.date), ['2026-10-13', '2026-10-14']);
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

test('서버 QQQ MDD는 9월 이전을 포함한 전체 가용 이력의 전고점을 사용한다', () => {
  const result = calculateMarketDrawdown([
    { date: '2026-08-15', close: 800, high: 810 },
    { date: '2026-09-01', close: 739.77, high: 745 },
    { date: '2026-11-20', close: 600 },
  ]);
  assert.equal(result.peak, 810);
  assert.equal(result.peakDate, '2026-08-15');
  assert.equal(result.historyStart, '2026-08-15');
  assert.equal(result.observations, 3);
  assert.equal(result.peakBasis, 'daily_high');
  assert.ok(Math.abs(result.current - (600 / 810 - 1)) < 1e-12);
});

test('QQQ 직전 최고는 종가가 아니라 해당 거래일의 일중 고가를 사용한다', () => {
  const result = calculateMarketDrawdown([
    { date: '2026-10-05', close: 756.2, high: 758.1 },
    { date: '2026-10-06', close: 759.66, high: 762.86 },
    { date: '2026-10-07', close: 757.73, high: 761.4 },
    { date: '2026-11-20', close: 608.45, high: 612.2 },
  ]);
  assert.equal(result.peak, 762.86);
  assert.equal(result.peakDate, '2026-10-06');
  assert.ok(Math.abs(result.current - (608.45 / 762.86 - 1)) < 1e-12);
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

test('전략 기본값과 사용자 목표 비중을 정규화한다', () => {
  assert.deepEqual(strategyTargets(normalizeStrategy({ targetQQQ: 20, targetQLD: 60, targetSGOV: 20 })), { QQQ: 20, QLD: 60, SGOV: 20 });
  assert.equal(normalizeStrategy({}).qqqTrigger1, -20);
});

test('기존 localStorage 목표 비중을 보존하고 손상값은 기본값으로 복구한다', () => {
  assert.deepEqual(strategyTargets(strategyFromLegacyTargets({ QQQ: 20, QLD: 60, SGOV: 20 })), { QQQ: 20, QLD: 60, SGOV: 20 });
  assert.deepEqual(strategyTargets(strategyFromLegacyTargets({ QQQ: 20, QLD: 60, SGOV: 10 })), { QQQ: 10, QLD: 70, SGOV: 20 });
});

test('전략 설정 순서와 범위를 검증한다', () => {
  assert.equal(validateStrategy({}), null);
  assert.match(validateStrategy({ targetQQQ: 20, targetQLD: 70, targetSGOV: 20 }), /100%/);
  assert.match(validateStrategy({ qqqTrigger1: -30, qqqTrigger2: -20 }), /더 깊어야/);
  assert.match(validateStrategy({ qqqTrigger1SgovPct: 120 }), /0~100%/);
  assert.equal(validServerSettings(normalizeStrategy({ targetQQQ: 20, targetQLD: 60, targetSGOV: 20 })), true);
  assert.equal(validServerSettings(normalizeStrategy({ qqqTrigger1: -30, qqqTrigger2: -20 })), false);
});

test('사용자 설정값으로 drawdown 단계와 SGOV 투입액을 계산한다', () => {
  const drawdown = qqqDrawdown([{ date: '1', close: 100 }, { date: '2', close: 82 }], { qqqTrigger1: -15, qqqTrigger2: -25 });
  assert.equal(drawdown.stage, 1);
  assert.equal(drawdown.cycleId, 'QQQ:1');
  const allocation = allocationMetrics([{ ticker: 'QQQ', value: 100 }, { ticker: 'QLD', value: 700 }, { ticker: 'SGOV', value: 300 }]);
  const capacity = sgovCapacity(allocation, { qqqTrigger1SgovPct: 40, qqqTrigger2RemainingPct: 100 });
  assert.deepEqual(capacity, { current: 300, first: 120, second: 180 });
});

test('동일 cycle의 사유 거래만 실행 완료로 연결한다', () => {
  const advice = { kind: 'QQQ_20', cycleId: 'QQQ:2026-01-01' };
  const rows = [
    { trade_type: 'BUY', reason: 'QQQ_DRAWDOWN_1', strategy_cycle_id: 'QQQ:2025-01-01' },
    { trade_type: 'BUY', reason: 'QQQ_DRAWDOWN_1', strategy_cycle_id: 'QQQ:2026-01-01' },
  ];
  const status = strategyExecutionStatus(advice, rows);
  assert.equal(status.executed, true);
  assert.equal(status.matches.length, 1);
  assert.equal(strategyExecutionStatus(advice, rows.slice(0, 1)).executed, false);
  const qldAdvice = { kind: 'RESET_TARGET', cycleId: 'QLD:2026-01-02' };
  assert.equal(strategyExecutionStatus(qldAdvice, [{ trade_type: 'SELL', reason: 'QLD_REBALANCE', strategy_cycle_id: 'QLD:2026-01-02' }]).executed, true);
});

test('Nasdaq 명목 노출은 CASH 제외 투자자산 비중을 사용한다', () => {
  const allocation = allocationMetrics([{ ticker: 'QQQ', value: 100 }, { ticker: 'QLD', value: 700 }, { ticker: 'SGOV', value: 200 }]);
  assert.equal(nominalNasdaqExposure(allocation), 1.5);
});

test('벤치마크는 공통 유효 시작일을 100으로 정규화한다', () => {
  const result = benchmarkComparison([
    { snapshot_date: '2026-01-01', twr_daily_return: null },
    { snapshot_date: '2026-01-02', twr_daily_return: 0.1 },
    { snapshot_date: '2026-01-03', twr_daily_return: -0.05 },
  ], [
    { date: '2026-01-02', value: 200 },
    { date: '2026-01-03', value: 220 },
  ]);
  assert.equal(result.startDate, '2026-01-02');
  assert.equal(result.points[0].portfolio, 100);
  assert.equal(result.points[0].benchmark, 100);
  assert.ok(Math.abs(result.points[1].portfolio - 95) < 1e-10);
  assert.ok(Math.abs(result.points[1].benchmark - 110) < 1e-10);
});

test('공통 벤치마크 관측값이 하나뿐이면 빈 추세선을 만들지 않는다', () => {
  const result = benchmarkComparison([
    { snapshot_date: '2026-01-01', total_equity: 100, net_contributions: 100, twr_daily_return: null },
    { snapshot_date: '2026-01-02', total_equity: 101, net_contributions: 100, twr_daily_return: null },
  ], [{ date: '2026-01-02', value: 200 }]);
  assert.equal(result.available, false);
  assert.equal(result.observations, 1);
  assert.deepEqual(result.points, []);
});

test('QLD 85% cycle은 기준 미만으로 복귀하기 전 최초 날짜를 유지한다', () => {
  const snapshots = [
    { snapshot_date: '2026-01-01', holdings: [{ ticker: 'QLD', quantity: 8, price: 10 }, { ticker: 'SGOV', quantity: 2, price: 10 }] },
    { snapshot_date: '2026-01-02', holdings: [{ ticker: 'QLD', quantity: 9, price: 10 }, { ticker: 'SGOV', quantity: 1, price: 10 }] },
    { snapshot_date: '2026-01-03', holdings: [{ ticker: 'QLD', quantity: 8.7, price: 10 }, { ticker: 'SGOV', quantity: 1.3, price: 10 }] },
  ];
  assert.equal(currentQldCycleId(snapshots, 87, 85, '2026-01-03'), 'QLD:2026-01-02');
  assert.equal(currentQldCycleId(snapshots, 80, 85, '2026-01-03'), null);
});

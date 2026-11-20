import test from 'node:test';
import assert from 'node:assert/strict';
import { alignHistories, allocationCandidates, maximumDrawdown, simulateStrategy, stressTest, xirr } from '../research.js';

const dates = Array.from({ length: 420 }, (_, index) => new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10));
const histories = {
  QQQ: dates.map((date, index) => ({ date, value: 100 * (1.0005 ** index) })),
  QLD: dates.map((date, index) => ({ date, value: 100 * (1.0008 ** index) })),
  SGOV: dates.map((date, index) => ({ date, value: 100 * (1.0001 ** index) })),
};

test('공통 거래일만 정렬한다', () => {
  const aligned = alignHistories({ A: [{ date: '2026-01-01', value: 1 }, { date: '2026-01-02', value: 2 }], B: [{ date: '2026-01-02', value: 3 }] }, ['A', 'B']);
  assert.deepEqual(aligned, [{ date: '2026-01-02', prices: { A: 2, B: 3 } }]);
});

test('외부 납입과 전략 성과를 분리해 TWR과 XIRR을 계산한다', () => {
  const result = simulateStrategy({ histories, weights: { QQQ: 10, QLD: 70, SGOV: 20 }, mode: 'mixed', initial: 10000, monthly: 500, feeRate: 0.1, taxRate: 15, rebalanceMonths: 12 });
  assert.ok(result.contributions > 10000);
  assert.ok(result.finalEquity > result.contributions);
  assert.ok(result.twr > 0);
  assert.ok(result.xirr > 0);
  assert.ok(result.fees > 0);
  assert.equal(result.assumptions.adjustedPrices, true);
});

test('MDD와 단순 충격을 계산한다', () => {
  assert.equal(maximumDrawdown([100, 120, 90, 110]), -0.25);
  const stressed = stressTest({ finalEquity: 10000 }, { QQQ: 50, QLD: 50 }, { QQQ: -20, QLD: -40 });
  assert.ok(Math.abs(stressed.impact + 0.3) < 1e-12);
  assert.ok(Math.abs(stressed.stressedEquity - 7000) < 1e-9);
});

test('10% 단계 자산배분 후보는 합계 100을 유지한다', () => {
  const candidates = allocationCandidates(10);
  assert.equal(candidates.length, 66);
  assert.ok(candidates.every(item => item.QQQ + item.QLD + item.SGOV === 100));
});

test('XIRR은 단순 1년 두 배 현금흐름에서 약 100%다', () => {
  const value = xirr([{ date: '2024-01-01', amount: -100 }, { date: '2025-01-01', amount: 200 }]);
  assert.ok(Math.abs(value - 1) < 0.01);
});

import { allocationCandidates, simulateStrategy } from './research.js';

let cancelled = false;
self.onmessage = async event => {
  if (event.data?.type === 'cancel') { cancelled = true; return; }
  if (event.data?.type !== 'start') return;
  cancelled = false;
  const { histories, base } = event.data;
  const jobs = allocationCandidates(10).flatMap(weights => [3, 12].flatMap(rebalanceMonths => [false, true].map(drawdownRule => ({ weights, rebalanceMonths, drawdownRule }))));
  const results = [];
  for (let index = 0; index < jobs.length; index += 1) {
    if (cancelled) { self.postMessage({ type: 'cancelled', completed: index, total: jobs.length }); return; }
    const job = jobs[index];
    try {
      const result = simulateStrategy({ ...base, histories, ...job });
      results.push({ ...job, score: result.sharpe - Math.abs(result.mdd) * 0.5, metrics: { cagr: result.cagr, mdd: result.mdd, sharpe: result.sharpe, finalEquity: result.finalEquity } });
    } catch {}
    if (index % 10 === 0) { self.postMessage({ type: 'progress', completed: index + 1, total: jobs.length }); await new Promise(resolve => setTimeout(resolve, 0)); }
  }
  results.sort((a, b) => b.score - a.score);
  self.postMessage({ type: 'complete', total: jobs.length, results: results.slice(0, 5) });
};

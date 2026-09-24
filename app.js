import {
  STRATEGY_DEFAULTS,
  accountMetrics,
  allocationMetrics,
  benchmarkComparison,
  currentQldCycleId,
  enrichHoldings,
  maximumDrawdownFromReturns,
  nominalNasdaqExposure,
  normalizeStrategy,
  portfolioState,
  sgovCapacity,
  strategyAdvice,
  strategyExecutionStatus,
  strategyFromLegacyTargets,
  strategyTargets,
  twrFromSnapshots,
  validateTransaction,
  validateStrategy,
} from './finance.js';

const $ = id => document.getElementById(id);
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const num = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 6 });
const colors = { QQQ: '#64a4ff', QLD: '#f5a524', SGOV: '#44c18a', CASH: '#8fa3b8' };
const tradeNames = { BUY: '매수', SELL: '매도', DEPOSIT: '입금', WITHDRAW: '출금' };
const reasonNames = { REGULAR_BUY: '정기매수', QQQ_DRAWDOWN_1: 'QQQ 1차 대응', QQQ_DRAWDOWN_2: 'QQQ 2차 대응', QLD_REBALANCE: 'QLD 복귀', NEW_CAPITAL: '신규자금', OTHER: '기타' };
let range = 'ALL';
let performanceView = 'value';
let cache = { rows: [], snaps: [], holdings: [], state: null, allocation: null, drawdown: null, advice: null, settings: { ...STRATEGY_DEFAULTS }, benchmark: { basis: null, points: [] } };
let quotes = {};
let quotesFetchedAt = null;
let editingId = null;
let toastTimer = null;
let sessionToken = new URLSearchParams(location.hash.slice(1)).get('session') || '';
if (sessionToken) history.replaceState(null, '', location.pathname);

function api(path, { method = 'GET', body } = {}) {
  return new Promise(resolve => {
    const request = new XMLHttpRequest();
    request.open(method, path, true);
    request.timeout = 20000;
    request.setRequestHeader('Content-Type', 'application/json');
    if (sessionToken) request.setRequestHeader('X-Portfolio-Session', sessionToken);
    request.onload = () => {
      let data = null;
      try { data = request.status === 204 ? null : JSON.parse(request.responseText); } catch {}
      resolve(request.status >= 200 && request.status < 300
        ? { data, status: request.status }
        : { error: { message: data?.error || `HTTP ${request.status}` }, status: request.status });
    };
    request.onerror = request.ontimeout = () => resolve({ error: { message: '네트워크 연결을 확인하세요.' }, status: 0 });
    request.send(body === undefined ? null : JSON.stringify(body));
  });
}

const notice = (text, error = false) => { $('notice').textContent = text; $('notice').classList.toggle('error', error); };
function toast(text, error = false) {
  const element = $('toast');
  clearTimeout(toastTimer);
  element.textContent = text;
  element.classList.toggle('error', error);
  element.classList.add('visible');
  toastTimer = setTimeout(() => element.classList.remove('visible'), 4000);
}
const signed = value => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;
const now = () => {
  const date = new Date();
  const formatter = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  return formatter.format(date).replace(' ', 'T');
};
function targets() {
  return strategyTargets(cache.settings);
}

function localStrategyFallback() {
  try {
    const saved = JSON.parse(localStorage.getItem('portfolio_target_allocations') || 'null');
    return strategyFromLegacyTargets(saved);
  } catch { return { ...STRATEGY_DEFAULTS }; }
}

function filtered(snaps) {
  if (range === 'ALL') return snaps;
  const today = new Date();
  const start = range === 'YTD' ? new Date(today.getFullYear(), 0, 1) : new Date(today.getTime() - Number(range) * 86400000);
  return snaps.filter(item => new Date(`${item.snapshot_date}T00:00:00+09:00`) >= start);
}

function donut(id, items, label, centerText) {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const visible = items.filter(item => item.value > 0);
  if (!total || !visible.length) { $(id).innerHTML = '<p class="empty">표시할 자산이 없습니다.</p>'; return; }
  let at = 0;
  const stops = visible.map(item => {
    const start = at;
    at += item.value / total * 100;
    return `${colors[item.ticker] || '#7f8ea3'} ${start.toFixed(2)}% ${at.toFixed(2)}%`;
  }).join(', ');
  $(id).innerHTML = `<div class="donut" style="background:conic-gradient(${stops})"><div><strong>${label}</strong><span>${centerText}</span></div></div><ul class="legend">${visible.map(item => `<li><i style="background:${colors[item.ticker] || '#7f8ea3'}"></i><span>${item.ticker}</span><b>${(item.value / total * 100).toFixed(1)}%</b></li>`).join('')}</ul>`;
}

function attachTooltip(chart, points, markup) {
  const tip = document.createElement('div');
  tip.className = 'chart-tooltip';
  chart.append(tip);
  const show = event => {
    const rect = chart.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const index = points.length === 1 ? 0 : Math.round(ratio * (points.length - 1));
    tip.innerHTML = markup(points[index]);
    const half = Math.min(100, rect.width / 2 - 8);
    const x = Math.max(half, Math.min(rect.width - half, ratio * rect.width));
    tip.style.left = `${x}px`;
    tip.classList.add('visible');
  };
  ['pointermove', 'pointerenter', 'pointerdown'].forEach(name => chart.addEventListener(name, show));
  ['pointerleave', 'pointerup', 'pointercancel'].forEach(name => chart.addEventListener(name, () => tip.classList.remove('visible')));
}

function renderPerformance(snaps) {
  const points = filtered([...snaps].sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date)));
  const chart = $('history-chart');
  const twr = twrFromSnapshots(points);
  const mdd = maximumDrawdownFromReturns(points);
  $('period-twr').textContent = twr.available ? signed(twr.value) : '측정 준비 중';
  $('performance-twr').textContent = twr.available ? signed(twr.value) : '—';
  $('performance-mdd').textContent = mdd.available ? signed(mdd.value) : '—';
  $('twr-coverage').textContent = twr.available ? `${twr.startDate}부터 측정` : '정확한 측정 데이터가 아직 없습니다.';
  if (!points.length) { chart.innerHTML = '<p class="empty">선택한 기간의 스냅샷이 없습니다.</p>'; renderBenchmark(); return; }
  const values = points.flatMap(point => [Number(point.total_equity), Number(point.net_contributions ?? point.total_cost)]);
  const lo = Math.min(...values), hi = Math.max(...values), pad = Math.max((hi - lo) * 0.12, 1);
  const w = 720, h = 250, x = index => points.length === 1 ? w / 2 : 26 + index * (w - 52) / (points.length - 1);
  const y = value => 18 + (hi + pad - value) * (h - 50) / (hi + pad - (lo - pad));
  const path = key => points.map((point, index) => `${index ? 'L' : 'M'} ${x(index).toFixed(1)} ${y(Number(key(point))).toFixed(1)}`).join(' ');
  const equityValue = point => point.total_equity;
  const principalValue = point => point.net_contributions ?? point.total_cost;
  chart.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path d="${path(equityValue)}" fill="none" stroke="#64a4ff" stroke-width="3"/><path d="${path(principalValue)}" fill="none" stroke="#f5a524" stroke-width="2.5" stroke-dasharray="7 5"/>${points.map((point, index) => `<circle cx="${x(index)}" cy="${y(Number(point.total_equity))}" r="${index === points.length - 1 ? 4.5 : 2.3}" fill="#cfe4ff"/>`).join('')}</svg>`;
  attachTooltip(chart, points, point => {
    const principal = Number(point.net_contributions ?? point.total_cost);
    const profit = Number(point.total_equity) - principal;
    const rate = principal > 0 ? profit / principal : null;
    return `<b>${point.snapshot_date}</b><div>평가액 <b>${usd.format(Number(point.total_equity))}</b></div><div>순입금 원금 <b>${usd.format(principal)}</b></div><div>평가손익 <b>${profit >= 0 ? '+' : ''}${usd.format(profit)}</b></div><div>원금 대비 <b>${rate === null ? '—' : signed(rate)}</b></div>`;
  });
  const last = points.at(-1), principal = Number(last.net_contributions ?? last.total_cost), profit = Number(last.total_equity) - principal;
  $('history-summary').textContent = `${last.snapshot_date} 기준 · 평가손익 ${profit >= 0 ? '+' : ''}${usd.format(profit)}`;
  renderBenchmark();
}

function renderBenchmark() {
  $('value-chart-panel').classList.toggle('hidden', performanceView !== 'value');
  $('benchmark-chart-panel').classList.toggle('hidden', performanceView !== 'benchmark');
  if (performanceView !== 'benchmark') return;
  const chart = $('benchmark-chart');
  const snaps = filtered([...cache.snaps].sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date)));
  const comparison = benchmarkComparison(snaps, cache.benchmark.points);
  const basisLabel = cache.benchmark.basis === 'adjusted_close' ? '배당 반영 QQQ' : 'QQQ 가격수익률';
  $('benchmark-label').textContent = basisLabel;
  $('benchmark-summary').textContent = comparison.available ? `${comparison.startDate} 공통 시작일 = 100 · ${basisLabel}` : '공통 유효 기간의 벤치마크 데이터가 없습니다.';
  if (!comparison.available) { chart.innerHTML = '<p class="empty">비교 가능한 데이터가 없습니다.</p>'; return; }
  const points = comparison.points, w = 720, h = 250;
  const values = points.flatMap(point => [point.portfolio, point.benchmark]);
  const lo = Math.min(...values), hi = Math.max(...values), pad = Math.max((hi - lo) * 0.12, 1);
  const x = index => points.length === 1 ? w / 2 : 26 + index * (w - 52) / (points.length - 1);
  const y = value => 18 + (hi + pad - value) * (h - 50) / (hi + pad - (lo - pad));
  const path = key => points.map((point, index) => `${index ? 'L' : 'M'} ${x(index).toFixed(1)} ${y(point[key]).toFixed(1)}`).join(' ');
  chart.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path d="${path('portfolio')}" fill="none" stroke="#64a4ff" stroke-width="3"/><path d="${path('benchmark')}" fill="none" stroke="#c28cff" stroke-width="2.5"/></svg>`;
  attachTooltip(chart, points, point => `<b>${point.date}</b><div>Portfolio <b>${point.portfolio.toFixed(1)} (${signed(point.portfolio / 100 - 1)})</b></div><div>${basisLabel} <b>${point.benchmark.toFixed(1)} (${signed(point.benchmark / 100 - 1)})</b></div><div>초과성과 <b>${signed(point.excess)}</b></div>`);
}

function renderAllocationHistory(snaps) {
  const points = filtered([...snaps].sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date)));
  const chart = $('allocation-history-chart'), tickers = ['QQQ', 'QLD', 'SGOV', 'CASH'];
  if (!points.length) { chart.innerHTML = '<p class="empty">선택한 기간의 스냅샷이 없습니다.</p>'; return; }
  const w = 720, h = 220, x = index => points.length === 1 ? w / 2 : 18 + index * (w - 36) / (points.length - 1);
  const weights = points.map(snapshot => {
    const data = Object.fromEntries(tickers.map(ticker => [ticker, 0]));
    (Array.isArray(snapshot.holdings) ? snapshot.holdings : []).forEach(item => { if (item.ticker in data) data[item.ticker] += Number(item.quantity) * Number(item.price); });
    data.CASH = Number(snapshot.cash_balance) || 0;
    const total = Object.values(data).reduce((a, b) => a + b, 0) || 1;
    return Object.fromEntries(tickers.map(ticker => [ticker, data[ticker] / total * 100]));
  });
  const area = ticker => {
    const index = tickers.indexOf(ticker);
    const top = weights.map((row, i) => [x(i), h - 12 - tickers.slice(0, index + 1).reduce((sum, key) => sum + row[key], 0) / 100 * (h - 24)]);
    const bottom = [...weights].reverse().map((row, reverseIndex) => { const i = weights.length - 1 - reverseIndex; return [x(i), h - 12 - tickers.slice(0, index).reduce((sum, key) => sum + row[key], 0) / 100 * (h - 24)]; });
    return `M ${top.map(pair => pair.join(' ')).join(' L ')} L ${bottom.map(pair => pair.join(' ')).join(' L ')} Z`;
  };
  chart.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${tickers.map(ticker => `<path d="${area(ticker)}" fill="${colors[ticker]}" fill-opacity=".78" stroke="#08111f"/>`).join('')}</svg>`;
  attachTooltip(chart, points.map((snapshot, index) => ({ snapshot, weight: weights[index] })), item => `<b>${item.snapshot.snapshot_date}</b>${tickers.map(ticker => `<div>${ticker === 'CASH' ? '현금' : ticker} <b>${item.weight[ticker].toFixed(1)}%</b></div>`).join('')}`);
  const last = weights.at(-1);
  $('allocation-history-summary').textContent = `${points.at(-1).snapshot_date} 기준 · ${tickers.map(ticker => `${ticker} ${last[ticker].toFixed(1)}%`).join(' · ')}`;
}

function holdingSummary(item, total) {
  return `<article class="holding-row"><div><strong>${item.ticker}</strong><span>${num.format(item.quantity)}주 · 평균 ${usd.format(item.averagePrice)}${item.currentPrice !== null ? ` · 현재 ${usd.format(item.currentPrice)}` : ''}</span></div><div><strong>${usd.format(item.value)}</strong><span class="${item.unrealizedProfit >= 0 ? 'positive' : 'negative'}">${item.unrealizedProfit >= 0 ? '+' : ''}${usd.format(item.unrealizedProfit)} · 비중 ${(total ? item.value / total * 100 : 0).toFixed(1)}%</span></div></article>`;
}

function renderPortfolio(holdings, rows, total) {
  $('holding-preview').innerHTML = holdings.slice(0, 3).map(item => holdingSummary(item, total)).join('') || '<p class="empty">보유 종목이 없습니다.</p>';
  $('holdings-cards').innerHTML = holdings.map(item => {
    const recent = rows.filter(row => row.ticker === item.ticker).slice(0, 5);
    return `<details class="holding-detail"><summary>${holdingSummary(item, total)}<span class="detail-cue">상세 보기</span></summary><div class="holding-metrics"><div><span>평가액</span><strong>${usd.format(item.value)}</strong></div><div><span>보유수량</span><strong>${num.format(item.quantity)}주</strong></div><div><span>평균매입가</span><strong>${usd.format(item.averagePrice)}</strong></div><div><span>현재가격</span><strong>${item.currentPrice === null ? '—' : usd.format(item.currentPrice)}</strong></div><div><span>평가손익률</span><strong class="${item.unrealizedReturn >= 0 ? 'positive' : 'negative'}">${signed(item.unrealizedReturn)}</strong></div><div><span>포트폴리오 비중</span><strong>${(total ? item.value / total * 100 : 0).toFixed(1)}%</strong></div><div><span>총 매수금액</span><strong>${usd.format(item.totalBought)}</strong></div><div><span>실현손익</span><strong class="${item.realizedProfit >= 0 ? 'positive' : 'negative'}">${item.realizedProfit >= 0 ? '+' : ''}${usd.format(item.realizedProfit)}</strong></div></div><div class="ticker-transactions"><h3>${item.ticker} 최근 거래</h3>${recent.map(transactionLine).join('') || '<p class="empty small">거래가 없습니다.</p>'}<button class="ghost ticker-all" data-ticker-jump="${item.ticker}">전체 거래 보기</button></div></details>`;
  }).join('') || '<p class="empty">보유 종목이 없습니다.</p>';
}

function transactionLine(row) {
  const unit = ['BUY', 'SELL'].includes(row.trade_type) ? ` · ${usd.format(Number(row.price))}` : '';
  return `<article class="transaction-line"><span>${new Date(row.traded_at).toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit', timeZone: 'Asia/Seoul' })}</span><b>${tradeNames[row.trade_type]}</b><strong>${row.ticker === 'CASH' ? '' : row.ticker}${unit}</strong><em>${usd.format(Number(row.amount))}</em></article>`;
}

function renderTransactions() {
  const period = $('filter-period').value, ticker = $('filter-ticker').value, type = $('filter-type').value, reason = $('filter-reason').value;
  const after = period === 'ALL' ? null : Date.now() - Number(period) * 86400000;
  const rows = cache.rows.filter(row => (!after || new Date(row.traded_at).getTime() >= after) && (ticker === 'ALL' || row.ticker === ticker) && (type === 'ALL' || row.trade_type === type)
    && (reason === 'ALL' || (reason === 'NONE' ? !row.reason : row.reason === reason)));
  $('transaction-count').textContent = `총 ${rows.length}건`;
  $('recent-transactions').innerHTML = cache.rows.slice(0, 5).map(transactionLine).join('') || '<p class="empty">아직 저장된 거래가 없습니다.</p>';
  $('transactions-list').innerHTML = rows.length ? `<table><thead><tr><th>일시</th><th>구분</th><th>종목</th><th>사유</th><th>수량</th><th>단가</th><th>금액</th><th>수수료</th><th></th></tr></thead><tbody>${rows.map(row => `<tr><td data-label="일시">${new Date(row.traded_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</td><td data-label="구분">${tradeNames[row.trade_type]}</td><td data-label="종목">${row.ticker}</td><td data-label="사유">${reasonNames[row.reason] || '—'}</td><td data-label="수량">${num.format(row.quantity)}</td><td data-label="단가">${['BUY', 'SELL'].includes(row.trade_type) ? usd.format(Number(row.price)) : '—'}</td><td data-label="금액">${usd.format(Number(row.amount))}</td><td data-label="수수료">${usd.format(Number(row.fee))}</td><td class="row-actions"><button class="more-button" aria-label="거래 메뉴" data-menu="${row.id}">⋮</button><div class="row-menu" data-menu-panel="${row.id}"><button data-edit="${row.id}">수정</button><button class="danger-text" data-delete="${row.id}">삭제</button></div></td></tr>`).join('')}</tbody></table>` : '<p class="empty">조건에 맞는 거래가 없습니다.</p>';
}

function renderStrategy(allocation) {
  const drawdown = cache.drawdown;
  const latestDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
  const qldWeight = allocation.rows.find(row => row.ticker === 'QLD')?.currentWeight || 0;
  const qldCycleId = currentQldCycleId(cache.snaps, qldWeight, cache.settings.qldRebalanceTrigger, latestDate);
  const advice = strategyAdvice({ drawdown, allocation, settings: cache.settings, qldCycleId });
  const execution = strategyExecutionStatus(advice, cache.rows);
  $('qqq-drawdown').textContent = drawdown ? signed(drawdown.current) : '데이터 없음';
  $('qqq-peak').textContent = drawdown ? `직전 최고 ${usd.format(drawdown.peak)} · ${drawdown.peakDate}` : 'QQQ 가격 이력을 불러오지 못했습니다.';
  $('strategy-title').textContent = advice.kind === 'NORMAL' ? '없음' : advice.title;
  $('strategy-detail').textContent = `${advice.detail}${execution.required ? ` · 실행 여부: ${execution.executed ? '기록 있음' : '미실행'}` : ''}`;
  $('strategy-pill').textContent = advice.kind === 'NORMAL' ? '정상' : '전략 점검';
  $('strategy-pill').classList.toggle('warning', advice.kind !== 'NORMAL');
  const action = $('strategy-action');
  if (advice.kind === 'QQQ_20' || advice.kind === 'QQQ_30') {
    action.innerHTML = `<strong>권장 전략</strong><span>SGOV → QLD 약 ${usd.format(advice.amount)}</span>`;
    action.classList.remove('hidden');
  } else if (advice.kind === 'RESET_TARGET') {
    action.innerHTML = `<strong>목표 포트폴리오 복귀</strong>${advice.moves.map(move => `<span>${move.ticker} ${move.amount >= 0 ? '추가' : '축소'} 약 ${usd.format(Math.abs(move.amount))}</span>`).join('')}`;
    action.classList.remove('hidden');
  } else action.classList.add('hidden');
  const capacity = sgovCapacity(allocation, cache.settings);
  $('nasdaq-exposure').textContent = `${nominalNasdaqExposure(allocation).toFixed(2)}배`;
  $('sgov-capacity').textContent = usd.format(capacity.current);
  $('sgov-capacity-detail').textContent = `1차 ${cache.settings.qqqTrigger1}%: ${usd.format(capacity.first)} · 2차 ${cache.settings.qqqTrigger2}%: ${usd.format(capacity.second)}`;
  const qld = allocation.rows.find(row => row.ticker === 'QLD')?.currentWeight || 0;
  const mdd = maximumDrawdownFromReturns(filtered(cache.snaps));
  $('risk-summary').textContent = `MDD ${mdd.available ? signed(mdd.value) : '—'}`;
  $('risk-detail').textContent = `QQQ ${drawdown ? signed(drawdown.current) : '—'} · QLD ${qld.toFixed(1)}% / ${cache.settings.qldRebalanceTrigger}%`;
  cache.advice = advice;
  return advice;
}

function renderAllocation(holdings) {
  const target = targets();
  const allocation = allocationMetrics(holdings, target);
  donut('current-donut', allocation.rows.map(row => ({ ticker: row.ticker, value: row.value })), '현재', usd.format(allocation.total));
  donut('target-donut', Object.entries(target).map(([ticker, value]) => ({ ticker, value })), '목표', '100%');
  $('allocation-body').innerHTML = allocation.rows.map(row => `<tr><td>${row.ticker}</td><td>${row.currentWeight.toFixed(1)}%</td><td>${row.targetWeight.toFixed(1)}%</td><td class="${Math.abs(row.drift) > 5 ? 'drift-alert' : ''}">${row.drift >= 0 ? '+' : ''}${row.drift.toFixed(1)}%p</td><td>${row.difference > 0 ? `신규 투자금 약 ${usd.format(row.difference)} 우선` : '추가 매도 신호 없음'}</td></tr>`).join('');
  const alerts = allocation.rows.filter(row => Math.abs(row.drift) > 5).length;
  $('allocation-status').textContent = alerts ? `편차 확인 ${alerts}개` : '목표에 근접';
  $('allocation-status').classList.toggle('warning', Boolean(alerts));
  const advice = renderStrategy(allocation);
  $('contribution-advice').textContent = advice.kind === 'NORMAL' ? advice.detail : '전략 조건이 충족되어 위 전략 안내를 우선합니다.';
  Object.entries(target).forEach(([ticker, value]) => { $(`target-${ticker.toLowerCase()}`).value = value; });
  $('trigger-1').value = cache.settings.qqqTrigger1;
  $('trigger-1-sgov').value = cache.settings.qqqTrigger1SgovPct;
  $('trigger-2').value = cache.settings.qqqTrigger2;
  $('trigger-2-sgov').value = cache.settings.qqqTrigger2RemainingPct;
  $('qld-trigger').value = cache.settings.qldRebalanceTrigger;
  validateTargetForm(false);
  cache.allocation = allocation;
  return allocation;
}

function render() {
  const state = portfolioState(cache.rows);
  const holdings = enrichHoldings(state, quotes);
  const hasLive = holdings.length > 0 && holdings.every(item => item.currentPrice !== null);
  const account = accountMetrics(state, holdings);
  const last = [...cache.snaps].sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date)).at(-1);
  const equity = hasLive || !last ? account.equity : Number(last.total_equity);
  const profit = equity - state.netContributions;
  const returnRate = state.netContributions > 0 ? profit / state.netContributions : null;
  $('total-equity').textContent = usd.format(equity);
  $('total-profit').textContent = `${profit >= 0 ? '+' : ''}${usd.format(profit)}`;
  $('total-return').textContent = returnRate === null ? '—' : signed(returnRate);
  $('cash-weight').textContent = `${(equity > 0 ? state.cash / equity * 100 : 0).toFixed(1)}%`;
  ['total-profit', 'total-return'].forEach(id => { $(id).classList.toggle('positive', profit >= 0); $(id).classList.toggle('negative', profit < 0); });
  $('equity-label').textContent = hasLive ? '실시간 평가자산' : '최근 평가자산';
  $('profit-label').textContent = hasLive ? '실시간 평가손익' : '최근 평가손익';
  $('as-of').textContent = hasLive ? `Yahoo Finance · ${new Date(quotesFetchedAt).toLocaleString('ko-KR')} 기준` : last ? `최근 평가 기준일 ${last.snapshot_date}` : '거래 기록 기준';
  $('status-summary').textContent = `순입금 원금 ${usd.format(state.netContributions)} 대비 ${profit >= 0 ? '수익' : '손실'} ${profit >= 0 ? '+' : ''}${usd.format(profit)}`;
  const allocation = renderAllocation(holdings);
  renderPerformance(cache.snaps);
  renderAllocationHistory(cache.snaps);
  renderPortfolio(holdings, cache.rows, allocation.total);
  cache = { ...cache, state, holdings };
  populateFilters();
  renderTransactions();
}

function populateFilters() {
  const selected = $('filter-ticker').value;
  const tickers = [...new Set(cache.rows.map(row => row.ticker))].sort();
  $('filter-ticker').innerHTML = '<option value="ALL">전체 종목</option>' + tickers.map(ticker => `<option value="${ticker}">${ticker === 'CASH' ? '현금' : ticker}</option>`).join('');
  $('filter-ticker').value = tickers.includes(selected) ? selected : 'ALL';
}

async function loadQuotes(rows) {
  const tickers = portfolioState(rows).holdings.map(item => item.ticker);
  if (!tickers.length) { quotes = {}; quotesFetchedAt = null; return; }
  const { data, error } = await api('/api/quotes', { method: 'POST', body: { tickers } });
  if (error || !Array.isArray(data?.quotes)) { quotes = {}; quotesFetchedAt = null; return; }
  quotes = Object.fromEntries(data.quotes.filter(item => Number.isFinite(Number(item.price))).map(item => [item.ticker, item]));
  quotesFetchedAt = data.fetchedAt || new Date().toISOString();
}

async function load() {
  notice('불러오는 중…');
  const settingsResponse = await api('/api/settings');
  if (settingsResponse.status === 401) { showAuth(); return; }
  let settingsWarning = '';
  let settings = settingsResponse.error ? localStrategyFallback() : settingsResponse.data?.settings;
  if (settingsResponse.error) settingsWarning = `전략 설정을 불러오지 못해 이 기기의 저장값을 사용합니다: ${settingsResponse.error.message}`;
  if (!settingsResponse.error && !settings) {
    const migrationResponse = await api('/api/settings', { method: 'PUT', body: { ...localStrategyFallback(), createOnly: true } });
    if (migrationResponse.error) {
      settings = localStrategyFallback();
      settingsWarning = `기존 목표 비중을 DB에 이전하지 못해 이 기기의 저장값을 사용합니다: ${migrationResponse.error.message}`;
    } else settings = migrationResponse.data.settings;
  }
  cache.settings = normalizeStrategy(settings);
  localStorage.setItem('portfolio_target_allocations', JSON.stringify(strategyTargets(cache.settings)));
  const [portfolioResponse, strategyResponse, benchmarkResponse] = await Promise.all([api('/api/data'), api('/api/strategy'), api('/api/benchmark')]);
  if (portfolioResponse.status === 401) { showAuth(); return; }
  if (portfolioResponse.error) { notice(`데이터를 불러오지 못했습니다: ${portfolioResponse.error.message}`, true); return; }
  cache.rows = portfolioResponse.data.transactions || [];
  cache.snaps = portfolioResponse.data.snapshots || [];
  cache.drawdown = strategyResponse.data?.drawdown || null;
  cache.benchmark = benchmarkResponse.data || { basis: null, points: [] };
  await loadQuotes(cache.rows);
  render();
  notice(settingsWarning, Boolean(settingsWarning));
}

function page(name) {
  document.querySelectorAll('.page').forEach(element => element.classList.toggle('active', element.id === `page-${name}`));
  document.querySelectorAll('[data-page]').forEach(element => element.classList.toggle('active', element.dataset.page === name));
}
function trade(type) {
  $('trade-type').value = type;
  const isCash = ['DEPOSIT', 'WITHDRAW'].includes(type);
  document.querySelectorAll('.trade-type').forEach(element => element.classList.toggle('active', element.dataset.type === type));
  document.querySelectorAll('.stock-field').forEach(element => element.classList.toggle('hidden', isCash));
  document.querySelectorAll('.reason-field').forEach(element => element.classList.toggle('hidden', isCash));
  $('ticker').required = !isCash;
  $('quantity').required = !isCash;
  $('price-label').textContent = isCash ? '금액' : '단가';
  if (isCash) { $('quantity').value = '0'; $('fee').value = '0'; $('reason').value = ''; }
}
function resetForm() {
  editingId = null;
  $('transaction-form').reset();
  $('traded-at').value = now();
  $('transaction-form-title').textContent = '거래 추가';
  $('cancel-edit').classList.add('hidden');
  trade('BUY');
}
function startEdit(id) {
  const row = cache.rows.find(item => item.id === id);
  if (!row) return;
  editingId = id;
  page('transactions');
  $('transaction-form-title').textContent = '거래 수정';
  $('cancel-edit').classList.remove('hidden');
  trade(row.trade_type);
  $('traded-at').value = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(row.traded_at)).replace(' ', 'T');
  if (!['DEPOSIT', 'WITHDRAW'].includes(row.trade_type)) $('ticker').value = row.ticker;
  $('quantity').value = row.quantity;
  $('price').value = row.price;
  $('fee').value = row.fee;
  $('reason').value = row.reason || '';
  $('memo').value = row.memo || '';
  $('transaction-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function showAuth() { $('auth-card').classList.remove('hidden'); $('dashboard').classList.add('hidden'); $('sign-out').classList.add('hidden'); $('password').focus(); }
function showDashboard() { $('auth-card').classList.add('hidden'); $('dashboard').classList.remove('hidden'); $('sign-out').classList.remove('hidden'); }

function strategyFormValue() {
  return {
    targetQQQ: Number($('target-qqq').value), targetQLD: Number($('target-qld').value), targetSGOV: Number($('target-sgov').value),
    qqqTrigger1: Number($('trigger-1').value), qqqTrigger1SgovPct: Number($('trigger-1-sgov').value),
    qqqTrigger2: Number($('trigger-2').value), qqqTrigger2RemainingPct: Number($('trigger-2-sgov').value),
    qldRebalanceTrigger: Number($('qld-trigger').value),
  };
}
function validateTargetForm(updateMessage = true) {
  const form = strategyFormValue();
  const values = [form.targetQQQ, form.targetQLD, form.targetSGOV];
  const sum = values.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  $('target-total').textContent = `${sum}%`;
  const error = validateStrategy(form);
  const valid = !error;
  $('target-save').disabled = !valid;
  if (updateMessage) $('target-message').textContent = valid ? '저장할 수 있는 설정입니다.' : error;
  $('target-message').classList.toggle('error', !valid);
  return valid;
}

$('traded-at').value = now();
$('auth-form').onsubmit = null;
$('sign-out').onclick = async () => { await api('/api/session', { method: 'DELETE' }); sessionToken = ''; showAuth(); };
document.querySelectorAll('[data-page],[data-page-link]').forEach(element => { element.onclick = () => page(element.dataset.page || element.dataset.pageLink); });
document.querySelectorAll('[data-range]').forEach(element => { element.onclick = () => { range = element.dataset.range; document.querySelectorAll('[data-range]').forEach(item => item.classList.toggle('active', item === element)); renderPerformance(cache.snaps); renderAllocationHistory(cache.snaps); }; });
document.querySelectorAll('[data-performance-view]').forEach(element => { element.onclick = () => { performanceView = element.dataset.performanceView; document.querySelectorAll('[data-performance-view]').forEach(item => item.classList.toggle('active', item === element)); renderPerformance(cache.snaps); }; });
document.querySelectorAll('.trade-type').forEach(element => { element.onclick = () => trade(element.dataset.type); });
$('refresh').onclick = load;
$('cancel-edit').onclick = resetForm;
['filter-period', 'filter-ticker', 'filter-type', 'filter-reason'].forEach(id => { $(id).onchange = renderTransactions; });
['target-qqq', 'target-qld', 'target-sgov', 'trigger-1', 'trigger-1-sgov', 'trigger-2', 'trigger-2-sgov', 'qld-trigger'].forEach(id => { $(id).oninput = () => validateTargetForm(true); });
$('target-form').onsubmit = async event => {
  event.preventDefault();
  if (!validateTargetForm()) return;
  const response = await api('/api/settings', { method: 'PUT', body: strategyFormValue() });
  if (response.error) { $('target-message').textContent = `저장하지 못했습니다: ${response.error.message}`; $('target-message').classList.add('error'); return; }
  cache.settings = normalizeStrategy(response.data.settings);
  localStorage.setItem('portfolio_target_allocations', JSON.stringify(strategyTargets(cache.settings)));
  $('target-message').textContent = '투자전략을 모든 기기에 적용했습니다.';
  $('target-message').classList.remove('error');
  render();
};
$('transaction-form').onsubmit = async event => {
  event.preventDefault();
  const type = $('trade-type').value, quantity = Number($('quantity').value), price = Number($('price').value), fee = Number($('fee').value);
  const wasEditing = Boolean(editingId);
  const isCash = ['DEPOSIT', 'WITHDRAW'].includes(type);
  const reason = isCash ? null : ($('reason').value || null);
  const strategyCycleId = reason === 'QLD_REBALANCE' && cache.advice?.kind === 'RESET_TARGET' ? cache.advice.cycleId : null;
  const row = { traded_at: new Date(`${$('traded-at').value}:00+09:00`).toISOString(), trade_type: type, ticker: isCash ? 'CASH' : $('ticker').value.trim().toUpperCase(), quantity: isCash ? 0 : quantity, price, amount: isCash ? price : quantity * price, fee: isCash ? 0 : fee, reason, strategy_cycle_id: strategyCycleId, memo: $('memo').value.trim() };
  const rowsWithoutEditing = editingId ? cache.rows.filter(item => item.id !== editingId) : cache.rows;
  const errorMessage = validateTransaction(row, portfolioState(rowsWithoutEditing));
  if (errorMessage) { notice(errorMessage, true); return; }
  const submitButton = $('transaction-form').querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    const response = await api(editingId ? `/api/transactions/${encodeURIComponent(editingId)}` : '/api/transactions', { method: editingId ? 'PATCH' : 'POST', body: row });
    if (response.error) { notice(`${wasEditing ? '수정' : '저장'}하지 못했습니다: ${response.error.message}`, true); return; }
    resetForm();
    await load();
    toast(`${tradeNames[type]} 거래 ${wasEditing ? '수정' : '입력'}이 완료되었습니다.`);
  } finally {
    submitButton.disabled = false;
  }
};
$('transactions-list').onclick = event => {
  const menuId = event.target.dataset.menu;
  if (menuId) { document.querySelectorAll('.row-menu').forEach(menu => menu.classList.toggle('open', menu.dataset.menuPanel === menuId && !menu.classList.contains('open'))); return; }
  if (event.target.dataset.edit) { startEdit(event.target.dataset.edit); return; }
  if (event.target.dataset.delete) {
    const id = event.target.dataset.delete, dialog = $('delete-dialog');
    dialog.showModal();
    dialog.onclose = async () => {
      if (dialog.returnValue !== 'confirm') return;
      const response = await api(`/api/transactions/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (response.error) notice(`삭제하지 못했습니다: ${response.error.message}`, true);
      else { notice('거래를 삭제했습니다.'); await load(); }
    };
  }
};
$('holdings-cards').onclick = event => {
  const ticker = event.target.dataset.tickerJump;
  if (!ticker) return;
  page('transactions');
  $('filter-ticker').value = ticker;
  renderTransactions();
};

(async () => {
  if (sessionToken) { showDashboard(); await load(); return; }
  const { data, status } = await api('/api/session');
  if (status === 200 && data?.authenticated) { showDashboard(); await load(); } else showAuth();
})();

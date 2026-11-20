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
const colors = { QQQ: 'var(--asset-qqq)', QLD: 'var(--asset-qld)', SGOV: 'var(--asset-sgov)', CASH: 'var(--asset-cash)' };
const tradeNames = { BUY: '매수', SELL: '매도', DEPOSIT: '입금', WITHDRAW: '출금' };
const reasonNames = { REGULAR_BUY: '정기매수', QQQ_DRAWDOWN_1: 'QQQ 1차 대응', QQQ_DRAWDOWN_2: 'QQQ 2차 대응', QLD_REBALANCE: 'QLD 복귀', NEW_CAPITAL: '신규자금', OTHER: '기타' };
const adjustmentReasonNames = { FEES_FX: '수수료·환전 차이', MISSING_FLOW: '누락된 입금·출금', DIVIDEND_INTEREST: '배당·이자', EXECUTION_ROUNDING: '체결·반올림 차이', OTHER: '기타 원장 보정' };
let range = 'ALL';
let performanceView = 'value';
let cache = { rows: [], adjustments: [], snaps: [], holdings: [], state: null, allocation: null, drawdown: null, advice: null, settings: { ...STRATEGY_DEFAULTS }, benchmark: { basis: null, points: [] } };
let quotes = {};
let quotesFetchedAt = null;
let editingId = null;
let transactionSubmitting = false;
let toastTimer = null;
let sessionToken = new URLSearchParams(location.hash.slice(1)).get('session') || '';
if (sessionToken) history.replaceState(null, '', location.pathname);

const themeMedia = matchMedia('(prefers-color-scheme: dark)');
const themeKey = 'portfolio_theme_preference';
function applyTheme(preference, persist = false) {
  const normalized = ['light', 'dark', 'system'].includes(preference) ? preference : 'system';
  const resolved = normalized === 'system' ? (themeMedia.matches ? 'dark' : 'light') : normalized;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePreference = normalized;
  document.querySelector('meta[name="theme-color"]').content = resolved === 'dark' ? '#101a24' : '#f1f4f6';
  if ($('theme-preference')) $('theme-preference').value = normalized;
  if ($('theme-status')) $('theme-status').textContent = normalized === 'system' ? `현재 기기 설정: ${resolved === 'dark' ? '다크' : '라이트'}` : `${resolved === 'dark' ? '다크' : '라이트'} 테마를 사용 중입니다.`;
  if (persist) localStorage.setItem(themeKey, normalized);
}
applyTheme(localStorage.getItem(themeKey) || document.documentElement.dataset.themePreference || 'system');
themeMedia.addEventListener('change', () => {
  if ((localStorage.getItem(themeKey) || 'system') === 'system') applyTheme('system');
});

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
  $(id).innerHTML = `<div class="donut" style="background:conic-gradient(${stops})"><div><strong>${label}</strong><span>${centerText}</span></div></div><ul class="legend">${visible.map(item => `<li><i style="background:${colors[item.ticker] || 'var(--muted)'}"></i><span>${item.ticker}</span><b>${(item.value / total * 100).toFixed(1)}%</b></li>`).join('')}</ul>`;
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
  chart.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path d="${path(equityValue)}" fill="none" stroke="var(--chart-equity)" stroke-width="3"/><path d="${path(principalValue)}" fill="none" stroke="var(--chart-cost)" stroke-width="2.5" stroke-dasharray="7 5"/>${points.map((point, index) => `<circle cx="${x(index)}" cy="${y(Number(point.total_equity))}" r="${index === points.length - 1 ? 4.5 : 2.3}" fill="var(--chart-point)"/>`).join('')}</svg>`;
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
  chart.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path d="${path('portfolio')}" fill="none" stroke="var(--chart-equity)" stroke-width="3"/><path d="${path('benchmark')}" fill="none" stroke="var(--chart-benchmark)" stroke-width="2.5"/></svg>`;
  attachTooltip(chart, points, point => `<b>${point.date}</b><div>Portfolio <b>${point.portfolio.toFixed(1)} (${signed(point.portfolio / 100 - 1)})</b></div><div>${basisLabel} <b>${point.benchmark.toFixed(1)} (${signed(point.benchmark / 100 - 1)})</b></div><div>초과성과 <b>${signed(point.excess)}</b></div>`);
}

function renderAllocationHistory(snaps) {
  const points = filtered([...snaps].sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date)));
  const chart = $('allocation-history-chart'), tickers = ['QQQ', 'QLD', 'SGOV'];
  if (!points.length) { chart.innerHTML = '<p class="empty">선택한 기간의 스냅샷이 없습니다.</p>'; return; }
  const w = 720, h = 220, x = index => points.length === 1 ? w / 2 : 18 + index * (w - 36) / (points.length - 1);
  const weights = points.map(snapshot => {
    const data = Object.fromEntries(tickers.map(ticker => [ticker, 0]));
    (Array.isArray(snapshot.holdings) ? snapshot.holdings : []).forEach(item => { if (item.ticker in data) data[item.ticker] += Number(item.quantity) * Number(item.price); });
    const total = Object.values(data).reduce((a, b) => a + b, 0) || 1;
    return Object.fromEntries(tickers.map(ticker => [ticker, data[ticker] / total * 100]));
  });
  const area = ticker => {
    const index = tickers.indexOf(ticker);
    const top = weights.map((row, i) => [x(i), h - 12 - tickers.slice(0, index + 1).reduce((sum, key) => sum + row[key], 0) / 100 * (h - 24)]);
    const bottom = [...weights].reverse().map((row, reverseIndex) => { const i = weights.length - 1 - reverseIndex; return [x(i), h - 12 - tickers.slice(0, index).reduce((sum, key) => sum + row[key], 0) / 100 * (h - 24)]; });
    return `M ${top.map(pair => pair.join(' ')).join(' L ')} L ${bottom.map(pair => pair.join(' ')).join(' L ')} Z`;
  };
  chart.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${tickers.map(ticker => `<path d="${area(ticker)}" fill="${colors[ticker]}" fill-opacity=".78" stroke="var(--chart-separator)"/>`).join('')}</svg>`;
  attachTooltip(chart, points.map((snapshot, index) => ({ snapshot, weight: weights[index] })), item => `<b>${item.snapshot.snapshot_date}</b>${tickers.map(ticker => `<div>${ticker} <b>${item.weight[ticker].toFixed(1)}%</b></div>`).join('')}`);
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
    return `<details class="holding-detail"><summary>${holdingSummary(item, total)}<span class="detail-cue">상세 보기</span></summary><div class="holding-actions" aria-label="${item.ticker} 빠른 거래"><button data-quick-trade="BUY" data-quick-ticker="${item.ticker}">${item.ticker} 매수</button><button class="ghost" data-quick-trade="SELL" data-quick-ticker="${item.ticker}">${item.ticker} 매도</button></div><div class="holding-metrics"><div><span>평가액</span><strong>${usd.format(item.value)}</strong></div><div><span>보유수량</span><strong>${num.format(item.quantity)}주</strong></div><div><span>평균매입가</span><strong>${usd.format(item.averagePrice)}</strong></div><div><span>현재가격</span><strong>${item.currentPrice === null ? '—' : usd.format(item.currentPrice)}</strong></div><div><span>평가손익률</span><strong class="${item.unrealizedReturn >= 0 ? 'positive' : 'negative'}">${signed(item.unrealizedReturn)}</strong></div><div><span>포트폴리오 비중</span><strong>${(total ? item.value / total * 100 : 0).toFixed(1)}%</strong></div><div><span>총 매수금액</span><strong>${usd.format(item.totalBought)}</strong></div><div><span>실현손익</span><strong class="${item.realizedProfit >= 0 ? 'positive' : 'negative'}">${item.realizedProfit >= 0 ? '+' : ''}${usd.format(item.realizedProfit)}</strong></div></div><div class="ticker-transactions"><h3>${item.ticker} 최근 거래</h3>${recent.map(transactionLine).join('') || '<p class="empty small">거래가 없습니다.</p>'}<button class="ghost ticker-all" data-ticker-jump="${item.ticker}">전체 거래 보기</button></div></details>`;
  }).join('') || '<p class="empty">보유 종목이 없습니다.</p>';
}

function transactionLine(row) {
  const unit = ['BUY', 'SELL'].includes(row.trade_type) ? ` · ${usd.format(Number(row.price))}` : '';
  return `<article class="transaction-line"><span>${new Date(row.traded_at).toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit', timeZone: 'Asia/Seoul' })}</span><b>${tradeNames[row.trade_type]}</b><strong>${row.ticker === 'CASH' ? '' : row.ticker}${unit}</strong><em>${usd.format(Number(row.amount))}</em></article>`;
}

function renderTransactions() {
  const period = $('filter-period').value, ticker = $('filter-ticker').value, type = $('filter-type').value, reason = $('filter-reason').value;
  const after = period === 'ALL' ? null : Date.now() - Number(period) * 86400000;
  const visibleRows = cache.rows.filter(row => ['BUY', 'SELL'].includes(row.trade_type));
  const rows = visibleRows.filter(row => (!after || new Date(row.traded_at).getTime() >= after) && (ticker === 'ALL' || row.ticker === ticker) && (type === 'ALL' || row.trade_type === type)
    && (reason === 'ALL' || (reason === 'NONE' ? !row.reason : row.reason === reason)));
  $('transaction-count').textContent = `총 ${rows.length}건`;
  $('recent-transactions').innerHTML = visibleRows.slice(0, 5).map(transactionLine).join('') || '<p class="empty">아직 저장된 거래가 없습니다.</p>';
  $('transactions-list').innerHTML = rows.length ? `<table><thead><tr><th>일시</th><th>구분</th><th>종목</th><th>사유</th><th>수량</th><th>단가</th><th>금액</th><th></th></tr></thead><tbody>${rows.map(row => `<tr><td data-label="일시">${new Date(row.traded_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</td><td data-label="구분">${tradeNames[row.trade_type]}</td><td data-label="종목">${row.ticker}</td><td data-label="사유">${reasonNames[row.reason] || '—'}</td><td data-label="수량">${num.format(row.quantity)}</td><td data-label="단가">${usd.format(Number(row.price))}</td><td data-label="금액">${usd.format(Number(row.amount))}</td><td class="row-actions"><button class="more-button" aria-label="거래 메뉴" data-menu="${row.id}">⋮</button><div class="row-menu" data-menu-panel="${row.id}"><button data-edit="${row.id}">수정</button><button class="danger-text" data-delete="${row.id}">삭제</button></div></td></tr>`).join('')}</tbody></table>` : '<p class="empty">조건에 맞는 거래가 없습니다.</p>';
}

const DASHBOARD_CARDS = [
  { id: 'status', label: '포트폴리오 상태', selector: '#page-home > .hero' },
  { id: 'performance', label: '포트폴리오 성과', selector: '#page-home > .history-card:not(.secondary-card)' },
  { id: 'strategy', label: '전략 상태', selector: '#page-home > .strategy-card' },
  { id: 'market', label: '시장·전략 연결', selector: '#page-home > .market-bridge-card' },
  { id: 'allocation', label: '자산 배분', selector: '#page-home > .allocation-card' },
  { id: 'allocation-history', label: '자산 비중 변화', selector: '#page-home > .secondary-card' },
  { id: 'holdings', label: '보유 자산', selector: '#page-home > .holdings-summary-card' },
  { id: 'transactions', label: '최근 거래', selector: '#page-home > .transactions-summary-card' },
];
const dashboardKey = 'portfolio_dashboard_layout_v1';
const defaultDashboardLayout = () => DASHBOARD_CARDS.map(item => ({ id: item.id, visible: true }));
function dashboardLayout() {
  try {
    const saved = JSON.parse(localStorage.getItem(dashboardKey) || 'null');
    if (!Array.isArray(saved)) return defaultDashboardLayout();
    const valid = saved.filter(item => DASHBOARD_CARDS.some(card => card.id === item.id));
    const missing = DASHBOARD_CARDS.filter(card => !valid.some(item => item.id === card.id)).map(card => ({ id: card.id, visible: true }));
    return [...valid, ...missing].map(item => ({ id: item.id, visible: item.visible !== false }));
  } catch { return defaultDashboardLayout(); }
}
function applyDashboardLayout(layout = dashboardLayout()) {
  const home = $('page-home');
  layout.forEach(item => {
    const card = DASHBOARD_CARDS.find(entry => entry.id === item.id);
    const element = card && document.querySelector(card.selector);
    if (!element) return;
    element.dataset.dashboardCard = item.id;
    element.classList.toggle('dashboard-card-hidden', !item.visible);
    home.appendChild(element);
  });
}
function renderDashboardEditor(layout = dashboardLayout()) {
  $('dashboard-card-editor').innerHTML = layout.map((item, index) => {
    const card = DASHBOARD_CARDS.find(entry => entry.id === item.id);
    return `<div class="dashboard-editor-row" data-editor-card="${item.id}"><label><input type="checkbox" ${item.visible ? 'checked' : ''} />${card.label}</label><div class="dashboard-order-actions"><button type="button" data-move-card="up" aria-label="${card.label} 위로" ${index === 0 ? 'disabled' : ''}>↑</button><button type="button" data-move-card="down" aria-label="${card.label} 아래로" ${index === layout.length - 1 ? 'disabled' : ''}>↓</button></div></div>`;
  }).join('');
}
function editorLayout() {
  return [...document.querySelectorAll('[data-editor-card]')].map(row => ({ id: row.dataset.editorCard, visible: row.querySelector('input').checked }));
}

const riskWeightKey = 'portfolio_market_risk_weights_v1';
const defaultRiskWeights = { drawdown: 45, concentration: 35, leverage: 20 };
function riskWeights() {
  try { return { ...defaultRiskWeights, ...JSON.parse(localStorage.getItem(riskWeightKey) || '{}') }; } catch { return { ...defaultRiskWeights }; }
}
function riskMetrics() {
  const drawdown = Math.min(100, Math.abs(Number(cache.drawdown?.current || 0)) * 200);
  const concentration = Math.min(100, Math.max(0, ...(cache.allocation?.rows || []).map(row => row.currentWeight)));
  const exposure = nominalNasdaqExposure(cache.allocation || { total: 0, rows: [] }) * 100;
  const leverage = Math.min(100, Math.max(0, exposure - 70) / 1.3);
  const weights = riskWeights();
  const total = Math.max(1, weights.drawdown + weights.concentration + weights.leverage);
  const score = (drawdown * weights.drawdown + concentration * weights.concentration + leverage * weights.leverage) / total;
  return { score, drawdown, concentration, leverage, exposure, weights };
}
function portfolioIndexSeries() {
  let value = 100;
  return [...cache.snaps].sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date)).flatMap(item => {
    const daily = Number(item.twr_daily_return);
    if (!Number.isFinite(daily)) return [];
    value *= 1 + daily;
    return [{ date: item.snapshot_date, value }];
  });
}
function marketSeries() {
  return {
    portfolio: { label: 'Portfolio TWR', color: 'var(--chart-equity)', points: portfolioIndexSeries() },
    qqq: { label: 'QQQ 조정가격', color: 'var(--chart-benchmark)', points: (cache.benchmark?.points || []).map(point => ({ date: point.date, value: Number(point.value) })).filter(point => Number.isFinite(point.value)) },
    equity: { label: '평가자산', color: 'var(--warning)', points: cache.snaps.map(item => ({ date: item.snapshot_date, value: Number(item.total_equity) })).filter(point => Number.isFinite(point.value) && point.value > 0) },
  };
}
function selectedMarketSeries() { return [...document.querySelectorAll('[data-market-series]:checked')].map(input => input.dataset.marketSeries); }
function normalizedMarketData() {
  const all = marketSeries(), selected = selectedMarketSeries();
  const period = $('market-period').value, mode = $('market-normalization').value;
  const latest = Math.max(...selected.flatMap(id => all[id].points.map(point => new Date(`${point.date}T00:00:00Z`).getTime())));
  const cutoff = period === 'ALL' ? -Infinity : latest - Number(period) * 86400000;
  const filtered = selected.map(id => ({ id, ...all[id], points: all[id].points.filter(point => new Date(`${point.date}T00:00:00Z`).getTime() >= cutoff) }));
  const commonStart = Math.max(...filtered.map(series => new Date(`${series.points[0]?.date || '9999-12-31'}T00:00:00Z`).getTime()));
  return filtered.map(series => {
    const points = series.points.filter(point => new Date(`${point.date}T00:00:00Z`).getTime() >= commonStart);
    const base = points[0]?.value;
    return { ...series, points: points.map(point => ({ ...point, value: mode === 'return' ? (point.value / base - 1) * 100 : point.value / base * 100 })) };
  });
}
function renderMarketChart() {
  const selected = selectedMarketSeries();
  $('market-selection-error').textContent = selected.length ? '' : '지표를 1개 이상 선택하세요.';
  if (!selected.length) { $('market-comparison-chart').innerHTML = '<p class="empty">선택된 지표가 없습니다.</p>'; return; }
  const series = normalizedMarketData().filter(item => item.points.length > 1);
  if (!series.length) { $('market-comparison-chart').innerHTML = '<p class="empty">동일 기간에 비교할 데이터가 부족합니다.</p>'; return; }
  const values = series.flatMap(item => item.points.map(point => point.value));
  const dates = series.flatMap(item => item.points.map(point => new Date(`${point.date}T00:00:00Z`).getTime()));
  const min = Math.min(...values), max = Math.max(...values), low = min === max ? min - 1 : min, high = min === max ? max + 1 : max;
  const start = Math.min(...dates), end = Math.max(...dates), width = 900, height = 330, pad = 42;
  const x = date => pad + (new Date(`${date}T00:00:00Z`).getTime() - start) / Math.max(1, end - start) * (width - pad * 2);
  const y = value => height - pad - (value - low) / (high - low) * (height - pad * 2);
  const grid = Array.from({ length: 5 }, (_, index) => { const value = low + (high - low) * index / 4; return `<line class="grid-line" x1="${pad}" x2="${width - pad}" y1="${y(value)}" y2="${y(value)}"/><text x="4" y="${y(value) + 4}">${value.toFixed(1)}${$('market-normalization').value === 'return' ? '%' : ''}</text>`; }).join('');
  const paths = series.map(item => {
    let previous = null;
    const d = item.points.map(point => { const gap = previous ? new Date(point.date) - new Date(previous.date) : Infinity; const command = !previous || gap > 10 * 86400000 ? 'M' : 'L'; previous = point; return `${command}${x(point.date).toFixed(1)},${y(point.value).toFixed(1)}`; }).join(' ');
    return `<path d="${d}" fill="none" stroke="${item.color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join('');
  $('market-comparison-chart').innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">${grid}${paths}</svg>`;
  $('market-chart-legend').innerHTML = series.map(item => `<span><i style="background:${item.color}"></i>${item.label}</span>`).join('');
  $('market-chart-summary').textContent = `${series[0].points[0].date} ~ ${series[0].points.at(-1).date} · ${$('market-normalization').selectedOptions[0].textContent}`;
}
function calculateAnalogs(points) {
  const sorted = points.map(point => ({ date: point.date, value: Number(point.value) })).filter(point => Number.isFinite(point.value) && point.value > 0).sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length < 380) return [];
  const horizon = 63, last = sorted.length - 1;
  const currentReturn = sorted[last].value / sorted[last - horizon].value - 1;
  const candidates = [];
  for (let index = horizon; index <= last - 252; index += 1) {
    const trailing = sorted[index].value / sorted[index - horizon].value - 1;
    candidates.push({ index, score: Math.abs(trailing - currentReturn), trailing });
  }
  const picked = [];
  for (const candidate of candidates.sort((a, b) => a.score - b.score)) {
    if (picked.every(item => Math.abs(item.index - candidate.index) > 90)) picked.push(candidate);
    if (picked.length === 3) break;
  }
  return picked.map(item => ({ date: sorted[item.index].date, similarity: Math.max(0, 100 - item.score * 300), r3: sorted[item.index + 63].value / sorted[item.index].value - 1, r6: sorted[item.index + 126].value / sorted[item.index].value - 1, r12: sorted[item.index + 252].value / sorted[item.index].value - 1 }));
}
function renderMarketAnalytics() {
  if (!$('market-comparison-chart')) return;
  const points = cache.benchmark?.points || [];
  const lastDate = points.at(-1)?.date;
  const age = lastDate ? (Date.now() - new Date(`${lastDate}T23:59:59Z`).getTime()) / 86400000 : Infinity;
  $('market-freshness').textContent = lastDate ? `${lastDate} 종가 기준${age > 4 ? ' · 갱신 지연 가능' : ''}` : '시장 데이터를 불러오지 못함';
  $('market-freshness').classList.toggle('stale', age > 4);
  $('market-data-warning').textContent = !points.length ? 'QQQ 시장 데이터가 없어 비교 차트와 유사 구간을 표시할 수 없습니다.' : age > 4 ? '마지막 시장 관측값이 4일 이상 지났습니다. 최신값으로 오인하지 마세요.' : '';
  $('market-data-warning').classList.toggle('error', !points.length || age > 4);
  const risk = riskMetrics();
  $('market-risk-score').textContent = risk.score.toFixed(0);
  $('home-risk-score').textContent = `${risk.score.toFixed(0)} / 100`;
  $('risk-components').innerHTML = `<div><span>시장 하락</span><strong>${risk.drawdown.toFixed(0)}</strong></div><div><span>자산 집중</span><strong>${risk.concentration.toFixed(0)}</strong></div><div><span>레버리지 노출</span><strong>${risk.leverage.toFixed(0)}</strong></div>`;
  Object.entries(risk.weights).forEach(([key, value]) => { $(`risk-weight-${key}`).value = value; $(`risk-weight-${key}`).nextElementSibling.value = `${value}%`; });
  const threeMonth = points.length > 63 ? Number(points.at(-1).value) / Number(points.at(-64).value) - 1 : null;
  $('home-market-return').textContent = threeMonth === null ? '—' : signed(threeMonth);
  $('home-market-asof').textContent = lastDate || '—';
  $('market-bridge-status').textContent = lastDate ? `QQQ 조정가격 ${lastDate} 기준 · 위험점수는 확률이 아닌 상대 지표입니다.` : '시장 데이터 연결을 확인할 수 없습니다.';
  renderMarketChart();
  const analogs = calculateAnalogs(points);
  $('market-analogs').innerHTML = analogs.length ? analogs.map(item => `<article class="analog-row"><strong>${item.date}<small>유사도 ${item.similarity.toFixed(0)}</small></strong><div><span>이후 3개월<b class="${item.r3 >= 0 ? 'positive' : 'negative'}">${signed(item.r3)}</b></span><span>이후 6개월<b class="${item.r6 >= 0 ? 'positive' : 'negative'}">${signed(item.r6)}</b></span><span>이후 12개월<b class="${item.r12 >= 0 ? 'positive' : 'negative'}">${signed(item.r12)}</b></span></div></article>`).join('') : '<p class="empty">유사 구간 계산에 필요한 장기 데이터가 부족합니다.</p>';
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
  const state = portfolioState([...cache.rows, ...cache.adjustments.map(item => ({ ...item, trade_type: 'ADJUSTMENT', traded_at: item.adjusted_at }))]);
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
  ['total-profit', 'total-return'].forEach(id => { $(id).classList.toggle('positive', profit >= 0); $(id).classList.toggle('negative', profit < 0); });
  $('equity-label').textContent = hasLive ? '실시간 평가자산' : '최근 평가자산';
  $('profit-label').textContent = hasLive ? '실시간 평가손익' : '최근 평가손익';
  $('as-of').textContent = hasLive ? `Yahoo Finance · ${new Date(quotesFetchedAt).toLocaleString('ko-KR')} 기준` : last ? `최근 평가 기준일 ${last.snapshot_date}` : '거래 기록 기준';
  $('status-summary').textContent = `순입금 원금 ${usd.format(state.netContributions)} 대비 ${profit >= 0 ? '수익' : '손실'} ${profit >= 0 ? '+' : ''}${usd.format(profit)}`;
  $('settlement-balance').textContent = `기존 매도대금 잔액 ${usd.format(Math.max(0, state.cash))} · 수수료 제외 기준`;
  renderAdjustments(state.cash);
  const allocation = renderAllocation(holdings);
  renderPerformance(cache.snaps);
  renderAllocationHistory(cache.snaps);
  renderPortfolio(holdings, cache.rows, allocation.total);
  cache = { ...cache, state, holdings };
  populateFilters();
  renderTransactions();
  renderMarketAnalytics();
}

function renderAdjustments(balance) {
  $('settlement-card-balance').textContent = usd.format(balance);
  const latest = cache.adjustments[0];
  $('last-adjustment').textContent = latest ? new Date(latest.adjusted_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '기록 없음';
  const reversed = new Set(cache.adjustments.filter(item => item.reversed_adjustment_id).map(item => item.reversed_adjustment_id));
  $('adjustment-history').innerHTML = cache.adjustments.length ? cache.adjustments.slice(0, 8).map(item => {
    const isReversal = Boolean(item.reversed_adjustment_id), canReverse = !isReversal && !reversed.has(item.id);
    return `<div class="adjustment-row"><span>${new Date(item.adjusted_at).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' })}</span><div><b>${isReversal ? '보정 취소' : adjustmentReasonNames[item.adjustment_reason]}</b><small>${item.memo || '메모 없음'}</small></div><strong class="${Number(item.adjustment_amount) >= 0 ? 'positive' : 'negative'}">${Number(item.adjustment_amount) >= 0 ? '+' : ''}${usd.format(Number(item.adjustment_amount))}</strong>${canReverse ? `<button class="ghost" data-reverse-adjustment="${item.id}">취소</button>` : '<span></span>'}</div>`;
  }).join('') : '<p class="empty small">아직 보정 기록이 없습니다.</p>';
}

function updateAdjustmentPreview() {
  const current = Number(cache.state?.cash || 0), actual = Number($('actual-balance').value), valid = Number.isFinite(actual) && actual >= 0;
  const difference = actual - current;
  $('adjustment-preview').textContent = valid ? usd.format(actual) : '—';
  $('adjustment-effect').innerHTML = valid ? `잔액을 <strong>${difference >= 0 ? '+' : ''}${usd.format(difference)}</strong> 보정합니다. ${['DIVIDEND_INTEREST', 'EXECUTION_ROUNDING'].includes($('adjustment-reason').value) ? '수익률에는 반영하고 원금은 바꾸지 않습니다.' : '외부 자금 흐름으로 처리해 원금도 함께 조정합니다.'}` : '실제 잔액을 입력하면 차이를 미리 보여드립니다.';
  $('save-adjustment').disabled = !valid || Math.abs(difference) < 0.01;
}

function populateFilters() {
  const selected = $('filter-ticker').value;
  const tickers = [...new Set(cache.rows.filter(row => ['BUY', 'SELL'].includes(row.trade_type)).map(row => row.ticker))].sort();
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
  cache.adjustments = portfolioResponse.data.adjustments || [];
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
  document.querySelectorAll('.trade-type').forEach(element => element.classList.toggle('active', element.dataset.type === type));
  document.querySelectorAll('.funding-field').forEach(element => element.classList.toggle('hidden', type !== 'BUY' || Boolean(editingId)));
  $('price-label').textContent = '단가';
  updateTradePreview();
}
function availableTickerQuantity(ticker = $('ticker').value) {
  const rows = editingId ? cache.rows.filter(item => item.id !== editingId) : cache.rows;
  return portfolioState(rows).holdings.find(item => item.ticker === ticker)?.quantity || 0;
}
function setFieldError(inputId, errorId, message = '') {
  const input = $(inputId), error = $(errorId);
  input.setAttribute('aria-invalid', String(Boolean(message)));
  error.textContent = message;
}
function updateTradePreview() {
  if (!$('trade-preview-amount')) return;
  const type = $('trade-type').value;
  const quantity = Number($('quantity').value) || 0;
  const price = Number($('price').value) || 0;
  const amount = quantity * price;
  const available = availableTickerQuantity();
  $('trade-preview-amount').textContent = usd.format(amount);
  $('ticker-availability').textContent = type === 'SELL' ? `매도 가능 ${num.format(available)}주` : `현재 보유 ${num.format(available)}주`;
  $('trade-preview-detail').textContent = amount > 0
    ? `${$('ticker').value} ${num.format(quantity)}주를 주당 ${usd.format(price)}에 ${tradeNames[type]}합니다.`
    : '수량과 단가를 입력하세요.';
}
function validateTransactionFields() {
  const type = $('trade-type').value;
  const quantity = Number($('quantity').value), price = Number($('price').value);
  const tradedAt = $('traded-at').value;
  const available = availableTickerQuantity();
  const dateMessage = tradedAt && Number.isFinite(new Date(`${tradedAt}:00+09:00`).getTime()) ? '' : '거래 일시를 입력하세요.';
  const quantityMessage = !Number.isFinite(quantity) || quantity <= 0 ? '수량은 0보다 커야 합니다.'
    : type === 'SELL' && quantity > available + 1e-7 ? `매도 가능 수량 ${num.format(available)}주를 초과했습니다.` : '';
  const priceMessage = !Number.isFinite(price) || price <= 0 ? '단가는 0보다 커야 합니다.' : '';
  let fundingMessage = '';
  if (type === 'BUY' && !editingId && $('funding-source').value === 'SETTLEMENT') {
    const rows = [...cache.rows, ...cache.adjustments.map(item => ({ ...item, trade_type: 'ADJUSTMENT', traded_at: item.adjusted_at }))];
    const balance = portfolioState(rows).cash;
    if (quantity * price > balance + 0.005) fundingMessage = `사용 가능한 정산 잔액 ${usd.format(Math.max(0, balance))}을 초과했습니다.`;
  }
  setFieldError('traded-at', 'traded-at-error', dateMessage);
  setFieldError('quantity', 'quantity-error', quantityMessage);
  setFieldError('price', 'price-error', priceMessage);
  setFieldError('funding-source', 'funding-error', fundingMessage);
  return !dateMessage && !quantityMessage && !priceMessage && !fundingMessage;
}
function resetForm() {
  editingId = null;
  notice('', false);
  $('transaction-form').reset();
  document.querySelectorAll('.trade-type').forEach(element => { element.disabled = false; });
  $('traded-at').value = now();
  $('transaction-form-title').textContent = '거래 추가';
  $('transaction-form-help').textContent = '종목과 수량, 단가를 입력하면 저장 전 예상 금액을 확인할 수 있습니다.';
  $('editing-badge').classList.add('hidden');
  $('transaction-submit').textContent = '거래 저장';
  $('cancel-edit').classList.add('hidden');
  ['traded-at', 'quantity', 'price', 'funding-source'].forEach(id => $(id).removeAttribute('aria-invalid'));
  ['traded-at-error', 'quantity-error', 'price-error', 'funding-error'].forEach(id => { $(id).textContent = ''; });
  trade('BUY');
}
function startEdit(id) {
  const row = cache.rows.find(item => item.id === id);
  if (!row) return;
  editingId = id;
  page('transactions');
  $('transaction-form-title').textContent = '거래 수정';
  $('transaction-form-help').textContent = `${row.ticker} ${tradeNames[row.trade_type]} 기록을 수정하고 있습니다.`;
  $('editing-badge').classList.remove('hidden');
  $('transaction-submit').textContent = '수정 내용 저장';
  $('cancel-edit').classList.remove('hidden');
  trade(row.trade_type);
  document.querySelectorAll('.trade-type').forEach(element => { element.disabled = true; });
  $('traded-at').value = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(row.traded_at)).replace(' ', 'T');
  if (!['DEPOSIT', 'WITHDRAW'].includes(row.trade_type)) $('ticker').value = row.ticker;
  $('quantity').value = row.quantity;
  $('price').value = row.price;
  $('reason').value = row.reason || '';
  $('memo').value = row.memo || '';
  updateTradePreview();
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
document.querySelector('[data-action="new-transaction"]').onclick = () => {
  resetForm();
  page('transactions');
  $('transaction-form-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
  setTimeout(() => $('ticker').focus(), 250);
};
$('theme-preference').onchange = event => applyTheme(event.target.value, true);
applyDashboardLayout();
$('edit-dashboard').onclick = () => { renderDashboardEditor(); $('dashboard-dialog').showModal(); };
$('dashboard-card-editor').onclick = event => {
  const direction = event.target.dataset.moveCard;
  if (!direction) return;
  const row = event.target.closest('[data-editor-card]');
  const sibling = direction === 'up' ? row.previousElementSibling : row.nextElementSibling;
  if (!sibling) return;
  if (direction === 'up') row.parentElement.insertBefore(row, sibling); else row.parentElement.insertBefore(sibling, row);
  renderDashboardEditor(editorLayout());
};
$('save-dashboard').onclick = () => { const layout = editorLayout(); localStorage.setItem(dashboardKey, JSON.stringify(layout)); applyDashboardLayout(layout); toast('상황실 카드 구성을 저장했습니다.'); };
$('reset-dashboard').onclick = () => renderDashboardEditor(defaultDashboardLayout());
document.querySelectorAll('[data-market-series]').forEach(input => { input.onchange = () => {
  const selected = selectedMarketSeries();
  if (selected.length > 3) { input.checked = false; $('market-selection-error').textContent = '지표는 최대 3개까지 선택할 수 있습니다.'; return; }
  renderMarketChart();
}; });
$('market-period').onchange = renderMarketChart;
$('market-normalization').onchange = renderMarketChart;
['drawdown', 'concentration', 'leverage'].forEach(key => { $(`risk-weight-${key}`).oninput = event => {
  event.target.nextElementSibling.value = `${event.target.value}%`;
  const weights = Object.fromEntries(['drawdown', 'concentration', 'leverage'].map(name => [name, Number($(`risk-weight-${name}`).value)]));
  localStorage.setItem(riskWeightKey, JSON.stringify(weights));
  renderMarketAnalytics();
}; });
$('reset-risk-weights').onclick = () => { localStorage.setItem(riskWeightKey, JSON.stringify(defaultRiskWeights)); renderMarketAnalytics(); toast('위험 가중치를 기본값으로 복원했습니다.'); };
document.querySelectorAll('[data-range]').forEach(element => { element.onclick = () => { range = element.dataset.range; document.querySelectorAll('[data-range]').forEach(item => item.classList.toggle('active', item === element)); renderPerformance(cache.snaps); renderAllocationHistory(cache.snaps); }; });
document.querySelectorAll('[data-performance-view]').forEach(element => { element.onclick = () => { performanceView = element.dataset.performanceView; document.querySelectorAll('[data-performance-view]').forEach(item => item.classList.toggle('active', item === element)); renderPerformance(cache.snaps); }; });
document.querySelectorAll('.trade-type').forEach(element => { element.onclick = () => trade(element.dataset.type); });
$('ticker').onchange = () => { updateTradePreview(); if ($('quantity').getAttribute('aria-invalid') === 'true') validateTransactionFields(); };
$('traded-at').onchange = () => { if ($('traded-at').getAttribute('aria-invalid') === 'true') validateTransactionFields(); };
$('quantity').oninput = () => { updateTradePreview(); if ($('quantity').getAttribute('aria-invalid') === 'true') validateTransactionFields(); };
$('price').oninput = () => { updateTradePreview(); if ($('price').getAttribute('aria-invalid') === 'true') validateTransactionFields(); };
$('funding-source').onchange = () => { updateTradePreview(); if ($('funding-source').getAttribute('aria-invalid') === 'true') validateTransactionFields(); };
$('refresh').onclick = load;
$('cancel-edit').onclick = resetForm;
$('open-adjustment').onclick = () => {
  $('adjustment-current').textContent = usd.format(cache.state.cash);
  $('actual-balance').value = Math.max(0, cache.state.cash).toFixed(2);
  $('adjusted-at').value = now();
  $('adjustment-memo').value = '';
  updateAdjustmentPreview();
  $('adjustment-dialog').showModal();
};
$('close-adjustment').onclick = () => $('adjustment-dialog').close();
$('actual-balance').oninput = updateAdjustmentPreview;
$('adjustment-reason').onchange = updateAdjustmentPreview;
$('adjustment-form').onsubmit = async event => {
  event.preventDefault();
  const button = $('save-adjustment');
  button.disabled = true;
  const response = await api('/api/settlement-adjustments', { method: 'POST', body: {
    expectedBalance: cache.state.cash,
    actualBalance: Number($('actual-balance').value),
    adjustedAt: new Date(`${$('adjusted-at').value}:00+09:00`).toISOString(),
    reason: $('adjustment-reason').value,
    memo: $('adjustment-memo').value.trim(),
  } });
  if (response.error) { toast(response.error.message, true); button.disabled = false; return; }
  $('adjustment-dialog').close();
  await load();
  toast('정산 잔액 보정이 완료되었습니다.');
};
$('adjustment-history').onclick = async event => {
  const id = event.target.dataset.reverseAdjustment;
  if (!id || !confirm('이 보정 기록을 취소하시겠습니까? 반대 금액의 취소 기록이 남습니다.')) return;
  event.target.disabled = true;
  const response = await api(`/api/settlement-adjustments/${encodeURIComponent(id)}/reverse`, { method: 'POST', body: { adjustedAt: new Date().toISOString() } });
  if (response.error) { toast(response.error.message, true); event.target.disabled = false; return; }
  await load();
  toast('잔액 보정을 취소했습니다.');
};
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
  if (transactionSubmitting) return;
  if (!validateTransactionFields()) {
    notice('입력값을 확인한 뒤 다시 저장해 주세요.', true);
    $('transaction-form').querySelector('[aria-invalid="true"]')?.focus();
    return;
  }
  notice('', false);
  const type = $('trade-type').value, quantity = Number($('quantity').value), price = Number($('price').value);
  const wasEditing = Boolean(editingId);
  const reason = $('reason').value || null;
  const strategyCycleId = reason === 'QLD_REBALANCE' && cache.advice?.kind === 'RESET_TARGET' ? cache.advice.cycleId : null;
  const row = { traded_at: new Date(`${$('traded-at').value}:00+09:00`).toISOString(), trade_type: type, ticker: $('ticker').value, quantity, price, amount: quantity * price, fee: 0, reason, strategy_cycle_id: strategyCycleId, memo: $('memo').value.trim() };
  if (!wasEditing && type === 'BUY') row.funding_source = $('funding-source').value;
  const adjustmentRows = cache.adjustments.map(item => ({ ...item, trade_type: 'ADJUSTMENT', traded_at: item.adjusted_at }));
  const rowsWithoutEditing = [...(editingId ? cache.rows.filter(item => item.id !== editingId) : cache.rows), ...adjustmentRows];
  const errorMessage = validateTransaction(row, portfolioState(rowsWithoutEditing));
  if (errorMessage) { notice(errorMessage, true); return; }
  if (!wasEditing && type === 'BUY' && row.funding_source === 'SETTLEMENT' && row.amount > portfolioState(rowsWithoutEditing).cash + 0.005) {
    notice('기존 매도대금 잔액보다 많이 매수할 수 없습니다.', true);
    return;
  }
  const submitButton = $('transaction-form').querySelector('button[type="submit"]');
  transactionSubmitting = true;
  submitButton.disabled = true;
  submitButton.textContent = wasEditing ? '수정 저장 중…' : '거래 저장 중…';
  try {
    const response = await api(editingId ? `/api/transactions/${encodeURIComponent(editingId)}` : '/api/transactions', { method: editingId ? 'PATCH' : 'POST', body: row });
    if (response.error) { notice(`${wasEditing ? '수정' : '저장'}하지 못했습니다: ${response.error.message}`, true); return; }
    resetForm();
    await load();
    toast(`${tradeNames[type]} 거래 ${wasEditing ? '수정' : '입력'}이 완료되었습니다.`);
  } finally {
    transactionSubmitting = false;
    submitButton.disabled = false;
    submitButton.textContent = editingId ? '수정 내용 저장' : '거래 저장';
  }
};
$('transactions-list').onclick = event => {
  const menuId = event.target.dataset.menu;
  if (menuId) { document.querySelectorAll('.row-menu').forEach(menu => menu.classList.toggle('open', menu.dataset.menuPanel === menuId && !menu.classList.contains('open'))); return; }
  if (event.target.dataset.edit) { startEdit(event.target.dataset.edit); return; }
  if (event.target.dataset.delete) {
    const id = event.target.dataset.delete, dialog = $('delete-dialog');
    const row = cache.rows.find(item => item.id === id);
    if (!row) return;
    $('delete-transaction-summary').innerHTML = `<strong>${row.ticker} ${tradeNames[row.trade_type]}</strong><span>${new Date(row.traded_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</span><b>${num.format(row.quantity)}주 · ${usd.format(Number(row.amount))}</b>`;
    dialog.showModal();
    dialog.onclose = async () => {
      if (dialog.returnValue !== 'confirm') return;
      const deleteButton = dialog.querySelector('[value="confirm"]');
      deleteButton.disabled = true;
      deleteButton.textContent = '삭제 중…';
      const response = await api(`/api/transactions/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (response.error) notice(`삭제하지 못했습니다: ${response.error.message}`, true);
      else { notice('거래를 삭제했습니다.'); await load(); }
      deleteButton.disabled = false;
      deleteButton.textContent = '삭제';
    };
  }
};
$('holdings-cards').onclick = event => {
  const quickType = event.target.dataset.quickTrade;
  if (quickType) {
    resetForm();
    $('ticker').value = event.target.dataset.quickTicker;
    trade(quickType);
    page('transactions');
    $('transaction-form-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => $('quantity').focus(), 250);
    return;
  }
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

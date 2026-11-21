import { staticAsset } from './assets.js';
const enc = new TextEncoder();
const b64 = value => btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const unb64 = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)), char => char.charCodeAt(0));
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const STRATEGY_DEFAULTS = Object.freeze({ targetQQQ: 10, targetQLD: 70, targetSGOV: 20, qqqTrigger1: -20, qqqTrigger1SgovPct: 50, qqqTrigger2: -30, qqqTrigger2RemainingPct: 100, qldRebalanceTrigger: 85 });
const REASONS = new Set(['REGULAR_BUY', 'QQQ_DRAWDOWN_1', 'QQQ_DRAWDOWN_2', 'QLD_REBALANCE', 'NEW_CAPITAL', 'OTHER']);
const marketCache = new Map();

async function sign(value, secret) { return b64(await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), enc.encode(value))); }
async function session(env) { const payload = b64(enc.encode(JSON.stringify({ exp: Date.now() + 2592e6 }))); return `${payload}.${await sign(payload, env.SESSION_SECRET)}`; }
async function allowed(request, env) {
  const value = request.headers.get('x-portfolio-session') || request.headers.get('cookie')?.match(/(?:^|;\s*)portfolio_session=([^;]+)/)?.[1];
  if (!value) return false;
  const [payload, signature] = value.split('.');
  if (!payload || !signature) return false;
  const expected = await sign(payload, env.SESSION_SECRET);
  if (signature.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < signature.length; index += 1) difference |= signature.charCodeAt(index) ^ expected.charCodeAt(index);
  if (difference) return false;
  try { return JSON.parse(new TextDecoder().decode(unb64(payload))).exp > Date.now(); } catch { return false; }
}
const cookie = token => `portfolio_session=${token}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=None`;
const clear = 'portfolio_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None';
function db(env, path, options = {}) { return fetch(`${env.SUPABASE_URL}${path}`, { ...options, headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'content-type': 'application/json', ...options.headers } }); }
async function snapshot(env, payload = {}) { try { return (await db(env, '/functions/v1/portfolio-snapshot', { method: 'POST', body: JSON.stringify(payload) })).ok; } catch { return false; } }
async function body(request) { try { if ((request.headers.get('content-type') || '').includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(await request.text())); return await request.json(); } catch { return null; } }
function valid(row) {
  if (!row || !['BUY', 'SELL', 'DEPOSIT', 'WITHDRAW'].includes(row.trade_type) || typeof row.ticker !== 'string' || typeof row.traded_at !== 'string') return false;
  if (row.ticker.length > 15 || String(row.memo || '').length > 500 || !/^([A-Z.]{1,15}|CASH)$/i.test(row.ticker)) return false;
  if (![row.quantity, row.price, row.amount, row.fee].every(value => Number.isFinite(Number(value)) && Number(value) >= 0)) return false;
  if (row.reason && !REASONS.has(row.reason)) return false;
  if (!['BUY', 'SELL'].includes(row.trade_type) && row.reason) return false;
  if (['BUY', 'SELL'].includes(row.trade_type)) return Number(row.quantity) > 0 && Number(row.price) > 0;
  return Number(row.amount) > 0 && row.ticker.toUpperCase() === 'CASH';
}
export function settlementBalance(rows, excludedId) {
  return rows.filter(row => !excludedId || row.id !== excludedId).reduce((cash, row) => {
    if (row.trade_type === 'ADJUSTMENT') return cash + Number(row.adjustment_amount);
    if (row.trade_type === 'DEPOSIT') return cash + Number(row.amount);
    if (row.trade_type === 'WITHDRAW') return cash - Number(row.amount);
    if (row.trade_type === 'BUY') return cash - Number(row.amount);
    if (row.trade_type === 'SELL') return cash + Number(row.amount);
    return cash;
  }, 0);
}

const adjustmentRow = row => ({ ...row, trade_type: 'ADJUSTMENT', traded_at: row.adjusted_at });
const adjustmentReasons = new Set(['FEES_FX', 'MISSING_FLOW', 'DIVIDEND_INTEREST', 'EXECUTION_ROUNDING', 'OTHER']);
const contributionDelta = (reason, amount) => reason === 'DIVIDEND_INTEREST' || reason === 'EXECUTION_ROUNDING' ? 0 : amount;
async function adjustments(env) {
  const response = await db(env, `/rest/v1/settlement_adjustments?select=*&user_id=eq.${env.PORTFOLIO_USER_ID}&order=adjusted_at.asc`);
  return response.ok ? response.json() : null;
}
async function ledgerRows(env) {
  const [transactionRows, adjustmentRows] = await Promise.all([transactions(env), adjustments(env)]);
  if (!transactionRows || !adjustmentRows) return null;
  return [...transactionRows, ...adjustmentRows.map(adjustmentRow)];
}

const settingsFromRow = row => row ? ({
  targetQQQ: Number(row.target_qqq), targetQLD: Number(row.target_qld), targetSGOV: Number(row.target_sgov),
  qqqTrigger1: Number(row.qqq_trigger_1), qqqTrigger1SgovPct: Number(row.qqq_trigger_1_sgov_pct),
  qqqTrigger2: Number(row.qqq_trigger_2), qqqTrigger2RemainingPct: Number(row.qqq_trigger_2_remaining_pct),
  qldRebalanceTrigger: Number(row.qld_rebalance_trigger),
}) : null;
const settingsToRow = value => ({
  target_qqq: Number(value.targetQQQ), target_qld: Number(value.targetQLD), target_sgov: Number(value.targetSGOV),
  qqq_trigger_1: Number(value.qqqTrigger1), qqq_trigger_1_sgov_pct: Number(value.qqqTrigger1SgovPct),
  qqq_trigger_2: Number(value.qqqTrigger2), qqq_trigger_2_remaining_pct: Number(value.qqqTrigger2RemainingPct),
  qld_rebalance_trigger: Number(value.qldRebalanceTrigger),
});
export function validSettings(input) {
  if (!input || Object.keys(STRATEGY_DEFAULTS).some(key => !Number.isFinite(Number(input[key])))) return false;
  const value = Object.fromEntries(Object.keys(STRATEGY_DEFAULTS).map(key => [key, Number(input[key])]));
  return [value.targetQQQ, value.targetQLD, value.targetSGOV].every(item => item >= 0 && item <= 100)
    && Math.abs(value.targetQQQ + value.targetQLD + value.targetSGOV - 100) < 1e-7
    && value.qqqTrigger1 > -100 && value.qqqTrigger1 < 0
    && value.qqqTrigger2 > -100 && value.qqqTrigger2 < value.qqqTrigger1
    && [value.qqqTrigger1SgovPct, value.qqqTrigger2RemainingPct, value.qldRebalanceTrigger].every(item => item >= 0 && item <= 100);
}
async function strategySettings(env) {
  const response = await db(env, `/rest/v1/portfolio_strategy_settings?select=*&user_id=eq.${env.PORTFOLIO_USER_ID}&limit=1`);
  if (!response.ok) throw new Error('전략 설정을 읽지 못했습니다.');
  return settingsFromRow((await response.json())[0]);
}
async function transactions(env) {
  const response = await db(env, `/rest/v1/transactions?select=*&user_id=eq.${env.PORTFOLIO_USER_ID}&order=traded_at.asc`);
  return response.ok ? response.json() : null;
}
function quantityAvailable(rows, ticker, excludedId) {
  return rows.filter(row => row.id !== excludedId && row.ticker === ticker).reduce((quantity, row) => row.trade_type === 'BUY' ? quantity + Number(row.quantity) : row.trade_type === 'SELL' ? quantity - Number(row.quantity) : quantity, 0);
}
async function validateAgainstLedger(env, input, excludedId) {
  if (input.trade_type !== 'SELL' && !(input.trade_type === 'BUY' && input.funding_source === 'SETTLEMENT')) return null;
  const rows = await ledgerRows(env);
  if (!rows) return '보유 수량을 확인하지 못했습니다.';
  if (input.trade_type === 'SELL') return Number(input.quantity) > quantityAvailable(rows, input.ticker.toUpperCase(), excludedId) + 1e-7 ? '보유 수량보다 많이 매도할 수 없습니다.' : null;
  return Number(input.amount) > settlementBalance(rows, excludedId) + 0.005 ? '기존 매도대금 잔액보다 많이 매수할 수 없습니다.' : null;
}
async function marketHistory(ticker) {
  const cached = marketCache.get(ticker);
  if (cached?.value && cached.expires > Date.now()) return cached.value;
  const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=max&interval=1d&events=div%2Csplits`, { headers: { 'user-agent': 'Mozilla/5.0 portfolio-dashboard' } });
  if (!response.ok) throw new Error(`${ticker} 가격 이력을 불러오지 못했습니다.`);
  const result = (await response.json())?.chart?.result?.[0];
  const timestamps = result?.timestamp || [], closes = result?.indicators?.quote?.[0]?.close || [], adjusted = result?.indicators?.adjclose?.[0]?.adjclose || [];
  const points = timestamps.map((timestamp, index) => ({ date: new Date(timestamp * 1000).toISOString().slice(0, 10), close: Number(closes[index]), adjusted: Number(adjusted[index]) }))
    .filter(point => Number.isFinite(point.close) && point.close > 0);
  if (!points.length) throw new Error(`${ticker} 가격 이력이 없습니다.`);
  marketCache.set(ticker, { expires: Date.now() + 3600000, value: points });
  return points;
}
async function qqqDailyHistory() {
  const cacheKey = 'QQQ:full-daily';
  const cached = marketCache.get(cacheKey);
  if (cached?.value && cached.expires > Date.now()) return cached.value;
  const start = Date.UTC(1999, 2, 10);
  const end = Date.now() + 86400000;
  const chunkMilliseconds = 8 * 365 * 86400000;
  const ranges = [];
  for (let from = start; from < end; from += chunkMilliseconds) ranges.push([from, Math.min(from + chunkMilliseconds, end)]);
  const chunks = await Promise.all(ranges.map(async ([from, to]) => {
    const period1 = Math.floor(from / 1000), period2 = Math.floor(to / 1000);
    const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/QQQ?period1=${period1}&period2=${period2}&interval=1d&events=div%2Csplits`, { headers: { 'user-agent': 'Mozilla/5.0 portfolio-dashboard' } });
    if (!response.ok) throw new Error('QQQ 전체 일봉 이력을 불러오지 못했습니다.');
    const result = (await response.json())?.chart?.result?.[0];
    const timestamps = result?.timestamp || [], quote = result?.indicators?.quote?.[0] || {};
    const rawPoints = timestamps.map((timestamp, index) => ({
      date: new Date(timestamp * 1000).toISOString().slice(0, 10),
      close: Number(quote.close?.[index]),
      high: Number(quote.high?.[index]),
    }));
    const currentPrice = Number(result?.meta?.regularMarketPrice);
    const currentTimestamp = Number(result?.meta?.regularMarketTime);
    const currentDate = Number.isFinite(currentTimestamp) ? new Date(currentTimestamp * 1000).toISOString().slice(0, 10) : null;
    const currentDay = currentDate ? rawPoints.find(point => point.date === currentDate) : null;
    return {
      points: rawPoints.filter(point => Number.isFinite(point.close) && point.close > 0 && Number.isFinite(point.high) && point.high > 0),
      current: currentDate && Number.isFinite(currentPrice) && currentPrice > 0
        ? { date: currentDate, close: currentPrice, high: Number.isFinite(currentDay?.high) && currentDay.high > 0 ? currentDay.high : currentPrice }
        : null,
    };
  }));
  const byDate = new Map(chunks.flatMap(chunk => chunk.points).map(point => [point.date, point]));
  const current = chunks.map(chunk => chunk.current).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date)).at(-1);
  if (current) byDate.set(current.date, current);
  const points = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (!points.length) throw new Error('QQQ 전체 일봉 이력이 없습니다.');
  marketCache.set(cacheKey, { expires: Date.now() + 3600000, value: points });
  return points;
}
export function calculateMarketDrawdown(history, settings = STRATEGY_DEFAULTS) {
  const points = [...history]
    .map(point => ({ date: String(point.date), close: Number(point.close), high: Number(point.high ?? point.close) }))
    .filter(point => point.date && Number.isFinite(point.close) && point.close > 0 && Number.isFinite(point.high) && point.high > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!points.length) return null;
  let peak = -Infinity, peakIndex = 0;
  points.forEach((point, index) => { if (point.high >= peak) { peak = point.high; peakIndex = index; } });
  let minimum = 0, first20 = null, first30 = null;
  for (const point of points.slice(peakIndex)) {
    const drawdown = point.close / peak - 1;
    minimum = Math.min(minimum, drawdown);
    if (!first20 && drawdown <= Number(settings.qqqTrigger1) / 100 + 1e-10) first20 = point.date;
    if (!first30 && drawdown <= Number(settings.qqqTrigger2) / 100 + 1e-10) first30 = point.date;
  }
  const latest = points.at(-1);
  return { peak, peakDate: points[peakIndex].date, current: latest.close / peak - 1, cycleMinimum: minimum, stage: first30 ? 2 : first20 ? 1 : 0, first20, first30, latestPrice: latest.close, latestDate: latest.date, cycleId: `QQQ:${points[peakIndex].date}`, historyStart: points[0].date, historyEnd: latest.date, observations: points.length, peakScope: 'all_available_daily_history', peakBasis: 'daily_high' };
}
async function qqqStrategy(settings = STRATEGY_DEFAULTS) {
  const points = await qqqDailyHistory();
  return { drawdown: calculateMarketDrawdown(points, settings) };
}
async function linkedStrategyFields(env, input, previous = null) {
  const reason = input.reason || null;
  if (!reason || !['BUY', 'SELL'].includes(input.trade_type)) return { reason, strategy_cycle_id: null, strategy_trigger: null };
  if (previous?.reason === reason && previous.strategy_cycle_id) return { reason, strategy_cycle_id: previous.strategy_cycle_id, strategy_trigger: previous.strategy_trigger };
  if (reason === 'QQQ_DRAWDOWN_1' || reason === 'QQQ_DRAWDOWN_2') {
    const settings = await strategySettings(env) || STRATEGY_DEFAULTS;
    const { drawdown } = await qqqStrategy(settings);
    const required = reason === 'QQQ_DRAWDOWN_1' ? 1 : 2;
    if (drawdown.stage < required) throw new Error('현재 QQQ Drawdown 조건과 거래 사유가 일치하지 않습니다.');
    return { reason, strategy_cycle_id: drawdown.cycleId, strategy_trigger: required === 1 ? 'QQQ_20' : 'QQQ_30' };
  }
  if (reason === 'QLD_REBALANCE') {
    const requestedCycle = typeof input.strategy_cycle_id === 'string' && /^QLD:\d{4}-\d{2}-\d{2}$/.test(input.strategy_cycle_id) ? input.strategy_cycle_id : null;
    return { reason, strategy_cycle_id: requestedCycle || `QLD:${String(input.traded_at).slice(0, 10)}`, strategy_trigger: 'QLD_85' };
  }
  return { reason, strategy_cycle_id: null, strategy_trigger: null };
}

async function api(request, env, url) {
  if (url.pathname === '/api/session') {
    if (request.method === 'GET') return json({ authenticated: await allowed(request, env) });
    if (request.method === 'DELETE') return json({ ok: true }, 200, { 'set-cookie': clear });
    if (request.method !== 'POST') return json({ error: '허용되지 않은 요청입니다.' }, 405);
    const input = await body(request), given = enc.encode(input?.password || ''), expected = enc.encode(env.DASHBOARD_PASSWORD);
    let difference = given.length ^ expected.length;
    for (let index = 0; index < Math.max(given.length, expected.length); index += 1) difference |= (given[index] || 0) ^ (expected[index] || 0);
    if (difference) return json({ error: '비밀번호가 올바르지 않습니다.' }, 401);
    const token = await session(env), headers = { 'set-cookie': cookie(token) };
    return (request.headers.get('accept') || '').includes('text/html') ? new Response(null, { status: 303, headers: { ...headers, location: `/#session=${encodeURIComponent(token)}` } }) : json({ ok: true }, 200, headers);
  }
  if (!await allowed(request, env)) return json({ error: '접근 권한이 없습니다.' }, 401);
  if (url.pathname === '/api/data' && request.method === 'GET') {
    const [transactionResponse, snapshotResponse, adjustmentResponse] = await Promise.all([
      db(env, `/rest/v1/transactions?select=*&user_id=eq.${env.PORTFOLIO_USER_ID}&order=traded_at.desc`),
      db(env, `/rest/v1/daily_snapshots?select=snapshot_date,total_equity,total_cost,net_contributions,cash_balance,holdings,twr_daily_return,twr_coverage_start&user_id=eq.${env.PORTFOLIO_USER_ID}&order=snapshot_date.asc`),
      db(env, `/rest/v1/settlement_adjustments?select=*&user_id=eq.${env.PORTFOLIO_USER_ID}&order=adjusted_at.desc`),
    ]);
    if (!transactionResponse.ok || !snapshotResponse.ok || !adjustmentResponse.ok) return json({ error: '데이터를 읽지 못했습니다.' }, 502);
    return json({ transactions: await transactionResponse.json(), snapshots: await snapshotResponse.json(), adjustments: await adjustmentResponse.json() });
  }
  if (url.pathname === '/api/settlement-adjustments' && request.method === 'POST') {
    const input = await body(request);
    const expected = Number(input?.expectedBalance), actual = Number(input?.actualBalance);
    if (!Number.isFinite(expected) || !Number.isFinite(actual) || actual < 0 || !adjustmentReasons.has(input?.reason) || String(input?.memo || '').length > 500 || !input?.adjustedAt) return json({ error: '잔액 보정 입력값을 확인하세요.' }, 400);
    const rows = await ledgerRows(env);
    if (!rows) return json({ error: '현재 정산 잔액을 확인하지 못했습니다.' }, 502);
    const current = settlementBalance(rows), amount = actual - current;
    if (Math.abs(current - expected) > 0.005) return json({ error: '입력 중 잔액이 변경되었습니다. 새로고침 후 다시 확인하세요.', currentBalance: current }, 409);
    if (Math.abs(amount) < 0.01) return json({ error: '보정할 차이가 없습니다.' }, 400);
    const flow = contributionDelta(input.reason, amount);
    if (flow) await snapshot(env, { action: 'cash-flow-boundary', cashFlow: flow, occurredAt: input.adjustedAt });
    const response = await db(env, '/rest/v1/rpc/create_settlement_adjustment', { method: 'POST', body: JSON.stringify({ p_user_id: env.PORTFOLIO_USER_ID, p_expected_balance: expected, p_actual_balance: actual, p_adjusted_at: input.adjustedAt, p_reason: input.reason, p_memo: String(input.memo || '') }) });
    if (response.status === 409 || response.status === 400) return json({ error: '입력 중 잔액이 변경되었습니다. 새로고침 후 다시 확인하세요.' }, 409);
    if (!response.ok) return json({ error: '잔액 보정을 저장하지 못했습니다.' }, 502);
    const saved = await response.json();
    await snapshot(env, { action: 'rebuild', from: input.adjustedAt });
    await snapshot(env);
    return json(saved, 201);
  }
  const adjustmentMatch = url.pathname.match(/^\/api\/settlement-adjustments\/([0-9a-f-]{36})\/reverse$/i);
  if (adjustmentMatch && request.method === 'POST') {
    const input = await body(request);
    const response = await db(env, '/rest/v1/rpc/reverse_settlement_adjustment', { method: 'POST', body: JSON.stringify({ p_user_id: env.PORTFOLIO_USER_ID, p_adjustment_id: adjustmentMatch[1], p_adjusted_at: input?.adjustedAt || new Date().toISOString() }) });
    if (response.status === 409 || response.status === 400) return json({ error: '이미 취소되었거나 취소할 수 없는 보정입니다.' }, 409);
    if (!response.ok) return json({ error: '잔액 보정을 취소하지 못했습니다.' }, 502);
    const saved = await response.json();
    await snapshot(env, { action: 'rebuild', from: saved?.adjusted_at || input?.adjustedAt });
    await snapshot(env);
    return json(saved, 201);
  }
  if (url.pathname === '/api/settings' && request.method === 'GET') {
    try { return json({ settings: await strategySettings(env) }); } catch (error) { return json({ error: error.message }, 502); }
  }
  if (url.pathname === '/api/settings' && request.method === 'PUT') {
    const input = await body(request);
    if (!validSettings(input)) return json({ error: '투자전략 설정값을 확인하세요.' }, 400);
    const createOnly = input.createOnly === true;
    const response = await db(env, '/rest/v1/portfolio_strategy_settings?on_conflict=user_id', {
      method: 'POST', headers: { Prefer: `${createOnly ? 'resolution=ignore-duplicates' : 'resolution=merge-duplicates'},return=representation` },
      body: JSON.stringify({ user_id: env.PORTFOLIO_USER_ID, ...settingsToRow(input), updated_at: new Date().toISOString() }),
    });
    if (!response.ok) return json({ error: '투자전략을 저장하지 못했습니다.' }, 502);
    const saved = settingsFromRow((await response.json())[0]);
    if (saved) return json({ settings: saved });
    try { return json({ settings: await strategySettings(env) }); } catch { return json({ error: '투자전략을 확인하지 못했습니다.' }, 502); }
  }
  if (url.pathname === '/api/strategy' && request.method === 'GET') {
    try { return json(await qqqStrategy(await strategySettings(env) || STRATEGY_DEFAULTS)); } catch { return json({ drawdown: null }); }
  }
  if (url.pathname === '/api/benchmark' && request.method === 'GET') {
    try {
      const history = await qqqMarketHistory();
      const adjustedAvailable = history.some(point => Number.isFinite(point.adjusted) && point.adjusted > 0);
      return json({
        basis: adjustedAvailable ? 'adjusted_close' : 'close',
        points: history.filter(point => !adjustedAvailable || (Number.isFinite(point.adjusted) && point.adjusted > 0))
          .map(point => ({ date: point.date, value: adjustedAvailable ? point.adjusted : point.close })),
      });
    } catch { return json({ basis: null, points: [], error: 'QQQ 벤치마크를 불러오지 못했습니다.' }, 502); }
  }
  if (url.pathname === '/api/market-history' && request.method === 'POST') {
    const input = await body(request);
    const tickers = [...new Set(Array.isArray(input?.tickers) ? input.tickers.filter(ticker => ['QQQ', 'QLD', 'SGOV'].includes(ticker)) : [])].slice(0, 3);
    if (!tickers.length) return json({ error: '지원되는 ETF를 선택하세요.' }, 400);
    try {
      const entries = await Promise.all(tickers.map(async ticker => {
        const history = await marketHistory(ticker);
        const adjusted = history.some(point => Number.isFinite(point.adjusted) && point.adjusted > 0);
        return [ticker, history.filter(point => !adjusted || (Number.isFinite(point.adjusted) && point.adjusted > 0)).map(point => ({ date: point.date, value: adjusted ? point.adjusted : point.close }))];
      }));
      return json({ histories: Object.fromEntries(entries), source: 'Yahoo Finance', fetchedAt: new Date().toISOString(), adjustedPrices: true });
    } catch (error) { return json({ error: error.message }, 502); }
  }
  if (url.pathname === '/api/quotes' && request.method === 'POST') {
    const input = await body(request), tickers = [...new Set(Array.isArray(input?.tickers) ? input.tickers.filter(ticker => typeof ticker === 'string' && /^[A-Z.]{1,15}$/i.test(ticker)).map(ticker => ticker.toUpperCase()) : [])];
    if (!tickers.length) return json({ quotes: [], fetchedAt: new Date().toISOString() });
    const response = await db(env, '/functions/v1/market-quotes', { method: 'POST', body: JSON.stringify({ tickers }) });
    if (!response.ok) return json({ error: '시세를 불러오지 못했습니다.' }, 502);
    return new Response(await response.text(), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }
  if (url.pathname === '/api/transactions' && request.method === 'POST') {
    const input = await body(request);
    if (!valid(input)) return json({ error: '거래 입력값을 확인하세요.' }, 400);
    input.ticker = input.ticker.toUpperCase();
    if (input.trade_type === 'BUY' && !['NEW_CAPITAL', 'SETTLEMENT'].includes(input.funding_source)) return json({ error: '매수 자금 구분을 확인하세요.' }, 400);
    const ledgerError = await validateAgainstLedger(env, input);
    if (ledgerError) return json({ error: ledgerError }, 400);
    let strategyFields;
    try { strategyFields = await linkedStrategyFields(env, input); } catch (error) { return json({ error: error.message }, 400); }
    const isNewCapital = input.trade_type === 'BUY' && input.funding_source === 'NEW_CAPITAL';
    if (isNewCapital) await snapshot(env, { action: 'cash-flow-boundary', cashFlow: Number(input.amount), occurredAt: input.traded_at });
    const buyId = crypto.randomUUID();
    const transaction = { ...input, ...strategyFields, id: buyId, user_id: env.PORTFOLIO_USER_ID, fee: 0, memo: String(input.memo || '') };
    delete transaction.funding_source;
    const records = isNewCapital ? [{
      id: crypto.randomUUID(), user_id: env.PORTFOLIO_USER_ID, traded_at: input.traded_at, trade_type: 'DEPOSIT', ticker: 'CASH',
      quantity: 0, price: Number(input.amount), amount: Number(input.amount), fee: 0, reason: null, strategy_cycle_id: null, strategy_trigger: null,
      memo: `AUTO_FUND:${buyId}`,
    }, transaction] : [transaction];
    const response = await db(env, '/rest/v1/transactions', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(records) });
    if (!response.ok) return json({ error: '거래를 저장하지 못했습니다.' }, 502);
    const saved = await response.json(), snapshotUpdated = await snapshot(env);
    return json(Array.isArray(saved) ? saved.find(row => row.id === buyId) || saved.at(-1) : saved, 201, { 'x-snapshot-updated': String(snapshotUpdated) });
  }
  const match = url.pathname.match(/^\/api\/transactions\/([0-9a-f-]{36})$/i);
  if (match && request.method === 'PATCH') {
    const input = await body(request);
    if (!valid(input)) return json({ error: '거래 입력값을 확인하세요.' }, 400);
    input.ticker = input.ticker.toUpperCase();
    const ledgerError = await validateAgainstLedger(env, input, match[1]);
    if (ledgerError) return json({ error: ledgerError }, 400);
    const existing = await db(env, `/rest/v1/transactions?select=traded_at,reason,strategy_cycle_id,strategy_trigger&id=eq.${match[1]}&user_id=eq.${env.PORTFOLIO_USER_ID}&limit=1`);
    const previous = existing.ok ? (await existing.json())[0] : null;
    let strategyFields;
    try { strategyFields = await linkedStrategyFields(env, input, previous); } catch (error) { return json({ error: error.message }, 400); }
    const response = await db(env, `/rest/v1/transactions?id=eq.${match[1]}&user_id=eq.${env.PORTFOLIO_USER_ID}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ ...input, ...strategyFields, memo: String(input.memo || '') }) });
    if (!response.ok) return json({ error: '거래를 수정하지 못했습니다.' }, 502);
    const autoFundPath = `/rest/v1/transactions?user_id=eq.${env.PORTFOLIO_USER_ID}&memo=eq.${encodeURIComponent(`AUTO_FUND:${match[1]}`)}`;
    if (input.trade_type === 'BUY') await db(env, autoFundPath, { method: 'PATCH', body: JSON.stringify({ traded_at: input.traded_at, price: Number(input.amount), amount: Number(input.amount), fee: 0 }) });
    else await db(env, autoFundPath, { method: 'DELETE' });
    await snapshot(env, { action: 'rebuild', from: [previous?.traded_at, input.traded_at].filter(Boolean).sort()[0] });
    return new Response(await response.text(), { headers: { 'content-type': 'application/json' } });
  }
  if (match && request.method === 'DELETE') {
    const existing = await db(env, `/rest/v1/transactions?select=traded_at&id=eq.${match[1]}&user_id=eq.${env.PORTFOLIO_USER_ID}&limit=1`);
    const previous = existing.ok ? (await existing.json())[0] : null;
    const response = await db(env, `/rest/v1/transactions?id=eq.${match[1]}&user_id=eq.${env.PORTFOLIO_USER_ID}`, { method: 'DELETE' });
    if (!response.ok) return json({ error: '거래를 삭제하지 못했습니다.' }, 502);
    await db(env, `/rest/v1/transactions?user_id=eq.${env.PORTFOLIO_USER_ID}&memo=eq.${encodeURIComponent(`AUTO_FUND:${match[1]}`)}`, { method: 'DELETE' });
    await snapshot(env, { action: 'rebuild', from: previous?.traded_at });
    return new Response(null, { status: 204 });
  }
  return json({ error: '찾을 수 없는 요청입니다.' }, 404);
}

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/__health') return new Response('ok', { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });
    if (url.pathname.startsWith('/api/')) return api(request, env, url);
    return staticAsset(url.pathname) || new Response('찾을 수 없습니다.', { status: 404 });
  },
};

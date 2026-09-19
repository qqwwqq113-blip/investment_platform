const enc = new TextEncoder();
const b64 = value => btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const unb64 = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)), char => char.charCodeAt(0));
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
let strategyCache = { expires: 0, value: null };

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
  if (['BUY', 'SELL'].includes(row.trade_type)) return Number(row.quantity) > 0 && Number(row.price) > 0;
  return Number(row.amount) > 0 && row.ticker.toUpperCase() === 'CASH';
}
async function transactions(env) {
  const response = await db(env, `/rest/v1/transactions?select=*&user_id=eq.${env.PORTFOLIO_USER_ID}&order=traded_at.asc`);
  return response.ok ? response.json() : null;
}
function quantityAvailable(rows, ticker, excludedId) {
  return rows.filter(row => row.id !== excludedId && row.ticker === ticker).reduce((quantity, row) => row.trade_type === 'BUY' ? quantity + Number(row.quantity) : row.trade_type === 'SELL' ? quantity - Number(row.quantity) : quantity, 0);
}
async function validateAgainstLedger(env, input, excludedId) {
  if (input.trade_type !== 'SELL') return null;
  const rows = await transactions(env);
  if (!rows) return '보유 수량을 확인하지 못했습니다.';
  return Number(input.quantity) > quantityAvailable(rows, input.ticker.toUpperCase(), excludedId) + 1e-7 ? '보유 수량보다 많이 매도할 수 없습니다.' : null;
}
async function qqqStrategy() {
  if (strategyCache.value && strategyCache.expires > Date.now()) return strategyCache.value;
  const response = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/QQQ?range=max&interval=1d&events=splits', { headers: { 'user-agent': 'Mozilla/5.0 portfolio-dashboard' } });
  if (!response.ok) throw new Error('QQQ 가격 이력을 불러오지 못했습니다.');
  const result = (await response.json())?.chart?.result?.[0];
  const timestamps = result?.timestamp || [], closes = result?.indicators?.quote?.[0]?.close || [];
  const points = timestamps.map((timestamp, index) => ({ date: new Date(timestamp * 1000).toISOString().slice(0, 10), close: Number(closes[index]) })).filter(point => Number.isFinite(point.close) && point.close > 0);
  if (!points.length) throw new Error('QQQ 가격 이력이 없습니다.');
  let peak = -Infinity, peakIndex = 0;
  points.forEach((point, index) => { if (point.close >= peak) { peak = point.close; peakIndex = index; } });
  let minimum = 0, first20 = null, first30 = null;
  for (const point of points.slice(peakIndex)) {
    const drawdown = point.close / peak - 1;
    minimum = Math.min(minimum, drawdown);
    if (!first20 && drawdown <= -0.2 + 1e-10) first20 = point.date;
    if (!first30 && drawdown <= -0.3 + 1e-10) first30 = point.date;
  }
  const latest = points.at(-1);
  const value = { drawdown: { peak, peakDate: points[peakIndex].date, current: latest.close / peak - 1, cycleMinimum: minimum, stage: first30 ? 2 : first20 ? 1 : 0, first20, first30, latestPrice: latest.close, latestDate: latest.date } };
  strategyCache = { expires: Date.now() + 3600000, value };
  return value;
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
    const [transactionResponse, snapshotResponse] = await Promise.all([
      db(env, `/rest/v1/transactions?select=*&user_id=eq.${env.PORTFOLIO_USER_ID}&order=traded_at.desc`),
      db(env, `/rest/v1/daily_snapshots?select=snapshot_date,total_equity,total_cost,net_contributions,cash_balance,holdings,twr_daily_return,twr_coverage_start&user_id=eq.${env.PORTFOLIO_USER_ID}&order=snapshot_date.asc`),
    ]);
    if (!transactionResponse.ok || !snapshotResponse.ok) return json({ error: '데이터를 읽지 못했습니다.' }, 502);
    return json({ transactions: await transactionResponse.json(), snapshots: await snapshotResponse.json() });
  }
  if (url.pathname === '/api/strategy' && request.method === 'GET') {
    try { return json(await qqqStrategy()); } catch { return json({ drawdown: null }); }
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
    const ledgerError = await validateAgainstLedger(env, input);
    if (ledgerError) return json({ error: ledgerError }, 400);
    if (['DEPOSIT', 'WITHDRAW'].includes(input.trade_type)) await snapshot(env, { action: 'cash-flow-boundary', cashFlow: input.trade_type === 'DEPOSIT' ? Number(input.amount) : -Number(input.amount), occurredAt: input.traded_at });
    const response = await db(env, '/rest/v1/transactions', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ ...input, user_id: env.PORTFOLIO_USER_ID, memo: String(input.memo || '') }) });
    if (!response.ok) return json({ error: '거래를 저장하지 못했습니다.' }, 502);
    const saved = await response.text(), snapshotUpdated = await snapshot(env);
    return new Response(saved, { status: 201, headers: { 'content-type': 'application/json', 'x-snapshot-updated': String(snapshotUpdated) } });
  }
  const match = url.pathname.match(/^\/api\/transactions\/([0-9a-f-]{36})$/i);
  if (match && request.method === 'PATCH') {
    const input = await body(request);
    if (!valid(input)) return json({ error: '거래 입력값을 확인하세요.' }, 400);
    input.ticker = input.ticker.toUpperCase();
    const ledgerError = await validateAgainstLedger(env, input, match[1]);
    if (ledgerError) return json({ error: ledgerError }, 400);
    const existing = await db(env, `/rest/v1/transactions?select=traded_at&id=eq.${match[1]}&user_id=eq.${env.PORTFOLIO_USER_ID}&limit=1`);
    const previous = existing.ok ? (await existing.json())[0] : null;
    const response = await db(env, `/rest/v1/transactions?id=eq.${match[1]}&user_id=eq.${env.PORTFOLIO_USER_ID}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ ...input, memo: String(input.memo || '') }) });
    if (!response.ok) return json({ error: '거래를 수정하지 못했습니다.' }, 502);
    await snapshot(env, { action: 'rebuild', from: [previous?.traded_at, input.traded_at].filter(Boolean).sort()[0] });
    return new Response(await response.text(), { headers: { 'content-type': 'application/json' } });
  }
  if (match && request.method === 'DELETE') {
    const existing = await db(env, `/rest/v1/transactions?select=traded_at&id=eq.${match[1]}&user_id=eq.${env.PORTFOLIO_USER_ID}&limit=1`);
    const previous = existing.ok ? (await existing.json())[0] : null;
    const response = await db(env, `/rest/v1/transactions?id=eq.${match[1]}&user_id=eq.${env.PORTFOLIO_USER_ID}`, { method: 'DELETE' });
    if (!response.ok) return json({ error: '거래를 삭제하지 못했습니다.' }, 502);
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
    return env.ASSETS.fetch(url.pathname === '/' ? new Request(new URL('/index.html', request.url), request) : request);
  },
};

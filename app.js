import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = 'https://spzrzptymyulmxhmjbvk.supabase.co';
const supabaseKey = 'sb_publishable_erhED6hEL6zVgD70qz_Q5A_Q1k6E9QR';
const supabase = createClient(supabaseUrl, supabaseKey);
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const number = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 6 });
const defaultTargets = { QQQ: 10, QLD: 70, SGOV: 20 };
const colors = { QQQ: '#64a4ff', QLD: '#f5a524', SGOV: '#44c18a', CASH: '#8fa3b8' };
let currentUser = null;

const byId = (id) => document.getElementById(id);
const notice = (text, isError = false) => { const el = byId('notice'); el.textContent = text; el.classList.toggle('error', isError); };
const localDatetime = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
byId('traded-at').value = localDatetime();

function setAuthenticated(isAuthenticated) {
  byId('auth-card').classList.toggle('hidden', isAuthenticated);
  byId('dashboard').classList.toggle('hidden', !isAuthenticated);
  byId('sign-out').classList.toggle('hidden', !isAuthenticated);
}

function holdingsFrom(rows) {
  const holdings = new Map();
  for (const row of rows) {
    if (!['BUY', 'SELL'].includes(row.trade_type)) continue;
    const h = holdings.get(row.ticker) || { ticker: row.ticker, quantity: 0, cost: 0 };
    if (row.trade_type === 'BUY') { h.quantity += Number(row.quantity); h.cost += Number(row.amount) + Number(row.fee); }
    else if (h.quantity > 0) { const sold = Math.min(h.quantity, Number(row.quantity)); h.cost *= (h.quantity - sold) / h.quantity; h.quantity -= sold; }
    holdings.set(row.ticker, h);
  }
  return [...holdings.values()].filter((h) => h.quantity > 0.0000001);
}

function targetAllocations() {
  const saved = currentUser?.user_metadata?.target_allocations;
  if (!saved || typeof saved !== 'object') return { ...defaultTargets };
  return Object.fromEntries(Object.keys(defaultTargets).map((ticker) => [ticker, Number(saved[ticker]) || 0]));
}

function cashFrom(rows) {
  return [...rows].reverse().reduce((cash, row) => {
    const amount = Number(row.amount); const fee = Number(row.fee);
    if (row.trade_type === 'DEPOSIT') return cash + amount;
    if (row.trade_type === 'WITHDRAW') return cash - amount;
    if (row.trade_type === 'BUY') return cash - amount - fee;
    if (row.trade_type === 'SELL') return cash + amount - fee;
    return cash;
  }, 0);
}

function renderDonut(elementId, items, label) {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const visible = items.filter((item) => item.value > 0);
  if (total <= 0 || !visible.length) { byId(elementId).innerHTML = '<p class="empty-chart">표시할 자산이 없습니다.</p>'; return; }
  let cursor = 0;
  const stops = visible.map((item) => { const start = cursor; cursor += item.value / total * 100; return `${colors[item.ticker] || '#7f8ea3'} ${start.toFixed(2)}% ${cursor.toFixed(2)}%`; }).join(', ');
  byId(elementId).innerHTML = `<div class="donut" style="background:conic-gradient(${stops})"><div><strong>${label}</strong><span>${usd.format(total)}</span></div></div><ul class="legend">${visible.map((item) => `<li><i style="background:${colors[item.ticker] || '#7f8ea3'}"></i><span>${item.ticker}</span><b>${(item.value / total * 100).toFixed(1)}%</b></li>`).join('')}</ul>`;
}

function renderAllocation(rows, holdings) {
  const targets = targetAllocations();
  const cash = Math.max(0, cashFrom(rows));
  const current = Object.fromEntries(holdings.map((holding) => [holding.ticker, holding.cost]));
  current.CASH = cash;
  const total = Object.values(current).reduce((sum, value) => sum + value, 0);
  const targetItems = Object.entries(targets).map(([ticker, value]) => ({ ticker, value }));
  const currentItems = [...new Set([...Object.keys(targets), ...Object.keys(current)])].map((ticker) => ({ ticker, value: current[ticker] || 0 }));
  renderDonut('current-donut', currentItems, '현재');
  renderDonut('target-donut', targetItems, '목표');
  const allTickers = [...new Set([...Object.keys(targets), ...Object.keys(current)])];
  const driftRows = allTickers.map((ticker) => {
    const currentWeight = total ? (current[ticker] || 0) / total * 100 : 0;
    const target = targets[ticker] || 0;
    const drift = currentWeight - target;
    const action = ticker === 'CASH' ? (currentWeight > 5 ? '현금 활용 검토' : '유지') : drift > 5 ? '비중 축소 검토' : drift < -5 ? '추가 매수 검토' : '양호';
    return { ticker, currentWeight, target, drift, action };
  });
  const alerts = driftRows.filter((row) => row.ticker !== 'CASH' && Math.abs(row.drift) > 5).length;
  const pill = byId('allocation-status');
  pill.textContent = alerts ? `점검 필요 ${alerts}개` : '목표 범위 양호';
  pill.classList.toggle('warning', Boolean(alerts));
  byId('allocation-body').innerHTML = driftRows.map((row) => `<tr><td>${row.ticker}</td><td>${row.currentWeight.toFixed(1)}%</td><td>${row.target.toFixed(1)}%</td><td class="${Math.abs(row.drift) > 5 ? 'drift-alert' : ''}">${row.drift >= 0 ? '+' : ''}${row.drift.toFixed(1)}%p</td><td>${row.action}</td></tr>`).join('');
  for (const [ticker, value] of Object.entries(targets)) byId(`target-${ticker.toLowerCase()}`).value = value;
}

function renderHistory(snapshots) {
  const chart = byId('history-chart');
  const summary = byId('history-summary');
  const range = byId('history-range');
  if (!snapshots.length) {
    chart.innerHTML = '<p class="empty-chart">아직 저장된 일별 스냅샷이 없습니다.</p>';
    summary.textContent = '거래 기록은 정상적으로 관리됩니다. 이후 스냅샷을 저장하면 추이가 표시됩니다.';
    range.textContent = '';
    return;
  }
  const points = [...snapshots].sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
  const values = points.map((point) => Number(point.total_equity));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const padding = Math.max((max - min) * 0.12, 1);
  const low = min - padding;
  const high = max + padding;
  const width = 720;
  const height = 230;
  const x = (index) => points.length === 1 ? width / 2 : 24 + index * ((width - 48) / (points.length - 1));
  const y = (value) => 18 + (high - value) * ((height - 48) / (high - low));
  const line = points.map((point, index) => `${index ? 'L' : 'M'} ${x(index).toFixed(1)} ${y(Number(point.total_equity)).toFixed(1)}`).join(' ');
  const area = `${line} L ${x(points.length - 1).toFixed(1)} ${height - 22} L ${x(0).toFixed(1)} ${height - 22} Z`;
  const last = values.at(-1);
  const first = values[0];
  const change = last - first;
  const changePct = first ? (change / first) * 100 : 0;
  chart.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="area" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#64a4ff" stop-opacity=".35"/><stop offset="100%" stop-color="#64a4ff" stop-opacity="0"/></linearGradient></defs><path d="${area}" fill="url(#area)"/><path d="${line}" fill="none" stroke="#7fb2ff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>${points.map((point, index) => `<circle cx="${x(index).toFixed(1)}" cy="${y(Number(point.total_equity)).toFixed(1)}" r="${index === points.length - 1 ? 5 : 2.5}" fill="#cfe4ff"><title>${point.snapshot_date}: ${usd.format(Number(point.total_equity))}</title></circle>`).join('')}</svg>`;
  summary.textContent = `최근 자산 ${usd.format(last)} · 시작 대비 ${change >= 0 ? '+' : ''}${usd.format(change)} (${changePct >= 0 ? '+' : ''}${changePct.toFixed(1)}%)`;
  range.textContent = `${points[0].snapshot_date} — ${points.at(-1).snapshot_date}`;
}

function render(rows, snapshots) {
  const totalDeposits = rows.filter(r => r.trade_type === 'DEPOSIT').reduce((s,r) => s + Number(r.amount), 0);
  const totalWithdrawals = rows.filter(r => r.trade_type === 'WITHDRAW').reduce((s,r) => s + Number(r.amount), 0);
  const holdings = holdingsFrom([...rows].reverse());
  byId('net-invested').textContent = usd.format(totalDeposits - totalWithdrawals);
  byId('cost-basis').textContent = usd.format(holdings.reduce((s,h) => s + h.cost, 0));
  byId('holding-count').textContent = String(holdings.length);
  byId('holdings-body').innerHTML = holdings.length ? holdings.map(h => `<tr><td>${h.ticker}</td><td>${number.format(h.quantity)}</td><td>${usd.format(h.cost / h.quantity)}</td><td>${usd.format(h.cost)}</td></tr>`).join('') : '<tr><td colspan="4">아직 보유 종목이 없습니다.</td></tr>';
  byId('transactions-body').innerHTML = rows.length ? rows.map(r => `<tr><td>${new Date(r.traded_at).toLocaleString('ko-KR')}</td><td>${r.trade_type}</td><td>${r.ticker}</td><td>${number.format(r.quantity)}</td><td>${usd.format(r.amount)}</td><td>${usd.format(r.fee)}</td><td><button data-delete="${r.id}">삭제</button></td></tr>`).join('') : '<tr><td colspan="7">아직 저장된 거래가 없습니다.</td></tr>';
  renderAllocation(rows, holdings);
  renderHistory(snapshots);
}

async function loadData() {
  notice('불러오는 중…');
  const [transactionsResult, snapshotsResult] = await Promise.all([
    supabase.from('transactions').select('*').order('traded_at', { ascending: false }),
    supabase.from('daily_snapshots').select('snapshot_date,total_equity').order('snapshot_date', { ascending: true })
  ]);
  if (transactionsResult.error || snapshotsResult.error) { notice(`데이터를 불러오지 못했습니다: ${(transactionsResult.error || snapshotsResult.error).message}`, true); return; }
  render(transactionsResult.data, snapshotsResult.data); notice('');
}

byId('auth-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const email = byId('email').value.trim(); const password = byId('password').value;
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  byId('auth-message').textContent = error ? error.message : '';
  byId('auth-message').classList.toggle('error', Boolean(error));
});
byId('sign-out').addEventListener('click', () => supabase.auth.signOut());
byId('target-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const targets = Object.fromEntries(Object.keys(defaultTargets).map((ticker) => [ticker, Number(byId(`target-${ticker.toLowerCase()}`).value)]));
  const total = Object.values(targets).reduce((sum, value) => sum + value, 0);
  const message = byId('target-message');
  if (Object.values(targets).some((value) => !Number.isFinite(value) || value < 0) || total !== 100) { message.textContent = `합계가 정확히 100%여야 합니다. 현재 ${total}%`; message.classList.add('error'); return; }
  const { data, error } = await supabase.auth.updateUser({ data: { target_allocations: targets } });
  if (error) { message.textContent = `저장하지 못했습니다: ${error.message}`; message.classList.add('error'); return; }
  currentUser = data.user; message.textContent = '목표 비중을 저장했습니다.'; message.classList.remove('error'); await loadData();
});
byId('refresh').addEventListener('click', loadData);
byId('trade-type').addEventListener('change', () => { const cash = ['DEPOSIT', 'WITHDRAW'].includes(byId('trade-type').value); byId('ticker').value = cash ? 'CASH' : ''; byId('ticker').readOnly = cash; byId('quantity').value = '0'; byId('quantity').readOnly = cash; byId('price').value = '0'; });
byId('transaction-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const type = byId('trade-type').value; const quantity = Number(byId('quantity').value); const price = Number(byId('price').value); const fee = Number(byId('fee').value); const amount = ['DEPOSIT','WITHDRAW'].includes(type) ? price : quantity * price;
  const record = { traded_at: new Date(byId('traded-at').value).toISOString(), trade_type:type, ticker:byId('ticker').value.trim().toUpperCase(), quantity, price, amount, fee, memo:byId('memo').value.trim() };
  const { error } = await supabase.from('transactions').insert(record);
  if (error) { notice(`저장하지 못했습니다: ${error.message}`, true); return; }
  byId('transaction-form').reset(); byId('traded-at').value = localDatetime(); notice('거래를 저장했습니다.'); await loadData();
});
byId('transactions-body').addEventListener('click', async (event) => { const id = event.target.dataset.delete; if (!id || !confirm('이 거래 기록을 삭제할까요?')) return; const { error } = await supabase.from('transactions').delete().eq('id', id); if (error) notice(`삭제하지 못했습니다: ${error.message}`, true); else { notice('거래 기록을 삭제했습니다.'); await loadData(); } });

supabase.auth.onAuthStateChange((_event, session) => { currentUser = session?.user || null; setAuthenticated(Boolean(session)); if (session) loadData(); });
const { data: { session } } = await supabase.auth.getSession(); currentUser = session?.user || null; setAuthenticated(Boolean(session)); if (session) loadData();

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = 'https://spzrzptymyulmxhmjbvk.supabase.co';
const supabaseKey = 'sb_publishable_erhED6hEL6zVgD70qz_Q5A_Q1k6E9QR';
const supabase = createClient(supabaseUrl, supabaseKey);
const won = new Intl.NumberFormat('ko-KR', { style: 'currency', currency: 'KRW', maximumFractionDigits: 0 });
const number = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 6 });

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

function render(rows) {
  const totalDeposits = rows.filter(r => r.trade_type === 'DEPOSIT').reduce((s,r) => s + Number(r.amount), 0);
  const totalWithdrawals = rows.filter(r => r.trade_type === 'WITHDRAW').reduce((s,r) => s + Number(r.amount), 0);
  const holdings = holdingsFrom([...rows].reverse());
  byId('net-invested').textContent = won.format(totalDeposits - totalWithdrawals);
  byId('cost-basis').textContent = won.format(holdings.reduce((s,h) => s + h.cost, 0));
  byId('holding-count').textContent = String(holdings.length);
  byId('holdings-body').innerHTML = holdings.length ? holdings.map(h => `<tr><td>${h.ticker}</td><td>${number.format(h.quantity)}</td><td>${won.format(h.cost / h.quantity)}</td><td>${won.format(h.cost)}</td></tr>`).join('') : '<tr><td colspan="4">아직 보유 종목이 없습니다.</td></tr>';
  byId('transactions-body').innerHTML = rows.length ? rows.map(r => `<tr><td>${new Date(r.traded_at).toLocaleString('ko-KR')}</td><td>${r.trade_type}</td><td>${r.ticker}</td><td>${number.format(r.quantity)}</td><td>${won.format(r.amount)}</td><td>${won.format(r.fee)}</td><td><button data-delete="${r.id}">삭제</button></td></tr>`).join('') : '<tr><td colspan="7">아직 저장된 거래가 없습니다.</td></tr>';
}

async function loadData() {
  notice('불러오는 중…');
  const { data, error } = await supabase.from('transactions').select('*').order('traded_at', { ascending: false });
  if (error) { notice(`데이터를 불러오지 못했습니다: ${error.message}`, true); return; }
  render(data); notice('');
}

byId('auth-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const email = byId('email').value.trim(); const password = byId('password').value;
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  byId('auth-message').textContent = error ? error.message : '';
  byId('auth-message').classList.toggle('error', Boolean(error));
});
byId('sign-up').addEventListener('click', async () => {
  const email = byId('email').value.trim(); const password = byId('password').value;
  const { error } = await supabase.auth.signUp({ email, password });
  byId('auth-message').textContent = error ? error.message : '확인 이메일을 보냈습니다. 이메일 인증 후 로그인하세요.';
  byId('auth-message').classList.toggle('error', Boolean(error));
});
byId('sign-out').addEventListener('click', () => supabase.auth.signOut());
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

supabase.auth.onAuthStateChange((_event, session) => { setAuthenticated(Boolean(session)); if (session) loadData(); });
const { data: { session } } = await supabase.auth.getSession(); setAuthenticated(Boolean(session)); if (session) loadData();

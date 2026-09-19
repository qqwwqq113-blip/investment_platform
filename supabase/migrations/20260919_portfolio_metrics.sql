begin;

alter table public.daily_snapshots
  add column if not exists net_contributions numeric,
  add column if not exists twr_daily_return numeric,
  add column if not exists twr_coverage_start date;

update public.daily_snapshots
set net_contributions = total_cost
where net_contributions is null;

create table if not exists public.valuation_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  occurred_at timestamptz not null,
  equity_before_flow numeric not null check (equity_before_flow >= 0),
  cash_flow numeric not null,
  source text not null default 'transaction',
  created_at timestamptz not null default now()
);

create index if not exists valuation_events_user_time_idx
  on public.valuation_events (user_id, occurred_at);

alter table public.valuation_events enable row level security;
revoke all on table public.valuation_events from anon, authenticated;

commit;

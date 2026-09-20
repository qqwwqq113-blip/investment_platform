begin;

create table if not exists public.portfolio_strategy_settings (
  user_id uuid primary key,
  target_qqq numeric not null default 10 check (target_qqq between 0 and 100),
  target_qld numeric not null default 70 check (target_qld between 0 and 100),
  target_sgov numeric not null default 20 check (target_sgov between 0 and 100),
  qqq_trigger_1 numeric not null default -20 check (qqq_trigger_1 > -100 and qqq_trigger_1 < 0),
  qqq_trigger_1_sgov_pct numeric not null default 50 check (qqq_trigger_1_sgov_pct between 0 and 100),
  qqq_trigger_2 numeric not null default -30 check (qqq_trigger_2 > -100 and qqq_trigger_2 < qqq_trigger_1),
  qqq_trigger_2_remaining_pct numeric not null default 100 check (qqq_trigger_2_remaining_pct between 0 and 100),
  qld_rebalance_trigger numeric not null default 85 check (qld_rebalance_trigger between 0 and 100),
  updated_at timestamptz not null default now(),
  constraint portfolio_strategy_target_total check (target_qqq + target_qld + target_sgov = 100)
);

alter table public.portfolio_strategy_settings enable row level security;
revoke all on table public.portfolio_strategy_settings from anon, authenticated;

alter table public.transactions
  add column if not exists reason text,
  add column if not exists strategy_cycle_id text,
  add column if not exists strategy_trigger text;

alter table public.transactions drop constraint if exists transactions_reason_check;
alter table public.transactions add constraint transactions_reason_check check (
  reason is null or reason in (
    'REGULAR_BUY', 'QQQ_DRAWDOWN_1', 'QQQ_DRAWDOWN_2',
    'QLD_REBALANCE', 'NEW_CAPITAL', 'OTHER'
  )
);

alter table public.transactions drop constraint if exists transactions_strategy_trigger_check;
alter table public.transactions add constraint transactions_strategy_trigger_check check (
  strategy_trigger is null or strategy_trigger in ('QQQ_20', 'QQQ_30', 'QLD_85')
);

create index if not exists transactions_strategy_cycle_idx
  on public.transactions (user_id, strategy_cycle_id, strategy_trigger)
  where strategy_cycle_id is not null;

commit;


begin;

drop index if exists public.transactions_strategy_cycle_idx;
alter table public.transactions drop constraint if exists transactions_strategy_trigger_check;
alter table public.transactions drop constraint if exists transactions_reason_check;
alter table public.transactions
  drop column if exists strategy_trigger,
  drop column if exists strategy_cycle_id,
  drop column if exists reason;
drop table if exists public.portfolio_strategy_settings;

commit;

begin;

grant select, insert, update
  on table public.portfolio_strategy_settings
  to service_role;

notify pgrst, 'reload schema';

commit;

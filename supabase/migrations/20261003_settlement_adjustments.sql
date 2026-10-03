begin;

create table if not exists public.settlement_adjustments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  adjusted_at timestamptz not null,
  balance_before numeric not null,
  actual_balance numeric not null check (actual_balance >= 0),
  adjustment_amount numeric not null,
  contribution_delta numeric not null default 0,
  adjustment_reason text not null check (adjustment_reason in ('FEES_FX','MISSING_FLOW','DIVIDEND_INTEREST','EXECUTION_ROUNDING','OTHER')),
  memo text not null default '' check (char_length(memo) <= 500),
  reversed_adjustment_id uuid references public.settlement_adjustments(id),
  created_at timestamptz not null default now()
);
create unique index if not exists settlement_adjustments_one_reversal on public.settlement_adjustments(reversed_adjustment_id) where reversed_adjustment_id is not null;
create index if not exists settlement_adjustments_user_time on public.settlement_adjustments(user_id, adjusted_at desc);
alter table public.settlement_adjustments enable row level security;
revoke all on table public.settlement_adjustments from anon, authenticated;
grant select, insert on table public.settlement_adjustments to service_role;

create or replace function public.portfolio_settlement_balance(p_user_id uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce((select sum(case trade_type when 'DEPOSIT' then amount when 'WITHDRAW' then -amount when 'BUY' then -amount when 'SELL' then amount else 0 end) from public.transactions where user_id=p_user_id),0)
       + coalesce((select sum(adjustment_amount) from public.settlement_adjustments where user_id=p_user_id),0)
$$;

create or replace function public.create_settlement_adjustment(p_user_id uuid, p_expected_balance numeric, p_actual_balance numeric, p_adjusted_at timestamptz, p_reason text, p_memo text default '')
returns public.settlement_adjustments language plpgsql security definer set search_path = public as $$
declare v_current numeric; v_amount numeric; v_row public.settlement_adjustments;
begin
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));
  v_current := public.portfolio_settlement_balance(p_user_id);
  if abs(v_current-p_expected_balance) > 0.005 then raise exception 'stale balance' using errcode='40001'; end if;
  v_amount := p_actual_balance-v_current;
  if p_actual_balance < 0 or abs(v_amount) < 0.01 then raise exception 'invalid adjustment' using errcode='22023'; end if;
  insert into public.settlement_adjustments(user_id,adjusted_at,balance_before,actual_balance,adjustment_amount,contribution_delta,adjustment_reason,memo)
  values(p_user_id,p_adjusted_at,v_current,p_actual_balance,v_amount,case when p_reason in ('DIVIDEND_INTEREST','EXECUTION_ROUNDING') then 0 else v_amount end,p_reason,coalesce(p_memo,'')) returning * into v_row;
  return v_row;
end $$;

create or replace function public.reverse_settlement_adjustment(p_user_id uuid, p_adjustment_id uuid, p_adjusted_at timestamptz)
returns public.settlement_adjustments language plpgsql security definer set search_path = public as $$
declare v_original public.settlement_adjustments; v_current numeric; v_row public.settlement_adjustments;
begin
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));
  select * into v_original from public.settlement_adjustments where id=p_adjustment_id and user_id=p_user_id and reversed_adjustment_id is null;
  if not found or exists(select 1 from public.settlement_adjustments where reversed_adjustment_id=p_adjustment_id) then raise exception 'not reversible' using errcode='22023'; end if;
  v_current := public.portfolio_settlement_balance(p_user_id);
  insert into public.settlement_adjustments(user_id,adjusted_at,balance_before,actual_balance,adjustment_amount,contribution_delta,adjustment_reason,memo,reversed_adjustment_id)
  values(p_user_id,p_adjusted_at,v_current,v_current-v_original.adjustment_amount,-v_original.adjustment_amount,-v_original.contribution_delta,v_original.adjustment_reason,'보정 취소: '||coalesce(v_original.memo,''),p_adjustment_id) returning * into v_row;
  return v_row;
end $$;

revoke all on function public.portfolio_settlement_balance(uuid) from public, anon, authenticated;
revoke all on function public.create_settlement_adjustment(uuid,numeric,numeric,timestamptz,text,text) from public, anon, authenticated;
revoke all on function public.reverse_settlement_adjustment(uuid,uuid,timestamptz) from public, anon, authenticated;
grant execute on function public.portfolio_settlement_balance(uuid), public.create_settlement_adjustment(uuid,numeric,numeric,timestamptz,text,text), public.reverse_settlement_adjustment(uuid,uuid,timestamptz) to service_role;
notify pgrst, 'reload schema';
commit;

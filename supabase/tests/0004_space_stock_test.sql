begin;

create extension if not exists pgtap with schema extensions;

select plan(5);

select has_table('public', 'stock_area_balances', 'space stock balance exists');
select ok(
  exists (
    select 1
    from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname = 'apply_stock_movement'
  ),
  'stock trigger function remains available'
);
select ok(
  exists (
    select 1
    from pg_policy
    where polrelid = 'public.stock_area_balances'::regclass
      and polname = 'stock_area_balance_select'
  ),
  'space stock read policy exists'
);
select ok(
  exists (
    select 1
    from pg_class
    where relnamespace = 'public'::regnamespace
      and relname = 'v_stock_area_valuation'
      and relkind = 'v'
  ),
  'space stock valuation view exists'
);
select ok(
  exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.stock_movements'::regclass
      and tgname = 'stock_movements_apply'
  ),
  'stock movement trigger still updates balances'
);

select * from finish();
rollback;

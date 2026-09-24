begin;

create extension if not exists pgtap with schema extensions;

select plan(10);

select ok((select relrowsecurity from pg_class where oid = 'public.organizations'::regclass), 'organizations has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.products'::regclass), 'products has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.stock_movements'::regclass), 'stock_movements has RLS enabled');
select ok(exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'apply_stock_movement'), 'stock trigger function exists');
select ok(exists (select 1 from pg_trigger where tgname = 'stock_movements_immutable'), 'stock immutability trigger exists');
select ok(exists (select 1 from pg_trigger where tgname = 'stock_movements_apply'), 'stock balance trigger exists');
select ok(exists (select 1 from pg_policy where polrelid = 'public.stock_movements'::regclass and polname = 'mov_select'), 'stock movement read policy exists');
select ok(exists (select 1 from pg_policy where polrelid = 'public.products'::regclass and polname = 'prod_select'), 'product read policy exists');
select ok(exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'register_movement'), 'movement RPC exists');
select ok(exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'close_count'), 'count close RPC exists');

select * from finish();
rollback;

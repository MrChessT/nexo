begin;

create extension if not exists pgtap with schema extensions;

select plan(6);

select has_table('public', 'organizations', 'organizations exists');
select has_table('public', 'products', 'products exists');
select has_table('public', 'stock_movements', 'stock ledger exists');
select has_function('public', 'register_movement', ARRAY['uuid', 'uuid', 'movement_type', 'numeric', 'text', 'uuid', 'numeric', 'uuid'], 'movement RPC exists');
select has_function('public', 'send_transfer', ARRAY['uuid'], 'send transfer RPC exists');
select has_function('public', 'receive_transfer', ARRAY['uuid', 'jsonb'], 'receive transfer RPC exists');

select * from finish();
rollback;

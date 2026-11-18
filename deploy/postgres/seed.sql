-- Bulk-load the lab. Sizes come from psql variables, for example:
--   psql -v accounts=200000 -v symbols=2000 -v orders=20000000 -f seed.sql
-- Every account gets ten positions; orders are spread over the past year.
\set ON_ERROR_STOP on
\timing on

TRUNCATE accounts, prices, positions, orders, position_snapshots, daily_activity RESTART IDENTITY CASCADE;
DROP INDEX IF EXISTS orders_account_created;

INSERT INTO prices (symbol, close)
SELECT 'S' || lpad(i::text, 4, '0'), round((10 + random() * 490)::numeric, 4)
  FROM generate_series(1, :symbols) AS i;

-- Buying power is effectively unlimited so orders are never refused for money:
-- the drills are about the database, not the business rule.
INSERT INTO accounts (id, cash, buying_power)
SELECT i, 100000, 1000000000
  FROM generate_series(1, :accounts) AS i;

-- k * 131 is distinct mod 2000 for k in 1..10, so (account, symbol) is unique.
INSERT INTO positions (account_id, symbol, qty, avg_price)
SELECT a, 'S' || lpad((1 + ((a * 7 + k * 131) % :symbols))::text, 4, '0'),
       round((1 + random() * 100)::numeric, 6), round((10 + random() * 490)::numeric, 4)
  FROM generate_series(1, :accounts) AS a, generate_series(1, 10) AS k;

INSERT INTO orders (account_id, symbol, side, qty, limit_price, status, created_at)
SELECT 1 + (random() * (:accounts - 1))::bigint,
       'S' || lpad((1 + (random() * (:symbols - 1))::int)::text, 4, '0'),
       CASE WHEN random() < 0.5 THEN 'buy' ELSE 'sell' END,
       round((1 + random() * 100)::numeric, 6),
       round((10 + random() * 490)::numeric, 4),
       'filled',
       now() - random() * interval '365 days'
  FROM generate_series(1, :orders);

CREATE INDEX orders_account_created ON orders (account_id, created_at DESC);

VACUUM ANALYZE;

SELECT relname, n_live_tup, pg_size_pretty(pg_total_relation_size(relid)) AS size
  FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC;

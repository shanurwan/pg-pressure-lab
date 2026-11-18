-- Tables some scenarios need beyond the base schema. Idempotent: scripts/lab
-- applies it before every run, so an existing lab picks it up without a reseed.

-- A market-data table a feed updates thousands of times a second (xmin).
CREATE TABLE IF NOT EXISTS quotes (
    symbol     text PRIMARY KEY,
    bid        numeric(18,4) NOT NULL,
    ask        numeric(18,4) NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO quotes (symbol, bid, ask)
SELECT symbol, close - 0.01, close + 0.01 FROM prices
ON CONFLICT (symbol) DO NOTHING;

-- Fills point at orders with a 32-bit column although orders.id is 64-bit
-- (overflow). A foreign key between integer and bigint is allowed.
CREATE TABLE IF NOT EXISTS order_fills (
    id        bigserial PRIMARY KEY,
    order_id  integer NOT NULL REFERENCES orders (id),
    filled_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON quotes, order_fills TO app, batch, report;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app, batch, report;

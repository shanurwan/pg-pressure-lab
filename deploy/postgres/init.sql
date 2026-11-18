-- Roles and schema. Runs once, when the data volume is first created.
-- Separate roles let a drill give each workload its own settings
-- (ALTER ROLE ... SET), which survive PgBouncer's transaction pooling,
-- unlike settings sent at connect time.
CREATE ROLE app LOGIN;
CREATE ROLE batch LOGIN;
CREATE ROLE report LOGIN;

CREATE EXTENSION pg_stat_statements;

CREATE TABLE accounts (
    id            bigint PRIMARY KEY,
    status        text NOT NULL DEFAULT 'ACTIVE',
    cash          numeric(18,2) NOT NULL,
    buying_power  numeric(18,2) NOT NULL,
    equity        numeric(18,2) NOT NULL DEFAULT 0,
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE prices (
    symbol text PRIMARY KEY,
    close  numeric(18,4) NOT NULL
);

CREATE TABLE positions (
    account_id bigint NOT NULL REFERENCES accounts (id),
    symbol     text NOT NULL,
    qty        numeric(18,6) NOT NULL,
    avg_price  numeric(18,4) NOT NULL,
    PRIMARY KEY (account_id, symbol)
);

-- No foreign key and no secondary index yet: seed.sql adds the index after
-- the bulk load, and the migration drill works on this table.
CREATE TABLE orders (
    id          bigserial PRIMARY KEY,
    account_id  bigint NOT NULL,
    symbol      text NOT NULL,
    side        text NOT NULL,
    qty         numeric(18,6) NOT NULL,
    limit_price numeric(18,4),
    status      text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE position_snapshots (
    as_of        date NOT NULL,
    account_id   bigint NOT NULL,
    symbol       text NOT NULL,
    qty          numeric(18,6) NOT NULL,
    market_value numeric(20,4) NOT NULL,
    PRIMARY KEY (as_of, account_id, symbol)
);

CREATE TABLE daily_activity (
    as_of      date NOT NULL,
    account_id bigint NOT NULL,
    orders     bigint NOT NULL,
    notional   numeric(24,4) NOT NULL,
    PRIMARY KEY (as_of, account_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app, batch, report;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app, batch, report;

// Command batch is an end-of-day job: snapshot every position at the day's
// closing price, mark every account to market, and roll up the day's orders.
//
// It has two modes, so a drill can compare them under the same live traffic:
//
//	naive    one transaction for the whole job. Simple, atomic, and it holds a
//	         row lock on every account until the last step commits.
//	chunked  accounts in small ranges, one short transaction each, with a
//	         lock_timeout so the job yields to live orders instead of the other
//	         way round, a retry on lock timeout, and a pause between chunks.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"log"
	"os"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type result struct {
	Mode       string  `json:"mode"`
	AsOf       string  `json:"as_of"`
	StartedAt  string  `json:"started_at"`
	Seconds    float64 `json:"seconds"`
	Chunks     int     `json:"chunks"`
	Retries    int     `json:"lock_timeout_retries"`
	Snapshots  int64   `json:"snapshot_rows"`
	Accounts   int64   `json:"accounts_marked"`
	RollupRows int64   `json:"rollup_rows"`
	Error      string  `json:"error,omitempty"`
}

func main() {
	var (
		dsn         = flag.String("dsn", os.Getenv("DATABASE_URL"), "connection string")
		mode        = flag.String("mode", "naive", "naive or chunked")
		asOf        = flag.String("as-of", time.Now().UTC().Format("2006-01-02"), "business date")
		chunk       = flag.Int64("chunk", 1000, "accounts per transaction (chunked)")
		pause       = flag.Duration("pause", 20*time.Millisecond, "sleep between chunks (chunked)")
		lockTimeout = flag.String("lock-timeout", "100ms", "lock_timeout per chunk (chunked)")
		out         = flag.String("out", "", "write result JSON here")
	)
	flag.Parse()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, *dsn)
	if err != nil {
		log.Fatal(err)
	}
	defer func() { _ = conn.Close(ctx) }()

	res := result{Mode: *mode, AsOf: *asOf, StartedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	t0 := time.Now()
	switch *mode {
	case "naive":
		err = naive(ctx, conn, *asOf, &res)
	case "chunked":
		err = chunked(ctx, conn, *asOf, *chunk, *pause, *lockTimeout, &res)
	default:
		log.Fatalf("unknown mode %q", *mode)
	}
	res.Seconds = time.Since(t0).Seconds()
	if err != nil {
		res.Error = err.Error()
	}
	b, _ := json.MarshalIndent(res, "", "  ")
	log.Printf("%s", b)
	if *out != "" {
		if werr := os.WriteFile(*out, b, 0o644); werr != nil {
			log.Fatal(werr)
		}
	}
	if err != nil {
		os.Exit(1)
	}
}

const snapshotSQL = `
INSERT INTO position_snapshots (as_of, account_id, symbol, qty, market_value)
SELECT $1::date, p.account_id, p.symbol, p.qty, p.qty * pr.close
  FROM positions p JOIN prices pr USING (symbol)
 WHERE p.account_id BETWEEN $2 AND $3`

const markSQL = `
UPDATE accounts a
   SET equity = a.cash + s.mv, updated_at = now()
  FROM (SELECT account_id, sum(market_value) AS mv
          FROM position_snapshots
         WHERE as_of = $1::date AND account_id BETWEEN $2 AND $3
         GROUP BY account_id) s
 WHERE a.id = s.account_id`

// rollupSQL scans the orders table: there is no index on created_at alone.
// It is the heavy, read-mostly part of the job.
const rollupSQL = `
INSERT INTO daily_activity (as_of, account_id, orders, notional)
SELECT $1::date, account_id, count(*), sum(qty * coalesce(limit_price, 0))
  FROM orders
 WHERE created_at >= $1::date - 1 AND created_at < $1::date + 1
 GROUP BY account_id`

func bounds(ctx context.Context, conn *pgx.Conn) (lo, hi int64, err error) {
	err = conn.QueryRow(ctx, `SELECT min(id), max(id) FROM accounts`).Scan(&lo, &hi)
	return
}

func naive(ctx context.Context, conn *pgx.Conn, asOf string, res *result) error {
	lo, hi, err := bounds(ctx, conn)
	if err != nil {
		return err
	}
	res.Chunks = 1
	return pgx.BeginFunc(ctx, conn, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `DELETE FROM position_snapshots WHERE as_of = $1::date`, asOf); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM daily_activity WHERE as_of = $1::date`, asOf); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, snapshotSQL, asOf, lo, hi)
		if err != nil {
			return err
		}
		res.Snapshots = tag.RowsAffected()
		if tag, err = tx.Exec(ctx, markSQL, asOf, lo, hi); err != nil {
			return err
		}
		res.Accounts = tag.RowsAffected()
		// Every account row is now locked, and stays locked through the rollup.
		if tag, err = tx.Exec(ctx, rollupSQL, asOf); err != nil {
			return err
		}
		res.RollupRows = tag.RowsAffected()
		return nil
	})
}

func chunked(ctx context.Context, conn *pgx.Conn, asOf string, size int64, pause time.Duration,
	lockTimeout string, res *result) error {
	lo, hi, err := bounds(ctx, conn)
	if err != nil {
		return err
	}
	for from := lo; from <= hi; from += size {
		to := min(from+size-1, hi)
		for attempt := 0; ; attempt++ {
			err := pgx.BeginFunc(ctx, conn, func(tx pgx.Tx) error {
				if _, err := tx.Exec(ctx, `SELECT set_config('lock_timeout', $1, true)`, lockTimeout); err != nil {
					return err
				}
				if _, err := tx.Exec(ctx, `DELETE FROM position_snapshots
					WHERE as_of = $1::date AND account_id BETWEEN $2 AND $3`, asOf, from, to); err != nil {
					return err
				}
				tag, err := tx.Exec(ctx, snapshotSQL, asOf, from, to)
				if err != nil {
					return err
				}
				snaps := tag.RowsAffected()
				if tag, err = tx.Exec(ctx, markSQL, asOf, from, to); err != nil {
					return err
				}
				res.Snapshots += snaps
				res.Accounts += tag.RowsAffected()
				return nil
			})
			if err == nil {
				break
			}
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "55P03" && attempt < 20 {
				res.Retries++
				time.Sleep(time.Duration(attempt+1) * 50 * time.Millisecond)
				continue
			}
			return err
		}
		res.Chunks++
		time.Sleep(pause)
	}
	// The rollup takes no account locks, so it runs on its own.
	return pgx.BeginFunc(ctx, conn, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `DELETE FROM daily_activity WHERE as_of = $1::date`, asOf); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, rollupSQL, asOf)
		res.RollupRows = tag.RowsAffected()
		return err
	})
}

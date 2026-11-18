// Command migrate runs the schema changes and lock triggers the drills use.
//
//	alter-naive        a long read transaction holds a lock on accounts; ALTER
//	                   TABLE accounts ADD COLUMN waits behind it with no
//	                   lock_timeout, and every later query on accounts waits
//	                   behind the ALTER (the lock queue).
//	alter-locktimeout  the same, but the ALTER sets lock_timeout and retries
//	                   with backoff, so it never sits at the head of the queue.
//	index-plain        CREATE INDEX on orders(symbol): blocks writes to orders
//	                   for the whole build.
//	index-concurrently CREATE INDEX CONCURRENTLY: writes keep flowing.
//	lock               hold an ACCESS EXCLUSIVE lock on accounts for -hold: a
//	                   short, clean trigger for other drills.
//	idle-tx            open a REPEATABLE READ transaction, read one row, then
//	                   sit idle in transaction for -hold: the forgotten session
//	                   that holds back the xmin horizon.
//	cleanup            undo what the modes above leave behind, politely
//	                   (lock_timeout and retries), before a run starts.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"math/rand/v2"
	"os"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type result struct {
	Mode       string  `json:"mode"`
	StartedAt  string  `json:"started_at"`
	Seconds    float64 `json:"seconds"`
	LockWaitS  float64 `json:"lock_wait_s,omitempty"`   // how long the DDL waited for its lock
	Attempts   int     `json:"attempts,omitempty"`      // DDL attempts (lock_timeout mode)
	BuildS     float64 `json:"build_s,omitempty"`       // index build time
	ReaderHeld float64 `json:"reader_held_s,omitempty"` // how long the long reader held its lock
	Error      string  `json:"error,omitempty"`
}

func main() {
	var (
		dsn         = flag.String("dsn", os.Getenv("DATABASE_URL"), "connection string (direct to PostgreSQL)")
		mode        = flag.String("mode", "", "alter-naive | alter-locktimeout | index-plain | index-concurrently | lock | idle-tx | cleanup")
		hold        = flag.Duration("hold", 45*time.Second, "how long the long reader (or lock) is held")
		after       = flag.Duration("ddl-after", 2*time.Second, "start the DDL this long after the reader")
		lockTimeout = flag.String("lock-timeout", "1s", "lock_timeout per attempt (alter-locktimeout)")
		out         = flag.String("out", "", "write result JSON here")
	)
	flag.Parse()
	ctx := context.Background()
	res := result{Mode: *mode, StartedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	t0 := time.Now()
	var err error
	switch *mode {
	case "alter-naive":
		err = alter(ctx, *dsn, *hold, *after, "", &res)
	case "alter-locktimeout":
		err = alter(ctx, *dsn, *hold, *after, *lockTimeout, &res)
	case "index-plain":
		err = index(ctx, *dsn, false, &res)
	case "index-concurrently":
		err = index(ctx, *dsn, true, &res)
	case "lock":
		err = lock(ctx, *dsn, *hold, &res)
	case "idle-tx":
		err = idleTx(ctx, *dsn, *hold, &res)
	case "cleanup":
		err = cleanup(ctx, *dsn)
	default:
		log.Fatalf("unknown -mode %q", *mode)
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

func connect(ctx context.Context, dsn string) *pgx.Conn {
	c, err := pgx.Connect(ctx, dsn)
	if err != nil {
		log.Fatal(err)
	}
	return c
}

// alter reproduces the lock queue: a reader holds ACCESS SHARE on accounts
// (an analytics query, a forgotten transaction), the ALTER needs ACCESS
// EXCLUSIVE and waits, and PostgreSQL queues every later request behind the
// ALTER, even plain SELECTs that would not conflict with the reader.
func alter(ctx context.Context, dsn string, hold, after time.Duration, lockTimeout string, res *result) error {
	reader, ddl := connect(ctx, dsn), connect(ctx, dsn)
	defer func() { _ = reader.Close(ctx); _ = ddl.Close(ctx) }()

	readerDone := make(chan error, 1)
	go func() {
		r0 := time.Now()
		err := pgx.BeginFunc(ctx, reader, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, `SELECT count(*) FROM accounts`); err != nil {
				return err
			}
			time.Sleep(hold) // the transaction stays open, holding its lock
			return nil
		})
		res.ReaderHeld = time.Since(r0).Seconds()
		readerDone <- err
	}()
	time.Sleep(after)

	const ddlSQL = `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS migration_note text`
	w0 := time.Now()
	if lockTimeout == "" {
		_, err := ddl.Exec(ctx, ddlSQL)
		res.LockWaitS, res.Attempts = time.Since(w0).Seconds(), 1
		if err != nil {
			return err
		}
	} else {
		if _, err := ddl.Exec(ctx, `SELECT set_config('lock_timeout', $1, false)`, lockTimeout); err != nil {
			return err
		}
		backoff := 500 * time.Millisecond
		for {
			res.Attempts++
			_, err := ddl.Exec(ctx, ddlSQL)
			if err == nil {
				break
			}
			if !isCode(err, "55P03") || res.Attempts >= 200 {
				return err
			}
			// Back off with jitter so we are not at the head of the queue again
			// right away; cap it so the change still lands soon after the reader.
			time.Sleep(backoff/2 + time.Duration(rand.Int64N(int64(backoff))))
			backoff = min(backoff*2, 4*time.Second)
		}
		res.LockWaitS = time.Since(w0).Seconds()
	}
	return <-readerDone
}

// index builds an index on the 20M-row orders table, plain or CONCURRENTLY.
func index(ctx context.Context, dsn string, concurrently bool, res *result) error {
	c := connect(ctx, dsn)
	defer func() { _ = c.Close(ctx) }()
	sql := `CREATE INDEX orders_symbol_idx ON orders (symbol)`
	if concurrently {
		sql = `CREATE INDEX CONCURRENTLY orders_symbol_idx ON orders (symbol)`
	}
	b0 := time.Now()
	_, err := c.Exec(ctx, sql)
	res.BuildS = time.Since(b0).Seconds()
	return err
}

// lock holds ACCESS EXCLUSIVE on accounts for hold: every request touching
// accounts waits. A clean, repeatable trigger of fixed length.
func lock(ctx context.Context, dsn string, hold time.Duration, res *result) error {
	c := connect(ctx, dsn)
	defer func() { _ = c.Close(ctx) }()
	return pgx.BeginFunc(ctx, c, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `LOCK TABLE accounts IN ACCESS EXCLUSIVE MODE`); err != nil {
			return err
		}
		time.Sleep(hold)
		res.ReaderHeld = hold.Seconds()
		return nil
	})
}

// idleTx keeps a snapshot open while doing nothing. If the role has an
// idle_in_transaction_session_timeout, the server ends the session and the
// error is recorded (that is the fix working, not a failure of the drill).
func idleTx(ctx context.Context, dsn string, hold time.Duration, res *result) error {
	c := connect(ctx, dsn)
	defer func() { _ = c.Close(ctx) }()
	t0 := time.Now()
	tx, err := c.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `SELECT 1 FROM quotes LIMIT 1`); err != nil {
		return err
	}
	time.Sleep(hold)
	err = tx.Commit(ctx)
	res.ReaderHeld = time.Since(t0).Seconds()
	if err != nil {
		res.Error = "session ended while idle: " + err.Error()
		return nil
	}
	return nil
}

// cleanup removes the column and index the migration drills add, with a short
// lock_timeout and retries so cleaning up can never cause its own outage.
func cleanup(ctx context.Context, dsn string) error {
	c := connect(ctx, dsn)
	defer func() { _ = c.Close(ctx) }()
	stmts := []string{
		`ALTER TABLE accounts DROP COLUMN IF EXISTS migration_note`,
		`DROP INDEX CONCURRENTLY IF EXISTS orders_symbol_idx`,
	}
	for _, s := range stmts {
		var err error
		for attempt := 0; attempt < 30; attempt++ {
			if _, err = c.Exec(ctx, `SET lock_timeout = '2s'`); err != nil {
				return err
			}
			if _, err = c.Exec(ctx, s); err == nil || !isCode(err, "55P03") {
				break
			}
			time.Sleep(time.Second)
		}
		if err != nil {
			return fmt.Errorf("%s: %w", s, err)
		}
	}
	return nil
}

func isCode(err error, code string) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == code
}

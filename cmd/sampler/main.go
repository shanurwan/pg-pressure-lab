// Command sampler records, once a second, what each layer can see during a
// drill: PostgreSQL (pg_stat_activity), PgBouncer (SHOW POOLS) and the API's
// own connection pool. Lined up against the load generator's per-second
// results, it shows which signal moves first, and so which one to alert on.
package main

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
)

const activitySQL = `
SELECT count(*) FILTER (WHERE state = 'active'),
       count(*) FILTER (WHERE state = 'idle in transaction'),
       count(*) FILTER (WHERE wait_event_type = 'Lock'),
       count(*),
       coalesce(extract(epoch FROM max(now() - xact_start) FILTER (WHERE state <> 'idle')), 0)
  FROM pg_stat_activity
 WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()`

// sessionsSQL counts sessions ever started, and those whose client went away
// without closing them. Their per-second change is connection churn: a pooled
// system that is healthy starts almost no new sessions.
const sessionsSQL = `
SELECT sessions, sessions_abandoned FROM pg_stat_database WHERE datname = current_database()`

// healthSQL watches slow-burning trouble: dead row versions and size of the
// hot quotes table, how far back the oldest snapshot holds the xmin horizon
// (in transactions), and how many ids the orders sequence has left before it
// passes the largest 32-bit integer.
const healthSQL = `
SELECT coalesce((SELECT n_dead_tup FROM pg_stat_user_tables WHERE relname = 'quotes'), 0),
       coalesce(pg_total_relation_size(to_regclass('quotes')), 0),
       coalesce((SELECT max(age(backend_xmin)) FROM pg_stat_activity WHERE backend_xmin IS NOT NULL), 0),
       2147483647 - (SELECT last_value FROM orders_id_seq)`

type row struct {
	pgActive, pgIdleInTx, pgLockWait, pgTotal  int64
	longestXact                                float64
	bouncerWaiting, bouncerMaxWaitMs           int64
	poolAcquired, poolEmptyDelta               int64
	sessionsDelta, abandonedDelta              int64
	quotesDead, quotesBytes, xminAge, int4Left int64
}

func main() {
	var (
		pgDSN      = flag.String("pg", "postgres://postgres@pg-primary:5432/lab", "PostgreSQL (direct)")
		bouncerDSN = flag.String("bouncer", "postgres://postgres@pgbouncer:6432/pgbouncer", "PgBouncer admin console")
		apiURL     = flag.String("api", "http://api:8080", "API base URL")
		out        = flag.String("out", "", "CSV file (required)")
		every      = flag.Duration("every", time.Second, "sample interval")
	)
	flag.Parse()
	if *out == "" {
		log.Fatal("-out is required")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pg, err := pgx.Connect(ctx, *pgDSN)
	if err != nil {
		log.Fatal(err)
	}
	bcfg, err := pgx.ParseConfig(*bouncerDSN)
	if err != nil {
		log.Fatal(err)
	}
	bcfg.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol // the admin console speaks only simple protocol
	bouncer, err := pgx.ConnectConfig(ctx, bcfg)
	if err != nil {
		log.Fatal(err)
	}

	f, err := os.Create(*out)
	if err != nil {
		log.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	w := csv.NewWriter(f)
	_ = w.Write([]string{"t", "pg_active", "pg_idle_in_tx", "pg_lock_wait", "pg_total", "longest_xact_s",
		"bouncer_cl_waiting", "bouncer_maxwait_ms", "pool_acquired", "pool_empty_acquires",
		"pg_sessions_started", "pg_sessions_abandoned",
		"quotes_dead_tup", "quotes_bytes", "oldest_xmin_age", "int4_ids_left"})

	httpc := &http.Client{Timeout: 500 * time.Millisecond}
	var lastEmpty, lastSessions, lastAbandoned int64 = -1, -1, -1
	tick := time.NewTicker(*every)
	defer tick.Stop()
	for {
		var r row
		if err := pg.QueryRow(ctx, activitySQL).Scan(&r.pgActive, &r.pgIdleInTx, &r.pgLockWait, &r.pgTotal,
			&r.longestXact); err != nil && ctx.Err() == nil {
			log.Printf("pg_stat_activity: %v", err)
		}
		var sessions, abandoned int64
		if err := pg.QueryRow(ctx, sessionsSQL).Scan(&sessions, &abandoned); err == nil {
			if lastSessions >= 0 {
				r.sessionsDelta, r.abandonedDelta = sessions-lastSessions, abandoned-lastAbandoned
			}
			lastSessions, lastAbandoned = sessions, abandoned
		} else if ctx.Err() == nil {
			log.Printf("pg_stat_database: %v", err)
		}
		if err := pg.QueryRow(ctx, healthSQL).Scan(&r.quotesDead, &r.quotesBytes, &r.xminAge, &r.int4Left); err != nil && ctx.Err() == nil {
			log.Printf("health: %v", err)
		}
		r.bouncerWaiting, r.bouncerMaxWaitMs = bouncerPools(ctx, bouncer)
		if acq, empty, ok := apiPool(httpc, *apiURL); ok {
			r.poolAcquired = acq
			if lastEmpty >= 0 {
				r.poolEmptyDelta = empty - lastEmpty
			}
			lastEmpty = empty
		}
		_ = w.Write([]string{time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
			i(r.pgActive), i(r.pgIdleInTx), i(r.pgLockWait), i(r.pgTotal),
			strconv.FormatFloat(r.longestXact, 'f', 2, 64),
			i(r.bouncerWaiting), i(r.bouncerMaxWaitMs), i(r.poolAcquired), i(r.poolEmptyDelta),
			i(r.sessionsDelta), i(r.abandonedDelta),
			i(r.quotesDead), i(r.quotesBytes), i(r.xminAge), i(r.int4Left)})
		w.Flush()
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

// bouncerPools sums waiting clients over all pools and returns the longest
// wait. cl_waiting > 0 means clients are queued for a server connection.
func bouncerPools(ctx context.Context, c *pgx.Conn) (waiting, maxWaitMs int64) {
	rows, err := c.Query(ctx, "SHOW POOLS")
	if err != nil {
		if ctx.Err() == nil {
			log.Printf("SHOW POOLS: %v", err)
		}
		return 0, 0
	}
	defer rows.Close()
	idx := map[string]int{}
	for n, fd := range rows.FieldDescriptions() {
		idx[fd.Name] = n
	}
	for rows.Next() {
		vals, err := rows.Values()
		if err != nil {
			continue
		}
		waiting += num(vals, idx, "cl_waiting")
		ms := num(vals, idx, "maxwait")*1000 + num(vals, idx, "maxwait_us")/1000
		maxWaitMs = max(maxWaitMs, ms)
	}
	return waiting, maxWaitMs
}

func num(vals []any, idx map[string]int, col string) int64 {
	n, ok := idx[col]
	if !ok || n >= len(vals) {
		return 0
	}
	switch v := vals[n].(type) {
	case string:
		x, _ := strconv.ParseInt(v, 10, 64)
		return x
	case int64:
		return v
	case int32:
		return int64(v)
	}
	return 0
}

// apiPool reads the write pool's state from the API's /debug/pools.
func apiPool(c *http.Client, base string) (acquired, emptyAcquires int64, ok bool) {
	resp, err := c.Get(base + "/debug/pools")
	if err != nil {
		return 0, 0, false
	}
	defer func() { _ = resp.Body.Close() }()
	var p map[string]struct {
		Acquired          int64 `json:"acquired"`
		EmptyAcquireCount int64 `json:"empty_acquire_count"`
	}
	if json.NewDecoder(resp.Body).Decode(&p) != nil {
		return 0, 0, false
	}
	wp := p["write"]
	return wp.Acquired, wp.EmptyAcquireCount, true
}

func i(v int64) string { return strconv.FormatInt(v, 10) }

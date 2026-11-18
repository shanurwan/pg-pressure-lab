// Command api is a small brokerage-style HTTP API on PostgreSQL. It exists to be
// put under pressure: account and position reads, order placement that locks the
// account row, and one slow reporting endpoint.
//
// Pools are configured by environment variables so a drill can change the
// topology without a code change:
//
//	DATABASE_URL         writes and, by default, everything else
//	READ_DATABASE_URL    optional pool for the read endpoints
//	REPORT_DATABASE_URL  optional pool for /activity (a bulkhead)
//	REQUEST_TIMEOUT      per-request deadline, default 2s
//	ACQUIRE_TIMEOUT      give up waiting for a pool connection after this long
//	                     and answer 503 pool_exhausted (default 0: wait for the
//	                     whole request deadline)
//	MIN_QUERY_BUDGET     do not start a query with less than this much of the
//	                     request deadline left; answer 503 budget_exhausted
//	                     (default 0: always start)
//	CANCEL_MODE          what pgx does when a request's context is cancelled
//	                     mid-query: deadline (pgx's default, closes the
//	                     connection) or cancel_request (asks the server to
//	                     cancel and keeps the connection if it can)
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgconn/ctxwatch"
	"github.com/jackc/pgx/v5/pgxpool"
)

type server struct {
	write          *pgxpool.Pool
	read           *pgxpool.Pool
	report         *pgxpool.Pool
	timeout        time.Duration
	acquireTimeout time.Duration
	minBudget      time.Duration
}

func main() {
	ctx := context.Background()
	s := &server{
		timeout:        mustDuration("REQUEST_TIMEOUT", "2s"),
		acquireTimeout: mustDuration("ACQUIRE_TIMEOUT", "0"),
		minBudget:      mustDuration("MIN_QUERY_BUDGET", "0"),
	}
	s.write = mustPool(ctx, "DATABASE_URL", os.Getenv("DATABASE_URL"))
	s.read = s.write
	if u := os.Getenv("READ_DATABASE_URL"); u != "" {
		s.read = mustPool(ctx, "READ_DATABASE_URL", u)
	}
	s.report = s.read
	if u := os.Getenv("REPORT_DATABASE_URL"); u != "" {
		s.report = mustPool(ctx, "REPORT_DATABASE_URL", u)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/accounts/{id}", s.handle(s.account))
	mux.HandleFunc("GET /v1/accounts/{id}/positions", s.handle(s.positions))
	mux.HandleFunc("GET /v1/accounts/{id}/orders", s.handle(s.orders))
	mux.HandleFunc("GET /v1/activity/{symbol}", s.handle(s.activity))
	mux.HandleFunc("POST /v1/orders", s.handle(s.placeOrder))
	mux.HandleFunc("GET /debug/pools", s.pools)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })

	addr := getenv("LISTEN_ADDR", ":8080")
	log.Printf("listening on %s, request timeout %s, acquire timeout %s, min query budget %s",
		addr, s.timeout, s.acquireTimeout, s.minBudget)
	srv := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	log.Fatal(srv.ListenAndServe())
}

func mustPool(ctx context.Context, name, url string) *pgxpool.Pool {
	if url == "" {
		log.Fatalf("%s is required", name)
	}
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		log.Fatalf("%s: %v", name, err)
	}
	mode := getenv("CANCEL_MODE", "deadline")
	switch mode {
	case "deadline":
		// pgx's default: on a cancelled context, set an immediate deadline on
		// the socket. The in-flight read fails and the connection is closed,
		// so the pool must open a new one (and PgBouncer a new server session).
	case "cancel_request":
		// Ask the server to cancel the query first, and keep the connection if
		// it answers within DeadlineDelay.
		cfg.ConnConfig.BuildContextWatcherHandler = func(c *pgconn.PgConn) ctxwatch.Handler {
			return &pgconn.CancelRequestContextWatcherHandler{Conn: c, DeadlineDelay: time.Second}
		}
	default:
		log.Fatalf("CANCEL_MODE %q: want deadline or cancel_request", mode)
	}
	p, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		log.Fatalf("%s: %v", name, err)
	}
	log.Printf("%s: max %d connections, cancel mode %s", name, cfg.MaxConns, mode)
	return p
}

func mustDuration(name, def string) time.Duration {
	d, err := time.ParseDuration(getenv(name, def))
	if err != nil {
		log.Fatalf("%s: %v", name, err)
	}
	return d
}

// withConn runs fn on a pooled connection, refusing early instead of starting
// work that cannot finish in time. A request that waited most of its deadline
// for a connection and then starts a query will almost certainly be cancelled
// mid-query; that cancellation also costs the connection, so the next request
// waits longer still. Failing fast keeps the pool doing useful work.
func (s *server) withConn(ctx context.Context, p *pgxpool.Pool, fn func(*pgxpool.Conn) error) error {
	actx := ctx
	if s.acquireTimeout > 0 {
		var cancel context.CancelFunc
		actx, cancel = context.WithTimeout(ctx, s.acquireTimeout)
		defer cancel()
	}
	c, err := p.Acquire(actx)
	if err != nil {
		if ctx.Err() == nil && actx.Err() != nil {
			return &apiError{http.StatusServiceUnavailable, "pool_exhausted"}
		}
		return err
	}
	defer c.Release()
	if dl, ok := ctx.Deadline(); ok && s.minBudget > 0 && time.Until(dl) < s.minBudget {
		return &apiError{http.StatusServiceUnavailable, "budget_exhausted"}
	}
	return fn(c)
}

// apiError is an error with the HTTP status and a short machine-readable code
// that the load generator counts.
type apiError struct {
	status int
	code   string
}

func (e *apiError) Error() string { return e.code }

func (s *server) handle(fn func(context.Context, *http.Request) (any, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), s.timeout)
		defer cancel()
		body, err := fn(ctx, r)
		if err != nil {
			ae := classify(err)
			writeJSON(w, ae.status, map[string]string{"error": ae.code})
			return
		}
		writeJSON(w, http.StatusOK, body)
	}
}

// classify maps database and deadline errors to the codes a drill reports.
// The distinction matters: a statement_timeout or lock_timeout is the database
// protecting itself, a deadline is the caller giving up while still queued.
func classify(err error) *apiError {
	var ae *apiError
	if errors.As(err, &ae) {
		return ae
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return &apiError{http.StatusNotFound, "not_found"}
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "57014":
			// Same SQLSTATE for statement_timeout and for a cancel request
			// (pgx's cancel_request mode); only the message tells them apart.
			if strings.Contains(pgErr.Message, "statement timeout") {
				return &apiError{http.StatusServiceUnavailable, "statement_timeout"}
			}
			return &apiError{http.StatusServiceUnavailable, "canceled"}
		case "55P03":
			return &apiError{http.StatusServiceUnavailable, "lock_timeout"}
		case "40P01":
			return &apiError{http.StatusServiceUnavailable, "deadlock"}
		case "53300":
			return &apiError{http.StatusServiceUnavailable, "too_many_connections"}
		}
		return &apiError{http.StatusInternalServerError, "pg_" + pgErr.Code}
	}
	if errors.Is(err, context.DeadlineExceeded) || pgconn.Timeout(err) {
		return &apiError{http.StatusGatewayTimeout, "deadline"}
	}
	return &apiError{http.StatusInternalServerError, "internal"}
}

func pathID(r *http.Request) (int64, error) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		return 0, &apiError{http.StatusBadRequest, "bad_id"}
	}
	return id, nil
}

type account struct {
	ID          int64   `json:"id"`
	Status      string  `json:"status"`
	Cash        float64 `json:"cash"`
	BuyingPower float64 `json:"buying_power"`
	Equity      float64 `json:"equity"`
}

func (s *server) account(ctx context.Context, r *http.Request) (any, error) {
	id, err := pathID(r)
	if err != nil {
		return nil, err
	}
	a := account{ID: id}
	err = s.withConn(ctx, s.read, func(c *pgxpool.Conn) error {
		return c.QueryRow(ctx,
			`SELECT status, cash, buying_power, equity FROM accounts WHERE id = $1`, id).
			Scan(&a.Status, &a.Cash, &a.BuyingPower, &a.Equity)
	})
	return a, err
}

type position struct {
	Symbol   string  `json:"symbol"`
	Qty      float64 `json:"qty"`
	AvgPrice float64 `json:"avg_price"`
}

func (s *server) positions(ctx context.Context, r *http.Request) (any, error) {
	id, err := pathID(r)
	if err != nil {
		return nil, err
	}
	var out []position
	err = s.withConn(ctx, s.read, func(c *pgxpool.Conn) error {
		rows, _ := c.Query(ctx,
			`SELECT symbol, qty, avg_price FROM positions WHERE account_id = $1 ORDER BY symbol`, id)
		out, err = pgx.CollectRows(rows, pgx.RowToStructByPos[position])
		return err
	})
	return out, err
}

type order struct {
	ID         int64     `json:"id"`
	Symbol     string    `json:"symbol"`
	Side       string    `json:"side"`
	Qty        float64   `json:"qty"`
	LimitPrice float64   `json:"limit_price"`
	Status     string    `json:"status"`
	CreatedAt  time.Time `json:"created_at"`
}

func (s *server) orders(ctx context.Context, r *http.Request) (any, error) {
	id, err := pathID(r)
	if err != nil {
		return nil, err
	}
	var out []order
	err = s.withConn(ctx, s.read, func(c *pgxpool.Conn) error {
		rows, _ := c.Query(ctx,
			`SELECT id, symbol, side, qty, coalesce(limit_price, 0), status, created_at
			   FROM orders WHERE account_id = $1 ORDER BY created_at DESC LIMIT 20`, id)
		out, err = pgx.CollectRows(rows, pgx.RowToStructByPos[order])
		return err
	})
	return out, err
}

type dayActivity struct {
	Day    time.Time `json:"day"`
	Orders int64     `json:"orders"`
	Qty    float64   `json:"qty"`
}

// activity is the deliberately expensive endpoint: there is no index on
// orders.symbol, so every call scans the orders table. It stands in for the
// report or admin query that is fine alone and harmful under load.
func (s *server) activity(ctx context.Context, r *http.Request) (any, error) {
	var out []dayActivity
	err := s.withConn(ctx, s.report, func(c *pgxpool.Conn) error {
		rows, _ := c.Query(ctx,
			`SELECT date_trunc('day', created_at) AS day, count(*), coalesce(sum(qty), 0)
			   FROM orders WHERE symbol = $1
			  GROUP BY 1 ORDER BY 1 DESC LIMIT 30`, r.PathValue("symbol"))
		var err error
		out, err = pgx.CollectRows(rows, pgx.RowToStructByPos[dayActivity])
		return err
	})
	return out, err
}

type orderRequest struct {
	AccountID  int64   `json:"account_id"`
	Symbol     string  `json:"symbol"`
	Side       string  `json:"side"`
	Qty        float64 `json:"qty"`
	LimitPrice float64 `json:"limit_price"`
}

// placeOrder locks the account row, checks and reserves buying power, and
// records the order, in one short transaction. Anything else that holds that
// row lock (a batch job, a migration) makes this endpoint wait.
func (s *server) placeOrder(ctx context.Context, r *http.Request) (any, error) {
	var req orderRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return nil, &apiError{http.StatusBadRequest, "bad_body"}
	}
	if req.AccountID <= 0 || req.Symbol == "" || req.Qty <= 0 || req.LimitPrice <= 0 ||
		(req.Side != "buy" && req.Side != "sell") {
		return nil, &apiError{http.StatusBadRequest, "bad_order"}
	}

	var id int64
	err := s.withConn(ctx, s.write, func(c *pgxpool.Conn) error {
		return pgx.BeginFunc(ctx, c, func(tx pgx.Tx) error {
			return placeOrderTx(ctx, tx, req, &id)
		})
	})
	if err != nil {
		return nil, err
	}
	return map[string]int64{"id": id}, nil
}

func placeOrderTx(ctx context.Context, tx pgx.Tx, req orderRequest, id *int64) error {
	var bp float64
	if err := tx.QueryRow(ctx,
		`SELECT buying_power FROM accounts WHERE id = $1 AND status = 'ACTIVE' FOR UPDATE`,
		req.AccountID).Scan(&bp); err != nil {
		return err
	}
	cost := req.Qty * req.LimitPrice
	if req.Side == "buy" {
		if cost > bp {
			return &apiError{http.StatusUnprocessableEntity, "insufficient_buying_power"}
		}
		if _, err := tx.Exec(ctx,
			`UPDATE accounts SET buying_power = buying_power - $2, updated_at = now() WHERE id = $1`,
			req.AccountID, cost); err != nil {
			return err
		}
	}
	return tx.QueryRow(ctx,
		`INSERT INTO orders (account_id, symbol, side, qty, limit_price, status)
		 VALUES ($1, $2, $3, $4, $5, 'accepted') RETURNING id`,
		req.AccountID, req.Symbol, req.Side, req.Qty, req.LimitPrice).Scan(id)
}

type poolStats struct {
	Acquired          int32   `json:"acquired"`
	Idle              int32   `json:"idle"`
	Total             int32   `json:"total"`
	Max               int32   `json:"max"`
	AcquireCount      int64   `json:"acquire_count"`
	EmptyAcquireCount int64   `json:"empty_acquire_count"`
	AcquireSeconds    float64 `json:"acquire_seconds"`
	CanceledAcquires  int64   `json:"canceled_acquire_count"`
}

func stats(p *pgxpool.Pool) poolStats {
	st := p.Stat()
	return poolStats{
		Acquired: st.AcquiredConns(), Idle: st.IdleConns(), Total: st.TotalConns(), Max: st.MaxConns(),
		AcquireCount: st.AcquireCount(), EmptyAcquireCount: st.EmptyAcquireCount(),
		AcquireSeconds: st.AcquireDuration().Seconds(), CanceledAcquires: st.CanceledAcquireCount(),
	}
}

// pools reports client-side pool state. empty_acquire_count rising means
// requests found no free connection and had to wait: the earliest sign of
// connection pressure, visible before any request fails.
func (s *server) pools(w http.ResponseWriter, _ *http.Request) {
	out := map[string]poolStats{"write": stats(s.write)}
	if s.read != s.write {
		out["read"] = stats(s.read)
	}
	if s.report != s.read {
		out["report"] = stats(s.report)
	}
	writeJSON(w, http.StatusOK, out)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

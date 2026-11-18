// Command load drives the API at a fixed arrival rate (open loop) and records
// every request's latency and outcome.
//
// Open loop matters: a closed-loop generator waits for each reply before sending
// the next, so when the server slows down it quietly sends less and hides the
// problem. Here requests keep arriving on schedule, the way customers do. If the
// generator itself cannot keep up (too many requests in flight), it counts the
// request as "dropped" instead of silently skipping it.
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"math/rand/v2"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

func main() {
	var (
		baseURL     = flag.String("url", "http://api:8080", "API base URL")
		rate        = flag.Float64("rate", 200, "requests per second")
		duration    = flag.Duration("duration", 3*time.Minute, "how long to send")
		accounts    = flag.Int64("accounts", 200000, "account ids are drawn from 1..accounts")
		symbols     = flag.Int("symbols", 2000, "symbols are drawn from S0001..S<symbols>")
		mixFlag     = flag.String("mix", "account=40,positions=25,orders=10,order=25", "operation weights")
		timeout     = flag.Duration("timeout", 5*time.Second, "client timeout per request")
		maxInflight = flag.Int("max-inflight", 4000, "requests in flight before new ones are dropped")
		out         = flag.String("out", "", "directory for load.csv and summary.json (required)")
		livePath    = flag.String("live", "", "also append one JSON line per second here, as requests finish (for scripts/lab live)")
		retryMode   = flag.String("retry", "none", "client retry policy: none, immediate or backoff")
		retries     = flag.Int("retries", 3, "retries per request (with -retry immediate or backoff)")
		retryBase   = flag.Duration("retry-base", 100*time.Millisecond, "first backoff step (-retry backoff)")
		retryCap    = flag.Duration("retry-cap", 2*time.Second, "longest backoff step (-retry backoff)")
		retryBudget = flag.Float64("retry-budget", 0, "retries allowed per original request, e.g. 0.1; 0 means no budget")
		hotPct      = flag.Float64("hot-pct", 0, "percent of orders placed on one account (id 1), like an omnibus account")
	)
	flag.Parse()
	if *out == "" {
		log.Fatal("-out is required")
	}
	mix, err := parseMix(*mixFlag)
	if err != nil {
		log.Fatal(err)
	}
	policy, err := parseRetry(*retryMode, *retries, *retryBase, *retryCap, *retryBudget)
	if err != nil {
		log.Fatal(err)
	}

	client := &http.Client{
		Timeout: *timeout,
		Transport: &http.Transport{MaxIdleConns: *maxInflight, MaxIdleConnsPerHost: *maxInflight,
			IdleConnTimeout: 90 * time.Second},
	}
	rec := newRecorder()
	sem := make(chan struct{}, *maxInflight)
	var wg sync.WaitGroup

	interval := time.Duration(float64(time.Second) / *rate)
	start := time.Now()
	stopLive := startLive(*livePath, rec, start)
	log.Printf("sending %.0f req/s for %s, mix %s", *rate, *duration, *mixFlag)
	for i := 0; ; i++ {
		due := start.Add(time.Duration(i) * interval)
		if due.Sub(start) >= *duration {
			break
		}
		if d := time.Until(due); d > 0 {
			time.Sleep(d)
		}
		sec := int(due.Sub(start) / time.Second)
		op := mix.pick()
		select {
		case sem <- struct{}{}:
		default:
			rec.add(sec, sec, op, 0, "dropped")
			continue
		}
		wg.Add(1)
		policy.counter.add(sec, kindOriginal)
		if policy.budget != nil {
			policy.budget.original()
		}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			t0 := time.Now()
			outcome := do(client, *baseURL, op, *accounts, *symbols, *hotPct)
			// Retries are part of the same request: its latency and final
			// outcome include them, as the caller experiences it.
			for n := 1; n <= policy.max && retryable(outcome); n++ {
				if policy.budget != nil && !policy.budget.take() {
					policy.counter.add(int(time.Since(start)/time.Second), kindDenied)
					break
				}
				time.Sleep(policy.delay(n))
				policy.counter.add(int(time.Since(start)/time.Second), kindRetry)
				outcome = do(client, *baseURL, op, *accounts, *symbols, *hotPct)
			}
			rec.add(sec, int(time.Since(start)/time.Second), op, time.Since(t0), outcome)
		}()
	}
	wg.Wait()
	stopLive()

	if err := os.MkdirAll(*out, 0o755); err != nil {
		log.Fatal(err)
	}
	if err := rec.writeCSV(filepath.Join(*out, "load.csv")); err != nil {
		log.Fatal(err)
	}
	sum := rec.summary()
	orig, retried, denied := policy.counter.totals()
	if *retryMode != "none" {
		if err := policy.counter.writeCSV(filepath.Join(*out, "attempts.csv")); err != nil {
			log.Fatal(err)
		}
	}
	b, _ := json.MarshalIndent(map[string]any{
		"rate": *rate, "duration_s": duration.Seconds(), "mix": *mixFlag, "timeout_s": timeout.Seconds(),
		"started_at": start.UTC().Format(time.RFC3339), "ops": sum,
		"retry": map[string]any{"mode": *retryMode, "max": policy.max, "budget": *retryBudget,
			"original_requests": orig, "retries_sent": retried, "retries_denied_by_budget": denied},
	}, "", "  ")
	if err := os.WriteFile(filepath.Join(*out, "summary.json"), b, 0o644); err != nil {
		log.Fatal(err)
	}
	if *retryMode != "none" {
		log.Printf("retry %s: %d original requests, %d retries sent, %d refused by the budget", *retryMode, orig, retried, denied)
	}
	for _, op := range sortedKeys(sum) {
		s := sum[op]
		log.Printf("%-9s n=%-6d ok=%-6.4f p50=%-7.1f p99=%-7.1f max=%-7.1f errors=%v",
			op, s.N, s.OKRatio, s.P50, s.P99, s.Max, s.Errors)
	}
}

// do sends one request and returns its outcome: "ok", an error code from the
// API (for example "deadline" or "lock_timeout"), "http_<status>", or
// "client_timeout" when the generator gave up first.
func do(c *http.Client, base, op string, accounts int64, symbols int, hotPct float64) string {
	acct := 1 + rand.Int64N(accounts)
	if op == "order" && hotPct > 0 && rand.Float64()*100 < hotPct {
		acct = 1
	}
	sym := fmt.Sprintf("S%04d", 1+rand.IntN(symbols))
	var req *http.Request
	switch op {
	case "account":
		req, _ = http.NewRequest(http.MethodGet, fmt.Sprintf("%s/v1/accounts/%d", base, acct), nil)
	case "positions":
		req, _ = http.NewRequest(http.MethodGet, fmt.Sprintf("%s/v1/accounts/%d/positions", base, acct), nil)
	case "orders":
		req, _ = http.NewRequest(http.MethodGet, fmt.Sprintf("%s/v1/accounts/%d/orders", base, acct), nil)
	case "report":
		req, _ = http.NewRequest(http.MethodGet, fmt.Sprintf("%s/v1/reports/accounts/%d", base, 1+rand.Int64N(max(1, accounts-1000))), nil)
	case "market":
		req, _ = http.NewRequest(http.MethodGet, base+"/v1/market/summary", nil)
	case "activity":
		req, _ = http.NewRequest(http.MethodGet, fmt.Sprintf("%s/v1/activity/%s", base, sym), nil)
	case "order":
		side := "buy"
		if rand.IntN(2) == 0 {
			side = "sell"
		}
		body, _ := json.Marshal(map[string]any{"account_id": acct, "symbol": sym, "side": side,
			"qty": 1 + rand.IntN(10), "limit_price": 10 + rand.Float64()*490})
		req, _ = http.NewRequest(http.MethodPost, base+"/v1/orders", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
	default:
		return "bad_op"
	}
	resp, err := c.Do(req)
	if err != nil {
		if e, ok := err.(interface{ Timeout() bool }); ok && e.Timeout() {
			return "client_timeout"
		}
		return "conn_error"
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusOK {
		_, _ = io.Copy(io.Discard, resp.Body)
		return "ok"
	}
	var e struct {
		Error string `json:"error"`
	}
	if json.NewDecoder(resp.Body).Decode(&e) == nil && e.Error != "" {
		return e.Error
	}
	return fmt.Sprintf("http_%d", resp.StatusCode)
}

// startLive appends a frame per second to path: what finished during the
// previous second, with the wall-clock time the second began, so the live
// server can line it up with the sampler. It returns a function that writes
// the last frames and stops.
func startLive(path string, rec *recorder, start time.Time) func() {
	if path == "" {
		return func() {}
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		log.Fatalf("-live: %v", err)
	}
	rec.enableLive()
	enc := json.NewEncoder(f)
	emit := func(sec int) {
		_ = enc.Encode(map[string]any{
			"t":    sec,
			"wall": start.Add(time.Duration(sec) * time.Second).UTC().Format(time.RFC3339),
			"ops":  rec.takeLive(sec),
		})
	}
	done := make(chan struct{})
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		tick := time.NewTicker(time.Second)
		defer tick.Stop()
		next := 0
		for {
			select {
			case <-done:
				for ; next <= int(time.Since(start)/time.Second); next++ {
					emit(next)
				}
				return
			case <-tick.C:
				for ; next < int(time.Since(start)/time.Second); next++ {
					emit(next)
				}
			}
		}
	}()
	return func() {
		close(done)
		<-stopped
		_ = f.Close()
	}
}

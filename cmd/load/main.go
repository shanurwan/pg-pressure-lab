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
	)
	flag.Parse()
	if *out == "" {
		log.Fatal("-out is required")
	}
	mix, err := parseMix(*mixFlag)
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
			rec.add(sec, op, 0, "dropped")
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			t0 := time.Now()
			outcome := do(client, *baseURL, op, *accounts, *symbols)
			rec.add(sec, op, time.Since(t0), outcome)
		}()
	}
	wg.Wait()

	if err := os.MkdirAll(*out, 0o755); err != nil {
		log.Fatal(err)
	}
	if err := rec.writeCSV(filepath.Join(*out, "load.csv")); err != nil {
		log.Fatal(err)
	}
	sum := rec.summary()
	b, _ := json.MarshalIndent(map[string]any{
		"rate": *rate, "duration_s": duration.Seconds(), "mix": *mixFlag, "timeout_s": timeout.Seconds(),
		"started_at": start.UTC().Format(time.RFC3339), "ops": sum,
	}, "", "  ")
	if err := os.WriteFile(filepath.Join(*out, "summary.json"), b, 0o644); err != nil {
		log.Fatal(err)
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
func do(c *http.Client, base, op string, accounts int64, symbols int) string {
	acct := 1 + rand.Int64N(accounts)
	sym := fmt.Sprintf("S%04d", 1+rand.IntN(symbols))
	var req *http.Request
	switch op {
	case "account":
		req, _ = http.NewRequest(http.MethodGet, fmt.Sprintf("%s/v1/accounts/%d", base, acct), nil)
	case "positions":
		req, _ = http.NewRequest(http.MethodGet, fmt.Sprintf("%s/v1/accounts/%d/positions", base, acct), nil)
	case "orders":
		req, _ = http.NewRequest(http.MethodGet, fmt.Sprintf("%s/v1/accounts/%d/orders", base, acct), nil)
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

package main

import (
	"encoding/csv"
	"fmt"
	"math/rand/v2"
	"os"
	"slices"
	"strconv"
	"sync"
	"time"
)

// retryPolicy is how a client retries a failed request: not at all, at once,
// or with jittered exponential backoff, optionally limited by a retry budget.
type retryPolicy struct {
	mode    string // none | immediate | backoff
	max     int    // retries per request
	base    time.Duration
	cap     time.Duration
	budget  *retryBudget // nil: unlimited
	counter *attempts
}

func parseRetry(mode string, max int, base, capDelay time.Duration, budget float64) (retryPolicy, error) {
	p := retryPolicy{mode: mode, max: max, base: base, cap: capDelay, counter: newAttempts()}
	switch mode {
	case "none":
		p.max = 0
	case "immediate", "backoff":
		if max < 1 {
			return p, fmt.Errorf("-retries must be at least 1 with -retry %s", mode)
		}
	default:
		return p, fmt.Errorf("-retry %q: want none, immediate or backoff", mode)
	}
	if budget > 0 {
		p.budget = &retryBudget{ratio: budget, cap: 100} // allows a burst of up to 100 retries
	}
	return p, nil
}

// delay is the wait before retry n (1-based): nothing for immediate, "full
// jitter" exponential backoff otherwise.
func (p retryPolicy) delay(n int) time.Duration {
	if p.mode != "backoff" {
		return 0
	}
	d := min(p.cap, p.base<<min(n-1, 20))
	return time.Duration(rand.Int64N(int64(d) + 1))
}

// retryable says whether an outcome is worth retrying: server errors and
// timeouts are, a refused or invalid request is not.
func retryable(outcome string) bool {
	switch outcome {
	case "ok", "dropped", "not_found", "bad_id", "bad_body", "bad_order", "insufficient_buying_power", "bad_op":
		return false
	}
	return true
}

// retryBudget is a token bucket: every original request adds ratio tokens
// (up to cap), every retry spends one. With ratio 0.1 retries can never be
// more than about 10% of traffic, however bad things get.
type retryBudget struct {
	mu     sync.Mutex
	tokens float64
	ratio  float64
	cap    float64
}

func (b *retryBudget) original() {
	b.mu.Lock()
	b.tokens = min(b.cap, b.tokens+b.ratio)
	b.mu.Unlock()
}

func (b *retryBudget) take() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.tokens < 1-1e-9 { // ratio steps are not exact in floating point
		return false
	}
	b.tokens--
	return true
}

// attempts counts, per second sent, original requests, retries, and retries
// the budget refused, so a run shows how much extra load the clients added.
type attempts struct {
	mu sync.Mutex
	m  map[int]*[3]int
}

func newAttempts() *attempts { return &attempts{m: map[int]*[3]int{}} }

func (a *attempts) add(sec, kind int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	v := a.m[sec]
	if v == nil {
		v = &[3]int{}
		a.m[sec] = v
	}
	v[kind]++
}

const (
	kindOriginal = iota
	kindRetry
	kindDenied
)

func (a *attempts) totals() (orig, retries, denied int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, v := range a.m {
		orig, retries, denied = orig+v[0], retries+v[1], denied+v[2]
	}
	return
}

func (a *attempts) writeCSV(path string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	w := csv.NewWriter(f)
	_ = w.Write([]string{"sec", "original", "retries", "retries_denied"})
	secs := make([]int, 0, len(a.m))
	for s := range a.m {
		secs = append(secs, s)
	}
	slices.Sort(secs)
	for _, s := range secs {
		v := a.m[s]
		_ = w.Write([]string{strconv.Itoa(s), strconv.Itoa(v[0]), strconv.Itoa(v[1]), strconv.Itoa(v[2])})
	}
	w.Flush()
	return w.Error()
}

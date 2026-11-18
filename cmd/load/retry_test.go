package main

import (
	"testing"
	"time"
)

func TestRetryBudgetCapsRetries(t *testing.T) {
	p, err := parseRetry("backoff", 3, 100*time.Millisecond, 2*time.Second, 0.1)
	if err != nil {
		t.Fatal(err)
	}
	for range 100 {
		p.budget.original()
	}
	granted := 0
	for range 1000 {
		if p.budget.take() {
			granted++
		}
	}
	if granted != 10 {
		t.Fatalf("100 originals at a 0.1 budget should allow 10 retries, got %d", granted)
	}
}

func TestBackoffIsJitteredAndCapped(t *testing.T) {
	p, _ := parseRetry("backoff", 3, 100*time.Millisecond, 400*time.Millisecond, 0)
	for n := 1; n <= 6; n++ {
		for range 200 {
			d := p.delay(n)
			limit := min(400*time.Millisecond, 100*time.Millisecond<<(n-1))
			if d < 0 || d > limit {
				t.Fatalf("retry %d: delay %s outside [0, %s]", n, d, limit)
			}
		}
	}
	imm, _ := parseRetry("immediate", 3, time.Second, time.Second, 0)
	if imm.delay(1) != 0 {
		t.Fatal("immediate retries must not wait")
	}
}

func TestRetryable(t *testing.T) {
	for _, o := range []string{"deadline", "canceled", "client_timeout", "conn_error", "http_502"} {
		if !retryable(o) {
			t.Errorf("%s should be retried", o)
		}
	}
	for _, o := range []string{"ok", "dropped", "not_found", "insufficient_buying_power", "bad_order"} {
		if retryable(o) {
			t.Errorf("%s should not be retried", o)
		}
	}
	if _, err := parseRetry("sometimes", 3, 0, 0, 0); err == nil {
		t.Error("unknown policy accepted")
	}
	if p, _ := parseRetry("none", 3, 0, 0, 0); p.max != 0 {
		t.Error("none must mean no retries")
	}
}

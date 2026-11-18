package main

import (
	"testing"
	"time"
)

func TestPercentileNearestRank(t *testing.T) {
	v := []float64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}
	for _, tc := range []struct{ p, want float64 }{{50, 5}, {90, 9}, {99, 10}, {100, 10}, {1, 1}} {
		if got := percentile(v, tc.p); got != tc.want {
			t.Errorf("p%v = %v, want %v", tc.p, got, tc.want)
		}
	}
	if got := percentile(nil, 99); got != 0 {
		t.Errorf("empty p99 = %v, want 0", got)
	}
}

func TestParseMix(t *testing.T) {
	m, err := parseMix("account=3, order=1, activity=0")
	if err != nil {
		t.Fatal(err)
	}
	if m.total != 4 || len(m.ops) != 2 {
		t.Fatalf("got total %d ops %v", m.total, m.ops)
	}
	seen := map[string]int{}
	for range 4000 {
		seen[m.pick()]++
	}
	if seen["activity"] != 0 || seen["account"] < 2700 || seen["order"] < 800 {
		t.Fatalf("weights not respected: %v", seen)
	}
	for _, bad := range []string{"", "account", "account=x", "nope=1", "account=0"} {
		if _, err := parseMix(bad); err == nil {
			t.Errorf("parseMix(%q) accepted", bad)
		}
	}
}

func TestFailuresAreCountedNotTimed(t *testing.T) {
	r := newRecorder()
	r.add(0, 0, "order", 10*time.Millisecond, "ok")
	r.add(0, 1, "order", time.Millisecond, "lock_timeout")
	s := r.summary()["order"]
	if s.N != 2 || s.OK != 1 || s.Errors["lock_timeout"] != 1 {
		t.Fatalf("counts wrong: %+v", s)
	}
	if s.P50 != 10 {
		t.Fatalf("a fast failure leaked into latency: p50 = %v", s.P50)
	}
}

func TestLiveIsKeyedByFinishSecond(t *testing.T) {
	r := newRecorder()
	r.enableLive()
	r.add(0, 3, "order", 20*time.Millisecond, "ok")
	r.add(0, 3, "order", time.Millisecond, "deadline")
	if got := r.takeLive(0); len(got) != 0 {
		t.Fatalf("second 0 should be empty in the live view, got %v", got)
	}
	got := r.takeLive(3)["order"]
	if got.N != 2 || got.OK != 1 || got.Errors["deadline"] != 1 || got.P50 != 20 {
		t.Fatalf("live frame wrong: %+v", got)
	}
	if again := r.takeLive(3); len(again) != 0 {
		t.Fatalf("a taken second must not be sent twice: %v", again)
	}
}

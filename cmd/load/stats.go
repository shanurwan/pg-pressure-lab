package main

import (
	"encoding/csv"
	"fmt"
	"math/rand/v2"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// mix picks operations by weight.
type mix struct {
	ops   []string
	cum   []int
	total int
}

func parseMix(s string) (mix, error) {
	var m mix
	for _, part := range strings.Split(s, ",") {
		name, w, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			return m, fmt.Errorf("mix entry %q: want op=weight", part)
		}
		n, err := strconv.Atoi(w)
		if err != nil || n < 0 {
			return m, fmt.Errorf("mix entry %q: bad weight", part)
		}
		switch name {
		case "account", "positions", "orders", "order", "activity", "report", "market":
		default:
			return m, fmt.Errorf("mix entry %q: unknown operation", part)
		}
		if n == 0 {
			continue
		}
		m.total += n
		m.ops = append(m.ops, name)
		m.cum = append(m.cum, m.total)
	}
	if m.total == 0 {
		return m, fmt.Errorf("mix %q has no weight", s)
	}
	return m, nil
}

func (m mix) pick() string {
	r := rand.IntN(m.total)
	i, _ := slices.BinarySearch(m.cum, r+1)
	return m.ops[i]
}

type key struct {
	sec int
	op  string
}

type bucket struct {
	lat      []float64 // milliseconds, ok requests only
	ok       int
	outcomes map[string]int
}

// recorder keeps every latency, grouped by second and operation. At a few
// hundred requests per second for a few minutes that is well under a million
// floats, so exact percentiles are cheap and nothing is estimated.
type recorder struct {
	mu   sync.Mutex
	b    map[key]*bucket
	live map[key]*bucket // keyed by the second a request finished; nil unless -live
}

func newRecorder() *recorder { return &recorder{b: map[key]*bucket{}} }

// enableLive starts keeping the per-finish-second view that takeLive drains.
func (r *recorder) enableLive() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.live = map[key]*bucket{}
}

// add records a request under the second it was sent (sec), and, for the live
// stream, under the second it finished (doneSec).
func (r *recorder) add(sec, doneSec int, op string, d time.Duration, outcome string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, k := range []struct {
		m map[key]*bucket
		k key
	}{{r.b, key{sec, op}}, {r.live, key{doneSec, op}}} {
		if k.m == nil {
			continue
		}
		b := k.m[k.k]
		if b == nil {
			b = &bucket{outcomes: map[string]int{}}
			k.m[k.k] = b
		}
		b.outcomes[outcome]++
		if outcome == "ok" {
			b.ok++
			b.lat = append(b.lat, float64(d.Microseconds())/1000)
		}
	}
}

// liveOp is one operation's numbers in a live frame; the fields match the
// site's frame format.
type liveOp struct {
	N      int            `json:"n"`
	OK     int            `json:"ok"`
	P50    float64        `json:"p50"`
	P99    float64        `json:"p99"`
	Errors map[string]int `json:"errors"`
}

// takeLive removes and returns what finished during second sec.
func (r *recorder) takeLive(sec int) map[string]liveOp {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := map[string]liveOp{}
	for k, b := range r.live {
		if k.sec != sec {
			continue
		}
		delete(r.live, k)
		o := liveOp{OK: b.ok, Errors: map[string]int{}}
		for code, c := range b.outcomes {
			o.N += c
			if code != "ok" {
				o.Errors[code] = c
			}
		}
		slices.Sort(b.lat)
		o.P50, o.P99 = percentile(b.lat, 50), percentile(b.lat, 99)
		out[k.op] = o
	}
	return out
}

// percentile returns the nearest-rank percentile of sorted values.
func percentile(sorted []float64, p float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	rank := int(p/100*float64(len(sorted))+0.5) - 1
	rank = max(0, min(rank, len(sorted)-1))
	return sorted[rank]
}

// writeCSV writes one row per second and operation. Latency columns cover
// successful requests; failures are counted, not timed, so a flood of fast
// errors cannot make latency look better.
func (r *recorder) writeCSV(path string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	w := csv.NewWriter(f)
	_ = w.Write([]string{"sec", "op", "n", "ok", "errors", "p50_ms", "p99_ms", "max_ms", "error_codes"})
	keys := make([]key, 0, len(r.b))
	for k := range r.b {
		keys = append(keys, k)
	}
	slices.SortFunc(keys, func(a, b key) int {
		if a.sec != b.sec {
			return a.sec - b.sec
		}
		return strings.Compare(a.op, b.op)
	})
	for _, k := range keys {
		b := r.b[k]
		n := 0
		var codes []string
		for o, c := range b.outcomes {
			n += c
			if o != "ok" {
				codes = append(codes, fmt.Sprintf("%s:%d", o, c))
			}
		}
		slices.Sort(codes)
		lat := slices.Clone(b.lat)
		slices.Sort(lat)
		mx := 0.0
		if len(lat) > 0 {
			mx = lat[len(lat)-1]
		}
		_ = w.Write([]string{strconv.Itoa(k.sec), k.op, strconv.Itoa(n), strconv.Itoa(b.ok),
			strconv.Itoa(n - b.ok), f1(percentile(lat, 50)), f1(percentile(lat, 99)), f1(mx),
			strings.Join(codes, " ")})
	}
	w.Flush()
	return w.Error()
}

type opSummary struct {
	N       int            `json:"n"`
	OK      int            `json:"ok"`
	OKRatio float64        `json:"ok_ratio"`
	P50     float64        `json:"p50_ms"`
	P95     float64        `json:"p95_ms"`
	P99     float64        `json:"p99_ms"`
	Max     float64        `json:"max_ms"`
	Errors  map[string]int `json:"errors"`
}

func (r *recorder) summary() map[string]opSummary {
	r.mu.Lock()
	defer r.mu.Unlock()
	lat := map[string][]float64{}
	out := map[string]opSummary{}
	for k, b := range r.b {
		s := out[k.op]
		if s.Errors == nil {
			s.Errors = map[string]int{}
		}
		for o, c := range b.outcomes {
			s.N += c
			if o != "ok" {
				s.Errors[o] += c
			}
		}
		s.OK += b.ok
		lat[k.op] = append(lat[k.op], b.lat...)
		out[k.op] = s
	}
	for op, s := range out {
		l := lat[op]
		slices.Sort(l)
		if s.N > 0 {
			s.OKRatio = float64(s.OK) / float64(s.N)
		}
		s.P50, s.P95, s.P99 = percentile(l, 50), percentile(l, 95), percentile(l, 99)
		if len(l) > 0 {
			s.Max = l[len(l)-1]
		}
		out[op] = s
	}
	return out
}

func sortedKeys[V any](m map[string]V) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	slices.Sort(ks)
	return ks
}

func f1(v float64) string { return strconv.FormatFloat(v, 'f', 1, 64) }

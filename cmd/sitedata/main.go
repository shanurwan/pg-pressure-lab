// Command sitedata turns recorded runs into the JSON the interactive replays use.
//
//	sitedata -results results -out site/data
//
// It writes site/data/index.json (one entry per run, with headline numbers)
// and site/data/runs/<scenario>-<round>-<stamp>.json (the run, second by
// second). Every number on the site comes from these files, so the prose can
// never drift from what was measured.
//
// A frame is one second of a run. Live mode streams the same shape over SSE:
//
//	{"t": 42,
//	 "ops": {"order": {"n": 75, "ok": 75, "p50": 14.9, "p99": 210.0, "errors": {}}},
//	 "db": {"pg_active": 3, ..., "pg_sessions_started": 0},
//	 "events": ["batch_start"]}
package main

import (
	"encoding/csv"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
)

type opFrame struct {
	N      int            `json:"n"`
	OK     int            `json:"ok"`
	P50    float64        `json:"p50"`
	P99    float64        `json:"p99"`
	Errors map[string]int `json:"errors"`
}

type dbFrame struct {
	PgActive            int64   `json:"pg_active"`
	PgIdleInTx          int64   `json:"pg_idle_in_tx"`
	PgLockWait          int64   `json:"pg_lock_wait"`
	PgTotal             int64   `json:"pg_total"`
	LongestXactS        float64 `json:"longest_xact_s"`
	BouncerClWaiting    int64   `json:"bouncer_cl_waiting"`
	BouncerMaxwaitMs    int64   `json:"bouncer_maxwait_ms"`
	PoolAcquired        int64   `json:"pool_acquired"`
	PoolEmptyAcquires   int64   `json:"pool_empty_acquires"`
	PgSessionsStarted   *int64  `json:"pg_sessions_started"`
	PgSessionsAbandoned *int64  `json:"pg_sessions_abandoned"`
}

type frame struct {
	T      int                `json:"t"`
	Ops    map[string]opFrame `json:"ops"`
	DB     *dbFrame           `json:"db"`
	Events []string           `json:"events"`
}

type window struct {
	StartS float64 `json:"start_s"`
	EndS   float64 `json:"end_s"`
}

type statement struct {
	Calls   int64   `json:"calls"`
	TotalMs float64 `json:"total_ms"`
	MeanMs  float64 `json:"mean_ms"`
	MaxMs   float64 `json:"max_ms"`
	Query   string  `json:"query"`
}

// headline is what the index and the lesson text quote.
type headline struct {
	Requests         int            `json:"requests"`
	Failed           int            `json:"failed"`
	FailedPct        float64        `json:"failed_pct"`
	SecondsFailing   int            `json:"seconds_with_failures"`
	WorstSecondOK    float64        `json:"worst_second_ok"`
	OrderP99         float64        `json:"order_p99_ms"`
	ReadP99          float64        `json:"read_p99_ms"`
	Errors           map[string]int `json:"errors"`
	BatchSeconds     *float64       `json:"batch_seconds"`
	FailedAfterBatch *int           `json:"failed_after_batch"`
	FailedInBatch    *int           `json:"failed_during_batch"`
	RecoveredS       *float64       `json:"recovered_s"` // null: not within the run
	MaxLockWait      int64          `json:"max_lock_wait"`
	MaxBouncerQueue  int64          `json:"max_bouncer_queue"`
	MaxLongestXactS  float64        `json:"max_longest_xact_s"`
	MaxSessionsPerS  *int64         `json:"max_sessions_per_s"`
}

type run struct {
	ID            string          `json:"id"`
	Scenario      string          `json:"scenario"`
	Round         string          `json:"round"`
	Stamp         string          `json:"stamp"`
	Date          string          `json:"date"`
	Meta          json.RawMessage `json:"meta"`
	Summary       json.RawMessage `json:"summary"`
	Batch         json.RawMessage `json:"batch"`
	BatchWindow   *window         `json:"batch_window"`
	TopStatements []statement     `json:"top_statements"`
	Headline      headline        `json:"headline"`
	Frames        []frame         `json:"frames"`
}

type indexEntry struct {
	ID       string   `json:"id"`
	Scenario string   `json:"scenario"`
	Round    string   `json:"round"`
	Stamp    string   `json:"stamp"`
	Date     string   `json:"date"`
	Rate     float64  `json:"rate"`
	Duration string   `json:"duration"`
	Headline headline `json:"headline"`
}

var readOps = []string{"account", "positions", "orders"}

func main() {
	results := flag.String("results", "results", "results directory")
	out := flag.String("out", "site/data", "output directory")
	flag.Parse()

	if err := os.MkdirAll(filepath.Join(*out, "runs"), 0o755); err != nil {
		log.Fatal(err)
	}
	var index []indexEntry
	scenarios, err := os.ReadDir(*results)
	if err != nil {
		log.Fatal(err)
	}
	for _, sc := range scenarios {
		if !sc.IsDir() || sc.Name() == "calibration" {
			continue
		}
		rounds, _ := os.ReadDir(filepath.Join(*results, sc.Name()))
		for _, rd := range rounds {
			stamps, _ := os.ReadDir(filepath.Join(*results, sc.Name(), rd.Name()))
			for _, st := range stamps {
				dir := filepath.Join(*results, sc.Name(), rd.Name(), st.Name())
				r, err := loadRun(dir, sc.Name(), rd.Name(), st.Name())
				if err != nil {
					log.Printf("skip %s: %v", dir, err)
					continue
				}
				b, _ := json.Marshal(r)
				if err := os.WriteFile(filepath.Join(*out, "runs", r.ID+".json"), b, 0o644); err != nil {
					log.Fatal(err)
				}
				var meta struct {
					Rate     float64 `json:"rate"`
					Duration string  `json:"duration"`
				}
				_ = json.Unmarshal(r.Meta, &meta)
				index = append(index, indexEntry{ID: r.ID, Scenario: r.Scenario, Round: r.Round, Stamp: r.Stamp,
					Date: r.Date, Rate: meta.Rate, Duration: meta.Duration, Headline: r.Headline})
			}
		}
	}
	slices.SortFunc(index, func(a, b indexEntry) int { return strings.Compare(a.Stamp, b.Stamp) })
	b, _ := json.MarshalIndent(map[string]any{"generated_utc": time.Now().UTC().Format(time.RFC3339), "runs": index}, "", " ")
	if err := os.WriteFile(filepath.Join(*out, "index.json"), b, 0o644); err != nil {
		log.Fatal(err)
	}
	log.Printf("wrote %d runs", len(index))
}

func loadRun(dir, scenario, round, stamp string) (*run, error) {
	r := &run{ID: scenario + "-" + round + "-" + stamp, Scenario: scenario, Round: round, Stamp: stamp}
	var err error
	if r.Meta, err = os.ReadFile(filepath.Join(dir, "meta.json")); err != nil {
		return nil, err
	}
	if r.Summary, err = os.ReadFile(filepath.Join(dir, "summary.json")); err != nil {
		return nil, err // run still in progress
	}
	var sum struct {
		StartedAt string `json:"started_at"`
	}
	if err := json.Unmarshal(r.Summary, &sum); err != nil {
		return nil, err
	}
	loadStart, err := time.Parse(time.RFC3339, sum.StartedAt)
	if err != nil {
		return nil, fmt.Errorf("summary started_at: %w", err)
	}
	r.Date = loadStart.Format("2006-01-02")

	frames, err := readLoad(filepath.Join(dir, "load.csv"))
	if err != nil {
		return nil, err
	}
	if err := joinSampler(filepath.Join(dir, "sampler.csv"), loadStart, frames); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}

	r.Batch = json.RawMessage("null")
	if b, err := os.ReadFile(filepath.Join(dir, "batch.json")); err == nil {
		r.Batch = b
		var bj struct {
			StartedAt string  `json:"started_at"`
			Seconds   float64 `json:"seconds"`
		}
		if json.Unmarshal(b, &bj) == nil {
			if bs, err := time.Parse(time.RFC3339Nano, bj.StartedAt); err == nil {
				start := bs.Sub(loadStart).Seconds()
				r.BatchWindow = &window{StartS: round1(start), EndS: round1(start + bj.Seconds)}
			}
		}
	}
	if r.BatchWindow != nil {
		addEvent(frames, int(r.BatchWindow.StartS), "batch_start")
		addEvent(frames, int(math.Ceil(r.BatchWindow.EndS)), "batch_end")
	}
	r.Frames = flatten(frames)
	r.TopStatements = readStatements(filepath.Join(dir, "pg_stat_statements.tsv"))
	r.Headline = computeHeadline(r.Frames, r.BatchWindow, r.Summary)
	return r, nil
}

func readLoad(path string) (map[int]*frame, error) {
	rows, err := readCSV(path)
	if err != nil {
		return nil, err
	}
	frames := map[int]*frame{}
	for _, row := range rows {
		t, err := strconv.Atoi(row["sec"])
		if err != nil {
			return nil, fmt.Errorf("%s: sec %q", path, row["sec"])
		}
		f := get(frames, t)
		op := opFrame{N: atoi(row["n"]), OK: atoi(row["ok"]), P50: atof(row["p50_ms"]), P99: atof(row["p99_ms"]),
			Errors: map[string]int{}}
		for _, code := range strings.Fields(row["error_codes"]) {
			name, n, ok := strings.Cut(code, ":")
			if ok {
				op.Errors[name] += atoi(n)
			}
		}
		f.Ops[row["op"]] = op
	}
	return frames, nil
}

// joinSampler places each sampler row (wall-clock UTC) on the load
// generator's second index. When two samples land in one second the later
// wins; samples outside the load window are dropped.
func joinSampler(path string, loadStart time.Time, frames map[int]*frame) error {
	rows, err := readCSV(path)
	if err != nil {
		return err
	}
	last := -1
	for t := range frames {
		last = max(last, t)
	}
	for _, row := range rows {
		ts, err := time.Parse("2006-01-02T15:04:05.000Z", row["t"])
		if err != nil {
			continue
		}
		d := ts.Sub(loadStart)
		if d < 0 {
			continue
		}
		t := int(d / time.Second)
		if t > last {
			continue
		}
		db := &dbFrame{
			PgActive: atoi64(row["pg_active"]), PgIdleInTx: atoi64(row["pg_idle_in_tx"]),
			PgLockWait: atoi64(row["pg_lock_wait"]), PgTotal: atoi64(row["pg_total"]),
			LongestXactS: atof(row["longest_xact_s"]), BouncerClWaiting: atoi64(row["bouncer_cl_waiting"]),
			BouncerMaxwaitMs: atoi64(row["bouncer_maxwait_ms"]), PoolAcquired: atoi64(row["pool_acquired"]),
			PoolEmptyAcquires: atoi64(row["pool_empty_acquires"]),
		}
		if v, ok := row["pg_sessions_started"]; ok && v != "" {
			n := atoi64(v)
			db.PgSessionsStarted = &n
		}
		if v, ok := row["pg_sessions_abandoned"]; ok && v != "" {
			n := atoi64(v)
			db.PgSessionsAbandoned = &n
		}
		get(frames, t).DB = db
	}
	return nil
}

func computeHeadline(frames []frame, w *window, summary json.RawMessage) headline {
	h := headline{Errors: map[string]int{}, WorstSecondOK: 1}
	var sum struct {
		Ops map[string]struct {
			N   int     `json:"n"`
			OK  int     `json:"ok"`
			P99 float64 `json:"p99_ms"`
		} `json:"ops"`
	}
	_ = json.Unmarshal(summary, &sum)
	for op, s := range sum.Ops {
		h.Requests += s.N
		h.Failed += s.N - s.OK
		if op == "order" {
			h.OrderP99 = s.P99
		}
		if slices.Contains(readOps, op) {
			h.ReadP99 = max(h.ReadP99, s.P99)
		}
	}
	if h.Requests > 0 {
		h.FailedPct = round2(100 * float64(h.Failed) / float64(h.Requests))
	}

	type sec struct{ n, ok int }
	per := map[int]sec{}
	last := 0
	var maxSess *int64
	for _, f := range frames {
		var s sec
		for _, o := range f.Ops {
			s.n += o.N
			s.ok += o.OK
			for e, c := range o.Errors {
				h.Errors[e] += c
			}
		}
		per[f.T] = s
		last = max(last, f.T)
		if s.n > 0 {
			if s.ok < s.n {
				h.SecondsFailing++
			}
			h.WorstSecondOK = math.Min(h.WorstSecondOK, float64(s.ok)/float64(s.n))
		}
		if f.DB != nil {
			h.MaxLockWait = max(h.MaxLockWait, f.DB.PgLockWait)
			h.MaxBouncerQueue = max(h.MaxBouncerQueue, f.DB.BouncerClWaiting)
			h.MaxLongestXactS = math.Max(h.MaxLongestXactS, f.DB.LongestXactS)
			if f.DB.PgSessionsStarted != nil {
				if maxSess == nil {
					v := int64(0)
					maxSess = &v
				}
				*maxSess = max(*maxSess, *f.DB.PgSessionsStarted)
			}
		}
	}
	h.WorstSecondOK = round2(h.WorstSecondOK)
	h.MaxSessionsPerS = maxSess

	if w != nil {
		bs := round1(w.EndS - w.StartS)
		h.BatchSeconds = &bs
		first := int(math.Ceil(w.EndS))
		after, during := 0, 0
		for t, s := range per {
			if t >= first {
				after += s.n - s.ok
			} else if t >= int(w.StartS) {
				during += s.n - s.ok
			}
		}
		h.FailedAfterBatch, h.FailedInBatch = &after, &during
		healthy := func(t int) bool {
			s, ok := per[t]
			return ok && s.n > 0 && float64(s.ok) >= 0.99*float64(s.n)
		}
		for t := first; t+9 <= last; t++ {
			all := true
			for k := t; k < t+10 && all; k++ {
				all = healthy(k)
			}
			if all {
				v := math.Max(0, round1(float64(t)-w.EndS))
				h.RecoveredS = &v
				break
			}
		}
	}
	return h
}

func readStatements(path string) []statement {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var out []statement
	for _, line := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		f := strings.SplitN(line, "\t", 5)
		if len(f) != 5 {
			continue
		}
		out = append(out, statement{Calls: atoi64(f[0]), TotalMs: atof(f[1]), MeanMs: atof(f[2]),
			MaxMs: atof(f[3]), Query: strings.TrimSpace(f[4])})
	}
	return out
}

func get(m map[int]*frame, t int) *frame {
	f := m[t]
	if f == nil {
		f = &frame{T: t, Ops: map[string]opFrame{}, Events: []string{}}
		m[t] = f
	}
	return f
}

func addEvent(m map[int]*frame, t int, ev string) {
	if _, ok := m[t]; !ok {
		// An event after the last second of load (a batch that outlived the run)
		// is kept on the last frame so it is not lost.
		last := 0
		for k := range m {
			last = max(last, k)
		}
		t = min(t, last)
	}
	f := get(m, t)
	f.Events = append(f.Events, ev)
}

func flatten(m map[int]*frame) []frame {
	out := make([]frame, 0, len(m))
	for _, f := range m {
		out = append(out, *f)
	}
	slices.SortFunc(out, func(a, b frame) int { return a.T - b.T })
	return out
}

func readCSV(path string) ([]map[string]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	r := csv.NewReader(f)
	r.FieldsPerRecord = -1
	recs, err := r.ReadAll()
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if len(recs) == 0 {
		return nil, nil
	}
	out := make([]map[string]string, 0, len(recs)-1)
	for _, rec := range recs[1:] {
		m := map[string]string{}
		for i, h := range recs[0] {
			if i < len(rec) {
				m[h] = rec[i]
			}
		}
		out = append(out, m)
	}
	return out, nil
}

func atoi(s string) int        { n, _ := strconv.Atoi(strings.TrimSpace(s)); return n }
func atoi64(s string) int64    { n, _ := strconv.ParseInt(strings.TrimSpace(s), 10, 64); return n }
func atof(s string) float64    { v, _ := strconv.ParseFloat(strings.TrimSpace(s), 64); return v }
func round1(v float64) float64 { return math.Round(v*10) / 10 }
func round2(v float64) float64 { return math.Round(v*100) / 100 }

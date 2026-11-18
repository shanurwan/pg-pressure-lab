// Package runs reads recorded drill runs (results/<scenario>/<round>/<stamp>/)
// and reduces them to the numbers that compare rounds. cmd/report and cmd/mcp
// both use it, so a table in the README and an answer from the MCP server come
// from the same code.
package runs

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Run is one recorded run, reduced to comparable numbers.
type Run struct {
	ID               string         `json:"id"` // <scenario>/<round>/<stamp>
	Scenario         string         `json:"scenario"`
	Round            string         `json:"round"`
	Stamp            string         `json:"stamp"`
	Rate             float64        `json:"rate"`
	Requests         int            `json:"requests"`
	Failed           int            `json:"failed"`
	FailedPct        float64        `json:"failed_pct"`
	BadSeconds       int            `json:"seconds_with_failures"`
	WorstSecondOK    float64        `json:"worst_second_ok_ratio"`
	OrderP99ms       float64        `json:"order_p99_ms"`
	ReadP99ms        float64        `json:"read_p99_ms"`
	Errors           map[string]int `json:"errors"`
	Trigger          string         `json:"trigger,omitempty"` // the job counted as the incident: batch, migration, lock, idle_tx
	RetriesSent      int            `json:"retries_sent,omitempty"`
	RetriesDenied    int            `json:"retries_denied_by_budget,omitempty"`
	BatchSeconds     float64        `json:"batch_seconds,omitempty"`
	BatchRetries     int            `json:"batch_lock_timeout_retries,omitempty"`
	BatchError       string         `json:"batch_error,omitempty"`
	BatchStartS      float64        `json:"batch_start_s,omitempty"` // from load start
	BatchEndS        float64        `json:"batch_end_s,omitempty"`
	FailedAfterBatch int            `json:"failed_after_batch_ended"`
	Recovery         string         `json:"recovery"` // batch end to 10 straight seconds at >= 99% ok
	MaxLockWaiters   int64          `json:"max_lock_waiters"`
	MaxBouncerQueue  int64          `json:"max_pgbouncer_queue"`
	LongestXactS     float64        `json:"longest_transaction_s"`
	MaxSessionsPerS  int64          `json:"max_new_sessions_per_s"`
}

type opSummary struct {
	N      int            `json:"n"`
	OK     int            `json:"ok"`
	P99    float64        `json:"p99_ms"`
	Errors map[string]int `json:"errors"`
}

type summary struct {
	StartedAt string               `json:"started_at"`
	Ops       map[string]opSummary `json:"ops"`
	Retry     *struct {
		Sent   int `json:"retries_sent"`
		Denied int `json:"retries_denied_by_budget"`
	} `json:"retry"`
}

// trigger returns the name of the job that counts as the incident in a run
// and reads its result file. Older runs only have batch.json.
func trigger(dir string) (string, batchResult, bool) {
	var meta struct {
		Trigger string `json:"trigger"`
	}
	name := "batch"
	if readJSON(filepath.Join(dir, "meta.json"), &meta) == nil && meta.Trigger != "" {
		name = meta.Trigger
	}
	var b batchResult
	if readJSON(filepath.Join(dir, name+".json"), &b) != nil {
		return name, b, false
	}
	return name, b, true
}

type batchResult struct {
	StartedAt string  `json:"started_at"`
	Seconds   float64 `json:"seconds"`
	Retries   int     `json:"lock_timeout_retries"`
	Error     string  `json:"error"`
}

var reads = []string{"account", "positions", "orders"}

// List returns the runs of a scenario, in the given round order (all rounds,
// alphabetically, if rounds is empty), oldest first within a round.
func List(results, scenario string, rounds []string) ([]Run, error) {
	base := filepath.Join(results, scenario)
	if len(rounds) == 0 {
		entries, err := os.ReadDir(base)
		if err != nil {
			return nil, err
		}
		for _, e := range entries {
			if e.IsDir() {
				rounds = append(rounds, e.Name())
			}
		}
	}
	var out []Run
	for _, rnd := range rounds {
		stamps, _ := os.ReadDir(filepath.Join(base, rnd))
		for _, s := range stamps {
			if !s.IsDir() {
				continue
			}
			r, err := Load(results, scenario+"/"+rnd+"/"+s.Name())
			if err != nil {
				continue // a run still being recorded, or an aborted one
			}
			out = append(out, r)
		}
	}
	return out, nil
}

// Dir returns the directory of a run id, refusing ids that would leave results.
func Dir(results, id string) (string, error) {
	parts := strings.Split(id, "/")
	if len(parts) != 3 {
		return "", fmt.Errorf("run id %q: want <scenario>/<round>/<stamp>", id)
	}
	for _, p := range parts {
		if p == "" || p == "." || p == ".." || strings.ContainsAny(p, `\`) {
			return "", fmt.Errorf("run id %q: bad component %q", id, p)
		}
	}
	return filepath.Join(results, parts[0], parts[1], parts[2]), nil
}

// Load reads one run.
func Load(results, id string) (Run, error) {
	dir, err := Dir(results, id)
	if err != nil {
		return Run{}, err
	}
	parts := strings.Split(id, "/")
	r := Run{ID: id, Scenario: parts[0], Round: parts[1], Stamp: parts[2], Errors: map[string]int{}, Recovery: "-"}

	var sum summary
	if err := readJSON(filepath.Join(dir, "summary.json"), &sum); err != nil {
		return r, err
	}
	var meta struct {
		Rate float64 `json:"rate"`
	}
	if readJSON(filepath.Join(dir, "meta.json"), &meta) == nil {
		r.Rate = meta.Rate
	}
	var readP99 []float64
	for op, s := range sum.Ops {
		r.Requests += s.N
		r.Failed += s.N - s.OK
		for code, n := range s.Errors {
			r.Errors[code] += n
		}
		if op == "order" {
			r.OrderP99ms = s.P99
		}
		if slices.Contains(reads, op) {
			readP99 = append(readP99, s.P99)
		}
	}
	if len(readP99) > 0 {
		r.ReadP99ms = slices.Max(readP99)
	}
	if sum.Retry != nil {
		r.RetriesSent, r.RetriesDenied = sum.Retry.Sent, sum.Retry.Denied
	}
	if r.Requests > 0 {
		r.FailedPct = math.Round(10000*float64(r.Failed)/float64(r.Requests)) / 100
	}

	perSec, err := perSecond(filepath.Join(dir, "load.csv"))
	if err != nil {
		return r, err
	}
	r.WorstSecondOK = 1
	for _, v := range perSec {
		if v[1] < v[0] {
			r.BadSeconds++
		}
		if v[0] > 0 {
			r.WorstSecondOK = min(r.WorstSecondOK, float64(v[1])/float64(v[0]))
		}
	}

	if name, b, ok := trigger(dir); ok {
		r.Trigger = name
		r.BatchSeconds, r.BatchRetries, r.BatchError = b.Seconds, b.Retries, b.Error
		loadStart, err1 := time.Parse(time.RFC3339, sum.StartedAt)
		batchStart, err2 := time.Parse(time.RFC3339Nano, b.StartedAt)
		if err1 == nil && err2 == nil {
			r.BatchStartS = batchStart.Sub(loadStart).Seconds()
			r.BatchEndS = r.BatchStartS + b.Seconds
			r.FailedAfterBatch, r.Recovery = afterBatch(perSec, r.BatchEndS)
		}
	}

	rows, _ := readCSV(filepath.Join(dir, "sampler.csv"))
	for _, row := range rows {
		r.MaxLockWaiters = max(r.MaxLockWaiters, atoi(row["pg_lock_wait"]))
		r.MaxBouncerQueue = max(r.MaxBouncerQueue, atoi(row["bouncer_cl_waiting"]))
		r.LongestXactS = max(r.LongestXactS, atof(row["longest_xact_s"]))
		r.MaxSessionsPerS = max(r.MaxSessionsPerS, atoi(row["pg_sessions_started"]))
	}
	return r, nil
}

// afterBatch counts failed requests from the batch's end to the end of the run,
// and how long after the batch ended the API was healthy again: the start of
// the first 10 consecutive seconds with at least 99% of requests succeeding.
func afterBatch(perSec map[int][2]int, end float64) (failed int, recovery string) {
	first := int(math.Ceil(end))
	last := 0
	for s := range perSec {
		last = max(last, s)
	}
	healthy := func(s int) bool {
		v, ok := perSec[s]
		return ok && v[0] > 0 && float64(v[1]) >= 0.99*float64(v[0])
	}
	recovery = "not within the run"
	found := false
	for s := first; s <= last; s++ {
		failed += perSec[s][0] - perSec[s][1]
		if found || s+9 > last {
			continue
		}
		all := true
		for k := s; k < s+10; k++ {
			all = all && healthy(k)
		}
		if all {
			recovery = fmt.Sprintf("%.0f s", max(0, float64(s)-end))
			found = true
		}
	}
	return failed, recovery
}

// Markdown renders runs as the comparison table used in the README.
func Markdown(rs []Run) string {
	var b strings.Builder
	b.WriteString("| Round | Run (UTC) | Rate | Requests | Failed | Seconds with failures | Worst second | Order p99 | Read p99 | Errors | Trigger job | Failed after it ended | Recovered | Max lock waiters | Max PgBouncer queue | Longest transaction | Max new sessions/s |\n")
	b.WriteString("|---|---|--:|--:|--:|--:|--:|--:|--:|---|---|--:|---|--:|--:|--:|--:|\n")
	for _, r := range rs {
		var codes []string
		for c, n := range r.Errors {
			codes = append(codes, fmt.Sprintf("%s %d", c, n))
		}
		slices.Sort(codes)
		errs := strings.Join(codes, ", ")
		if errs == "" {
			errs = "none"
		}
		if r.RetriesSent > 0 || r.RetriesDenied > 0 {
			errs += fmt.Sprintf("; %d retries sent, %d refused by budget", r.RetriesSent, r.RetriesDenied)
		}
		batch := "none"
		switch {
		case r.BatchError != "":
			batch = fmt.Sprintf("%s ended with an error after %.0f s", r.Trigger, r.BatchSeconds)
		case r.BatchSeconds > 0:
			batch = fmt.Sprintf("%.0f s", r.BatchSeconds)
			if r.Trigger != "" && r.Trigger != "batch" {
				batch = r.Trigger + " " + batch
			}
			if r.BatchRetries > 0 {
				batch += fmt.Sprintf(", %d retries", r.BatchRetries)
			}
		}
		fmt.Fprintf(&b, "| %s | %s | %.0f/s | %d | %d (%.2f%%) | %d | %.0f%% ok | %.0f ms | %.0f ms | %s | %s | %d | %s | %d | %d | %.1f s | %d |\n",
			r.Round, r.Stamp, r.Rate, r.Requests, r.Failed, r.FailedPct, r.BadSeconds, 100*r.WorstSecondOK,
			r.OrderP99ms, r.ReadP99ms, errs, batch, r.FailedAfterBatch, r.Recovery,
			r.MaxLockWaiters, r.MaxBouncerQueue, r.LongestXactS, r.MaxSessionsPerS)
	}
	return b.String()
}

// Second is one second of a run: what the callers saw and what each layer saw.
type Second struct {
	T          int                `json:"t"`
	Requests   int                `json:"requests"`
	OK         int                `json:"ok"`
	WorstP99ms float64            `json:"worst_op_p99_ms"`
	Errors     map[string]int     `json:"errors,omitempty"`
	DB         map[string]float64 `json:"db,omitempty"`
	Events     []string           `json:"events,omitempty"`
}

// signals are the sampler columns, in the order they are reported.
var signals = []string{"longest_xact_s", "pg_lock_wait", "pg_idle_in_tx", "pg_active", "pool_acquired",
	"pool_empty_acquires", "bouncer_cl_waiting", "bouncer_maxwait_ms", "pg_total", "pg_sessions_started",
	"pg_sessions_abandoned", "quotes_dead_tup", "quotes_bytes", "oldest_xmin_age"}

// Timeline returns the run second by second, joining the load generator's
// seconds to the sampler's rows by wall-clock second.
func Timeline(results, id string) ([]Second, error) {
	dir, err := Dir(results, id)
	if err != nil {
		return nil, err
	}
	var sum summary
	if err := readJSON(filepath.Join(dir, "summary.json"), &sum); err != nil {
		return nil, err
	}
	start, err := time.Parse(time.RFC3339, sum.StartedAt)
	if err != nil {
		return nil, err
	}
	rows, err := readCSV(filepath.Join(dir, "load.csv"))
	if err != nil {
		return nil, err
	}
	bySec := map[int]*Second{}
	maxSec := 0
	for _, row := range rows {
		t := int(atoi(row["sec"]))
		s := bySec[t]
		if s == nil {
			s = &Second{T: t}
			bySec[t] = s
		}
		maxSec = max(maxSec, t)
		s.Requests += int(atoi(row["n"]))
		s.OK += int(atoi(row["ok"]))
		s.WorstP99ms = max(s.WorstP99ms, atof(row["p99_ms"]))
		for _, c := range strings.Fields(row["error_codes"]) {
			code, n, ok := strings.Cut(c, ":")
			if ok {
				if s.Errors == nil {
					s.Errors = map[string]int{}
				}
				s.Errors[code] += int(atoi(n))
			}
		}
	}
	samp := map[string]map[string]float64{}
	srows, _ := readCSV(filepath.Join(dir, "sampler.csv"))
	for _, row := range srows {
		if len(row["t"]) < 19 {
			continue
		}
		db := map[string]float64{}
		for _, k := range signals {
			if v, ok := row[k]; ok && v != "" {
				db[k] = atof(v)
			}
		}
		if v, ok := row["int4_ids_left"]; ok && v != "" {
			db["int4_ids_left"] = atof(v)
		}
		samp[row["t"][:19]] = db
	}
	trig, b, hasBatch := trigger(dir)
	bStart, bEnd := -1, -1
	if hasBatch {
		if bs, err := time.Parse(time.RFC3339Nano, b.StartedAt); err == nil {
			bStart = int(bs.Sub(start).Seconds())
			bEnd = int(bs.Sub(start).Seconds() + b.Seconds)
		}
	}
	out := make([]Second, 0, maxSec+1)
	for t := 0; t <= maxSec; t++ {
		s := bySec[t]
		if s == nil {
			s = &Second{T: t}
		}
		s.DB = samp[start.Add(time.Duration(t)*time.Second).UTC().Format("2006-01-02T15:04:05")]
		if t == bStart {
			s.Events = append(s.Events, trig+"_start")
		}
		if t == bEnd {
			s.Events = append(s.Events, trig+"_end")
		}
		out = append(out, *s)
	}
	return out, nil
}

// Signal is when one indicator first moved after the batch started.
type Signal struct {
	Name          string  `json:"signal"`
	Baseline      float64 `json:"baseline_max"` // highest value before the batch
	FirstAboveS   int     `json:"first_above_baseline_s"`
	Value         float64 `json:"value_then"`
	LeadOverFailS int     `json:"lead_over_first_failure_s"` // positive: moved before callers failed
}

// FirstSignals answers "what should we have alerted on?" for a batch run:
// for each sampler signal, the first second after the batch started where it
// rose above everything it showed before the batch, and how many seconds that
// was ahead of the first failed request. Signals that never moved are omitted.
func FirstSignals(results, id string) (firstFailure int, out []Signal, err error) {
	tl, err := Timeline(results, id)
	if err != nil {
		return 0, nil, err
	}
	bStart := -1
	for _, s := range tl {
		for _, e := range s.Events {
			if strings.HasSuffix(e, "_start") {
				bStart = s.T
			}
		}
	}
	if bStart < 0 {
		return 0, nil, fmt.Errorf("run %s has no trigger job", id)
	}
	firstFailure = -1
	for _, s := range tl {
		if s.T >= bStart && s.OK < s.Requests {
			firstFailure = s.T
			break
		}
	}
	lo := 5 // skip the first seconds of warm-up, if the batch leaves room
	if lo >= bStart {
		lo = 0
	}
	for _, name := range signals {
		base := 0.0
		for _, s := range tl[lo:bStart] {
			base = max(base, s.DB[name])
		}
		for _, s := range tl[bStart:] {
			if v, ok := s.DB[name]; ok && v > base {
				sig := Signal{Name: name, Baseline: base, FirstAboveS: s.T, Value: v}
				if firstFailure >= 0 {
					sig.LeadOverFailS = firstFailure - s.T
				}
				out = append(out, sig)
				break
			}
		}
	}
	slices.SortStableFunc(out, func(a, b Signal) int { return a.FirstAboveS - b.FirstAboveS })
	return firstFailure, out, nil
}

func perSecond(path string) (map[int][2]int, error) {
	rows, err := readCSV(path)
	if err != nil {
		return nil, err
	}
	out := map[int][2]int{}
	for _, row := range rows {
		sec := int(atoi(row["sec"]))
		v := out[sec]
		out[sec] = [2]int{v[0] + int(atoi(row["n"])), v[1] + int(atoi(row["ok"]))}
	}
	return out, nil
}

func readJSON(path string, v any) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

func readCSV(path string) ([]map[string]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	recs, err := csv.NewReader(f).ReadAll()
	if err != nil || len(recs) == 0 {
		return nil, err
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

func atoi(s string) int64 {
	n, _ := strconv.ParseInt(s, 10, 64)
	return n
}

func atof(s string) float64 {
	f, _ := strconv.ParseFloat(s, 64)
	return f
}

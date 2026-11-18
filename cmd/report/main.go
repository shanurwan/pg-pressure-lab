// Command report turns recorded runs into a markdown table, one row per run,
// so the numbers in the README come straight from the result files.
//
//	report -results results -scenario batch
package main

import (
	"encoding/csv"
	"encoding/json"
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

type opSummary struct {
	N      int            `json:"n"`
	OK     int            `json:"ok"`
	P99    float64        `json:"p99_ms"`
	Errors map[string]int `json:"errors"`
}

type summary struct {
	StartedAt string               `json:"started_at"`
	Ops       map[string]opSummary `json:"ops"`
}

type batch struct {
	StartedAt string  `json:"started_at"`
	Seconds   float64 `json:"seconds"`
	Retries   int     `json:"lock_timeout_retries"`
	Error     string  `json:"error"`
}

// run is one recorded run, reduced to the numbers that compare rounds.
type run struct {
	round, stamp          string
	reqs, failed          int
	orderP99, readP99     float64
	worstSecOK            float64 // lowest per-second success ratio
	badSeconds            int     // seconds with any failed request
	errors                map[string]int
	batchSec              float64
	batchRetries          int
	batchErr              string
	maxLockWait, maxWaitQ int64
	maxXact               float64
	maxSessions           int64
	failedAfterBatch      int
	recovery              string // time from batch end to 10 straight seconds at >= 99% ok
}

var reads = []string{"account", "positions", "orders"}

func main() {
	dir := flag.String("results", "results", "results directory")
	scenario := flag.String("scenario", "batch", "scenario to report")
	order := flag.String("rounds", "", "comma-separated round order (default: alphabetical)")
	flag.Parse()

	base := filepath.Join(*dir, *scenario)
	roundDirs, err := os.ReadDir(base)
	if err != nil {
		log.Fatal(err)
	}
	var rounds []string
	for _, d := range roundDirs {
		if d.IsDir() {
			rounds = append(rounds, d.Name())
		}
	}
	if *order != "" {
		rounds = strings.Split(*order, ",")
	}

	fmt.Println("| Round | Run (UTC) | Requests | Failed | Seconds with failures | Worst second | Order p99 | Read p99 | Errors | Batch | Failed after batch ended | Recovered | Max lock waiters | Max PgBouncer queue | Longest transaction | Max new sessions/s |")
	fmt.Println("|---|---|--:|--:|--:|--:|--:|--:|---|---|--:|---|--:|--:|--:|--:|")
	for _, rnd := range rounds {
		stamps, _ := os.ReadDir(filepath.Join(base, rnd))
		for _, s := range stamps {
			r, err := load(filepath.Join(base, rnd, s.Name()))
			if err != nil {
				log.Printf("skip %s/%s: %v", rnd, s.Name(), err)
				continue
			}
			r.round, r.stamp = rnd, s.Name()
			fmt.Println(r.row())
		}
	}
}

func load(dir string) (run, error) {
	var r run
	var sum summary
	if err := readJSON(filepath.Join(dir, "summary.json"), &sum); err != nil {
		return r, err
	}
	r.errors = map[string]int{}
	var readP99 []float64
	for op, s := range sum.Ops {
		r.reqs += s.N
		r.failed += s.N - s.OK
		for code, n := range s.Errors {
			r.errors[code] += n
		}
		if op == "order" {
			r.orderP99 = s.P99
		}
		if slices.Contains(reads, op) {
			readP99 = append(readP99, s.P99)
		}
	}
	if len(readP99) > 0 {
		r.readP99 = slices.Max(readP99)
	}

	perSec, err := perSecond(filepath.Join(dir, "load.csv"))
	if err != nil {
		return r, err
	}
	r.worstSecOK = 1
	for _, v := range perSec {
		if v[1] < v[0] {
			r.badSeconds++
		}
		if v[0] > 0 {
			r.worstSecOK = min(r.worstSecOK, float64(v[1])/float64(v[0]))
		}
	}

	var b batch
	r.recovery = "-"
	if readJSON(filepath.Join(dir, "batch.json"), &b) == nil {
		r.batchSec, r.batchRetries, r.batchErr = b.Seconds, b.Retries, b.Error
		loadStart, err1 := time.Parse(time.RFC3339, sum.StartedAt)
		batchStart, err2 := time.Parse(time.RFC3339Nano, b.StartedAt)
		if err1 == nil && err2 == nil {
			end := batchStart.Sub(loadStart).Seconds() + b.Seconds
			r.failedAfterBatch, r.recovery = afterBatch(perSec, end)
		}
	}
	r.maxLockWait, r.maxWaitQ, r.maxXact, r.maxSessions = samplerMax(filepath.Join(dir, "sampler.csv"))
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

// perSecond returns, per second, [requests, ok] over all operations.
func perSecond(path string) (map[int][2]int, error) {
	rows, err := readCSV(path)
	if err != nil {
		return nil, err
	}
	out := map[int][2]int{}
	for _, row := range rows {
		sec, _ := strconv.Atoi(row["sec"])
		n, _ := strconv.Atoi(row["n"])
		ok, _ := strconv.Atoi(row["ok"])
		v := out[sec]
		out[sec] = [2]int{v[0] + n, v[1] + ok}
	}
	return out, nil
}

func samplerMax(path string) (lockWait, queue int64, xact float64, sessions int64) {
	rows, err := readCSV(path)
	if err != nil {
		return
	}
	for _, row := range rows {
		lw, _ := strconv.ParseInt(row["pg_lock_wait"], 10, 64)
		q, _ := strconv.ParseInt(row["bouncer_cl_waiting"], 10, 64)
		x, _ := strconv.ParseFloat(row["longest_xact_s"], 64)
		ss, _ := strconv.ParseInt(row["pg_sessions_started"], 10, 64)
		lockWait, queue, xact, sessions = max(lockWait, lw), max(queue, q), max(xact, x), max(sessions, ss)
	}
	return
}

func (r run) row() string {
	var codes []string
	for c, n := range r.errors {
		codes = append(codes, fmt.Sprintf("%s %d", c, n))
	}
	slices.Sort(codes)
	errs := strings.Join(codes, ", ")
	if errs == "" {
		errs = "none"
	}
	b := "none"
	switch {
	case r.batchErr != "":
		b = fmt.Sprintf("failed after %.0f s", r.batchSec)
	case r.batchSec > 0:
		b = fmt.Sprintf("%.0f s", r.batchSec)
		if r.batchRetries > 0 {
			b += fmt.Sprintf(", %d retries", r.batchRetries)
		}
	}
	return fmt.Sprintf("| %s | %s | %d | %d (%.2f%%) | %d | %.0f%% ok | %.0f ms | %.0f ms | %s | %s | %d | %s | %d | %d | %.1f s | %d |",
		r.round, r.stamp, r.reqs, r.failed, 100*float64(r.failed)/float64(max(r.reqs, 1)), r.badSeconds,
		100*r.worstSecOK, r.orderP99, r.readP99, errs, b, r.failedAfterBatch, r.recovery,
		r.maxLockWait, r.maxWaitQ, r.maxXact, r.maxSessions)
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
	if err != nil {
		return nil, err
	}
	if len(recs) == 0 {
		return nil, nil
	}
	var out []map[string]string
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

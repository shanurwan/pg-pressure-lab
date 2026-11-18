package runs

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A tiny synthetic run: 12 seconds at 10 req/s, a batch from second 4 to 6,
// failures from second 5 that last until second 8, and a lock-wait signal
// that rises at second 4.
func writeRun(t *testing.T, results string) string {
	t.Helper()
	id := "batch/naive/20261118T000000Z"
	dir := filepath.Join(results, filepath.FromSlash(id))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"meta.json":    `{"rate":10}`,
		"summary.json": `{"started_at":"2026-11-18T00:00:00Z","ops":{"order":{"n":120,"ok":90,"p99_ms":50,"errors":{"deadline":30}}}}`,
		"batch.json":   `{"started_at":"2026-11-18T00:00:04.000Z","seconds":2.0,"lock_timeout_retries":0}`,
	}
	var load, samp strings.Builder
	load.WriteString("sec,op,n,ok,errors,p50_ms,p99_ms,max_ms,error_codes\n")
	samp.WriteString("t,pg_active,pg_idle_in_tx,pg_lock_wait,pg_total,longest_xact_s,bouncer_cl_waiting,bouncer_maxwait_ms,pool_acquired,pool_empty_acquires\n")
	for s := 0; s < 12; s++ {
		ok, codes := 10, ""
		if s >= 5 && s <= 7 {
			ok, codes = 0, "deadline:10"
		}
		fmt.Fprintf(&load, "%d,order,10,%d,%d,5,9,9,%s\n", s, ok, 10-ok, codes)
		lock := 0
		if s >= 4 && s <= 6 {
			lock = 7
		}
		fmt.Fprintf(&samp, "2026-11-18T00:00:%02d.500Z,1,0,%d,20,0.1,0,0,2,0\n", s, lock)
	}
	files["load.csv"], files["sampler.csv"] = load.String(), samp.String()
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return id
}

func TestLoad(t *testing.T) {
	results := t.TempDir()
	id := writeRun(t, results)
	r, err := Load(results, id)
	if err != nil {
		t.Fatal(err)
	}
	if r.Requests != 120 || r.Failed != 30 || r.BadSeconds != 3 || r.MaxLockWaiters != 7 {
		t.Fatalf("totals wrong: %+v", r)
	}
	// Batch ends at 6.0 s; seconds 6 and 7 fail (20 requests); healthy from 8.
	if r.FailedAfterBatch != 20 || r.Recovery != "not within the run" {
		// only 4 healthy seconds (8..11) remain, fewer than the 10 required
		t.Fatalf("after-batch wrong: failed %d, recovery %q", r.FailedAfterBatch, r.Recovery)
	}
}

func TestFirstSignals(t *testing.T) {
	results := t.TempDir()
	id := writeRun(t, results)
	first, sigs, err := FirstSignals(results, id)
	if err != nil {
		t.Fatal(err)
	}
	if first != 5 {
		t.Fatalf("first failure = %d, want 5", first)
	}
	if len(sigs) != 1 || sigs[0].Name != "pg_lock_wait" || sigs[0].FirstAboveS != 4 || sigs[0].LeadOverFailS != 1 {
		t.Fatalf("signals wrong: %+v", sigs)
	}
}

func TestDirRejectsEscapes(t *testing.T) {
	for _, bad := range []string{"../etc/passwd/x", "batch/naive", "batch/../x", "a/b/c/d", `a/b\c/d`} {
		if _, err := Dir("results", bad); err == nil {
			t.Errorf("Dir accepted %q", bad)
		}
	}
	if _, err := Dir("results", "batch/naive/20261118T000000Z"); err != nil {
		t.Fatal(err)
	}
}

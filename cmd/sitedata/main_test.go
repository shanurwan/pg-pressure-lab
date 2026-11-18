package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func write(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestLoadRunJoinsSamplerAndBatch(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "meta.json", `{"rate":300,"duration":"180s"}`)
	write(t, dir, "summary.json", `{"started_at":"2026-11-18T04:00:00Z","ops":{
		"order":{"n":4,"ok":2,"p99_ms":50},"account":{"n":4,"ok":4,"p99_ms":9}}}`)
	write(t, dir, "load.csv", "sec,op,n,ok,errors,p50_ms,p99_ms,max_ms,error_codes\n"+
		"0,order,1,1,0,10.0,10.0,10.0,\n0,account,1,1,0,1.0,1.0,1.0,\n"+
		"1,order,1,0,1,0.0,0.0,0.0,deadline:1\n1,account,1,1,0,1.0,1.0,1.0,\n"+
		"2,order,1,0,1,0.0,0.0,0.0,deadline:1\n2,account,1,1,0,1.0,1.0,1.0,\n"+
		"3,order,1,1,0,9.0,9.0,9.0,\n3,account,1,1,0,1.0,1.0,1.0,\n")
	// Old-format sampler (no session columns), one row before the load start,
	// two rows inside second 1 (the later wins), one row after the run.
	write(t, dir, "sampler.csv", "t,pg_active,pg_idle_in_tx,pg_lock_wait,pg_total,longest_xact_s,"+
		"bouncer_cl_waiting,bouncer_maxwait_ms,pool_acquired,pool_empty_acquires\n"+
		"2026-11-18T03:59:59.500Z,9,0,0,9,0,0,0,0,0\n"+
		"2026-11-18T04:00:01.100Z,1,0,3,5,1.5,0,0,4,0\n"+
		"2026-11-18T04:00:01.900Z,2,0,7,5,1.9,4,300,40,12\n"+
		"2026-11-18T04:00:09.000Z,1,0,0,1,0,0,0,0,0\n")
	write(t, dir, "batch.json", `{"started_at":"2026-11-18T04:00:00.600Z","seconds":1.5}`)

	r, err := loadRun(dir, "batch", "naive", "X")
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Frames) != 4 {
		t.Fatalf("want 4 frames, got %d", len(r.Frames))
	}
	if r.Frames[0].DB != nil {
		t.Errorf("sample before load start must be dropped, got %+v", r.Frames[0].DB)
	}
	db := r.Frames[1].DB
	if db == nil || db.PgLockWait != 7 || db.PoolAcquired != 40 {
		t.Fatalf("second 1 should hold the later sample, got %+v", db)
	}
	if db.PgSessionsStarted != nil {
		t.Errorf("old sampler has no session columns: want null, got %v", *db.PgSessionsStarted)
	}
	if r.Frames[1].Ops["order"].Errors["deadline"] != 1 {
		t.Errorf("error codes not parsed: %+v", r.Frames[1].Ops["order"])
	}
	if r.BatchWindow == nil || r.BatchWindow.StartS != 0.6 || r.BatchWindow.EndS != 2.1 {
		t.Fatalf("batch window wrong: %+v", r.BatchWindow)
	}
	if got := r.Frames[0].Events; len(got) != 1 || got[0] != "batch_start" {
		t.Errorf("batch_start should be on second 0: %v", got)
	}
	if got := r.Frames[3].Events; len(got) != 1 || got[0] != "batch_end" {
		t.Errorf("batch_end should be on second 3 (ceil of 2.1): %v", got)
	}
	h := r.Headline
	if h.Requests != 8 || h.Failed != 2 || h.SecondsFailing != 2 {
		t.Errorf("headline counts wrong: %+v", h)
	}
	if h.FailedAfterBatch == nil || *h.FailedAfterBatch != 0 || *h.FailedInBatch != 2 {
		t.Errorf("failures around the batch wrong: after %v during %v", h.FailedAfterBatch, h.FailedInBatch)
	}
	if h.RecoveredS != nil {
		t.Errorf("fewer than 10 seconds after the batch: recovery must be null, got %v", *h.RecoveredS)
	}
	b, _ := json.Marshal(r.Frames[1].DB)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	if v, ok := m["pg_sessions_started"]; !ok || v != nil {
		t.Errorf("pg_sessions_started must be present and null in JSON, got %v (%v)", v, ok)
	}
}

func TestRecoveryNeedsTenHealthySeconds(t *testing.T) {
	var frames []frame
	for s := 0; s < 30; s++ {
		ok := 10
		if s >= 5 && s < 12 {
			ok = 0
		}
		frames = append(frames, frame{T: s, Ops: map[string]opFrame{"account": {N: 10, OK: ok}}})
	}
	h := computeHeadline(frames, &window{StartS: 2, EndS: 8.4}, json.RawMessage(`{}`))
	if h.RecoveredS == nil || *h.RecoveredS != 3.6 {
		t.Fatalf("want recovery 3.6 s (second 12 - 8.4), got %v", h.RecoveredS)
	}
	if *h.FailedAfterBatch != 30 || *h.FailedInBatch != 40 {
		t.Fatalf("after %d during %d", *h.FailedAfterBatch, *h.FailedInBatch)
	}
}

func TestJobWindowFromEvents(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "meta.json", `{"rate":300,"duration":"180s"}`)
	write(t, dir, "summary.json", `{"started_at":"2026-11-18T04:00:00Z","ops":{"order":{"n":3,"ok":3,"p99_ms":5}}}`)
	write(t, dir, "load.csv", "sec,op,n,ok,errors,p50_ms,p99_ms,max_ms,error_codes\n"+
		"0,order,1,1,0,1.0,1.0,1.0,\n1,order,1,1,0,1.0,1.0,1.0,\n2,order,1,1,0,1.0,1.0,1.0,\n")
	write(t, dir, "events.jsonl", `{"wall":"2026-11-18T04:00:01Z","event":"migration_start"}`+"\n"+
		`{"wall":"2026-11-18T04:00:02Z","event":"migration_end"}`+"\n")
	r, err := loadRun(dir, "migration", "alter-naive", "X")
	if err != nil {
		t.Fatal(err)
	}
	if r.Job != "migration" || r.BatchWindow == nil || r.BatchWindow.StartS != 1 || r.BatchWindow.EndS != 2 {
		t.Fatalf("job window wrong: job %q window %+v", r.Job, r.BatchWindow)
	}
	if got := r.Frames[1].Events; len(got) != 1 || got[0] != "migration_start" {
		t.Fatalf("events not placed: %v", got)
	}
}

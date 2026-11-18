package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func write(t *testing.T, path, s string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(s); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()
}

func TestTailerJoinsLoadSamplerAndEvents(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "sampler.csv"),
		"t,pg_active,pg_idle_in_tx,pg_lock_wait,pg_total,longest_xact_s,bouncer_cl_waiting,bouncer_maxwait_ms,pool_acquired,pool_empty_acquires\n"+
			"2026-11-18T04:12:23.475Z,3,0,20,21,30.03,39,347,40,84\n")
	write(t, filepath.Join(dir, "events.jsonl"), `{"wall":"2026-11-18T04:12:23Z","event":"batch_start"}`+"\n")
	write(t, filepath.Join(dir, "live.jsonl"),
		`{"t":7,"wall":"2026-11-18T04:12:23Z","ops":{"order":{"n":10,"ok":4,"p50":5,"p99":9,"errors":{"deadline":6}}}}`+"\n"+
			`{"t":8,"wall":"2026-11-18T04:12:24Z","ops":{}`) // incomplete line: not read yet

	tl := newTailer(dir)
	frames := tl.poll()
	if len(frames) != 1 {
		t.Fatalf("want 1 frame, got %d", len(frames))
	}
	f := frames[0]
	if f.T != 7 || f.DB["pg_lock_wait"] != int64(20) || f.DB["longest_xact_s"] != 30.03 {
		t.Fatalf("frame not joined to its sampler row: %+v", f)
	}
	if f.DB["pg_sessions_started"] != nil {
		t.Fatalf("a column the sampler did not write must be null, got %v", f.DB["pg_sessions_started"])
	}
	if len(f.Events) != 1 || f.Events[0] != "batch_start" {
		t.Fatalf("event missing: %v", f.Events)
	}
	var ops map[string]map[string]any
	if err := json.Unmarshal(f.Ops, &ops); err != nil || ops["order"]["ok"] != 4.0 {
		t.Fatalf("ops not passed through: %s", f.Ops)
	}

	// The rest of the incomplete line arrives; with no sampler row yet the frame waits.
	write(t, filepath.Join(dir, "live.jsonl"), "}\n")
	if got := tl.poll(); len(got) != 0 {
		t.Fatalf("frame without its sampler row released too early: %+v", got)
	}
	write(t, filepath.Join(dir, "sampler.csv"), "2026-11-18T04:12:24.476Z,0,0,0,21,0.00,0,0,2,0\n")
	if got := tl.poll(); len(got) != 1 || got[0].T != 8 || got[0].DB["pg_lock_wait"] != int64(0) {
		t.Fatalf("second frame wrong: %+v", got)
	}
}

func TestNewestLiveRun(t *testing.T) {
	root := t.TempDir()
	for _, d := range []string{"batch/naive/20261118T041152Z", "batch/chunked/20261118T042133Z", "conn/shared/20261118T050000Z"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write(t, filepath.Join(root, "batch/naive/20261118T041152Z/live.jsonl"), "")
	write(t, filepath.Join(root, "batch/chunked/20261118T042133Z/live.jsonl"), "")
	// conn/shared has no live.jsonl: an older run without -live, not followed.
	got := newestLiveRun(root)
	if filepath.Base(got) != "20261118T042133Z" {
		t.Fatalf("got %s", got)
	}
}

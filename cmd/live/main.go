// Command live serves the course site against your own lab: it follows the
// newest run under the results directory as it is being recorded and streams
// one frame per second over Server-Sent Events at /live/events, in the same
// format the site replays from recorded runs.
//
// It is read-only: it tails the files the drill writes (live.jsonl from the
// load generator, sampler.csv, events.jsonl from scripts/lab) and never touches
// the database.
package main

import (
	"bufio"
	"encoding/csv"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

func main() {
	var (
		results = flag.String("results", "/results", "results directory to follow")
		site    = flag.String("site", "/site", "site directory to serve")
		addr    = flag.String("addr", ":8090", "listen address")
	)
	flag.Parse()

	h := newHub()
	go follow(*results, h)

	mux := http.NewServeMux()
	mux.Handle("GET /", http.FileServer(http.Dir(*site)))
	mux.HandleFunc("GET /live/events", h.serveSSE)
	mux.HandleFunc("GET /live/status", h.serveStatus)
	log.Printf("serving %s and following %s on %s", *site, *results, *addr)
	srv := &http.Server{Addr: *addr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	log.Fatal(srv.ListenAndServe())
}

// runInfo identifies the run being followed.
type runInfo struct {
	ID       string          `json:"id"`
	Scenario string          `json:"scenario"`
	Round    string          `json:"round"`
	Meta     json.RawMessage `json:"meta,omitempty"`
}

// frame is one second, in the site's frame format.
type frame struct {
	T      int             `json:"t"`
	Ops    json.RawMessage `json:"ops"`
	DB     map[string]any  `json:"db"`
	Events []string        `json:"events"`
}

// hub keeps the current run's frames so a page opened mid-run catches up, and
// fans new frames out to every connected page.
type hub struct {
	mu      sync.Mutex
	run     *runInfo
	frames  []frame
	clients map[chan []byte]struct{}
}

func newHub() *hub { return &hub{clients: map[chan []byte]struct{}{}} }

func sse(event string, v any) []byte {
	b, _ := json.Marshal(v)
	return []byte(fmt.Sprintf("event: %s\ndata: %s\n\n", event, b))
}

func (h *hub) broadcast(msg []byte) {
	for c := range h.clients {
		select {
		case c <- msg:
		default: // a slow page misses a frame rather than stalling everyone
		}
	}
}

func (h *hub) startRun(r runInfo) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.run, h.frames = &r, nil
	h.broadcast(sse("run", r))
}

func (h *hub) addFrame(f frame) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.frames = append(h.frames, f)
	h.broadcast(sse("frame", f))
}

func (h *hub) serveSSE(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	c := make(chan []byte, 256)

	h.mu.Lock()
	var backlog [][]byte
	if h.run != nil {
		backlog = append(backlog, sse("run", h.run))
		for _, f := range h.frames {
			backlog = append(backlog, sse("frame", f))
		}
	}
	h.clients[c] = struct{}{}
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.clients, c)
		h.mu.Unlock()
	}()

	for _, m := range backlog {
		_, _ = w.Write(m)
	}
	_, _ = io.WriteString(w, ": connected\n\n")
	fl.Flush()
	ping := time.NewTicker(15 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case m := <-c:
			_, _ = w.Write(m)
			fl.Flush()
		case <-ping.C:
			_, _ = io.WriteString(w, ": ping\n\n")
			fl.Flush()
		}
	}
}

func (h *hub) serveStatus(w http.ResponseWriter, _ *http.Request) {
	h.mu.Lock()
	defer h.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"run": h.run, "frames": len(h.frames)})
}

// follow polls for the newest run directory that has a live.jsonl and tails it.
func follow(results string, h *hub) {
	var cur string
	var t *tailer
	for {
		if dir := newestLiveRun(results); dir != "" && dir != cur {
			cur = dir
			t = newTailer(dir)
			h.startRun(t.info(results))
			log.Printf("following %s", dir)
		}
		if t != nil {
			for _, f := range t.poll() {
				h.addFrame(f)
			}
		}
		time.Sleep(250 * time.Millisecond)
	}
}

// newestLiveRun returns results/<scenario>/<round>/<stamp> with the latest
// stamp that has a live.jsonl. Stamps are UTC and sort as strings.
func newestLiveRun(results string) string {
	matches, _ := filepath.Glob(filepath.Join(results, "*", "*", "*", "live.jsonl"))
	best, bestStamp := "", ""
	for _, m := range matches {
		dir := filepath.Dir(m)
		if s := filepath.Base(dir); s > bestStamp {
			best, bestStamp = dir, s
		}
	}
	return best
}

// tailer reads what the drill has appended since the last poll and turns it
// into frames, joining the load generator's seconds to the sampler's rows by
// wall-clock second.
type tailer struct {
	dir                     string
	liveOff, sampOff, evOff int64
	sampHeader              []string
	sampler                 map[string]map[string]any // wall second -> db fields
	events                  map[string][]string       // wall second -> events
	pending                 []pendingFrame
}

type pendingFrame struct {
	f     frame
	wall  string
	since time.Time
}

func newTailer(dir string) *tailer {
	return &tailer{dir: dir, sampler: map[string]map[string]any{}, events: map[string][]string{}}
}

func (t *tailer) info(results string) runInfo {
	rel, _ := filepath.Rel(results, t.dir)
	parts := strings.Split(filepath.ToSlash(rel), "/")
	ri := runInfo{ID: strings.Join(parts, "-")}
	if len(parts) == 3 {
		ri.Scenario, ri.Round = parts[0], parts[1]
	}
	if b, err := os.ReadFile(filepath.Join(t.dir, "meta.json")); err == nil && json.Valid(b) {
		ri.Meta = b
	}
	return ri
}

// readNew returns complete lines appended to name since *off.
func readNew(path string, off *int64) []string {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer func() { _ = f.Close() }()
	if _, err := f.Seek(*off, io.SeekStart); err != nil {
		return nil
	}
	var lines []string
	r := bufio.NewReader(f)
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			break // an incomplete last line is read next time
		}
		*off += int64(len(line))
		lines = append(lines, strings.TrimRight(line, "\r\n"))
	}
	return lines
}

var dbInts = []string{"pg_active", "pg_idle_in_tx", "pg_lock_wait", "pg_total", "bouncer_cl_waiting",
	"bouncer_maxwait_ms", "pool_acquired", "pool_empty_acquires", "pg_sessions_started", "pg_sessions_abandoned"}

func (t *tailer) poll() []frame {
	for _, line := range readNew(filepath.Join(t.dir, "sampler.csv"), &t.sampOff) {
		rec, err := csv.NewReader(strings.NewReader(line)).Read()
		if err != nil {
			continue
		}
		if t.sampHeader == nil {
			t.sampHeader = rec
			continue
		}
		row := map[string]string{}
		for i, h := range t.sampHeader {
			if i < len(rec) {
				row[h] = rec[i]
			}
		}
		if len(row["t"]) < 19 {
			continue
		}
		db := map[string]any{}
		for _, k := range dbInts {
			if v, ok := row[k]; ok {
				n, _ := strconv.ParseInt(v, 10, 64)
				db[k] = n
			} else {
				db[k] = nil
			}
		}
		x, _ := strconv.ParseFloat(row["longest_xact_s"], 64)
		db["longest_xact_s"] = x
		t.sampler[row["t"][:19]] = db
	}
	for _, line := range readNew(filepath.Join(t.dir, "events.jsonl"), &t.evOff) {
		var e struct{ Wall, Event string }
		if json.Unmarshal([]byte(line), &e) == nil && len(e.Wall) >= 19 {
			t.events[e.Wall[:19]] = append(t.events[e.Wall[:19]], e.Event)
		}
	}
	for _, line := range readNew(filepath.Join(t.dir, "live.jsonl"), &t.liveOff) {
		var l struct {
			T    int             `json:"t"`
			Wall string          `json:"wall"`
			Ops  json.RawMessage `json:"ops"`
		}
		if json.Unmarshal([]byte(line), &l) != nil || len(l.Wall) < 19 {
			continue
		}
		t.pending = append(t.pending, pendingFrame{
			f: frame{T: l.T, Ops: l.Ops, Events: []string{}}, wall: l.Wall[:19], since: time.Now()})
	}

	// Release a frame once its sampler row has arrived, or after a short grace
	// period without one, so a stopped sampler never freezes the stream.
	var out []frame
	keep := t.pending[:0]
	for _, p := range t.pending {
		db, ok := t.sampler[p.wall]
		if !ok && time.Since(p.since) < 2*time.Second {
			keep = append(keep, p)
			continue
		}
		p.f.DB = db
		if p.f.DB == nil {
			p.f.DB = map[string]any{}
		}
		p.f.Events = append(p.f.Events, t.events[p.wall]...)
		out = append(out, p.f)
	}
	t.pending = keep
	slices.SortFunc(out, func(a, b frame) int { return a.T - b.T })
	return out
}

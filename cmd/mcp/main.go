// Command mcp is a Model Context Protocol server (stdio) for the lab. It lets
// an AI assistant read recorded runs the same way the README does, line up
// what each layer saw second by second, ask which signal moved first, and,
// with -allow-run, run a drill on your local lab and read the result.
//
//	claude mcp add pg-pressure-lab -- go run ./cmd/mcp -repo "$PWD"
//	claude mcp add pg-pressure-lab -- go run ./cmd/mcp -repo "$PWD" -allow-run
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/shanurwan/pg-pressure-lab/internal/runs"
)

type lab struct {
	repo     string
	results  string
	allowRun bool
}

func main() {
	repo := flag.String("repo", ".", "path to the pg-pressure-lab checkout")
	allowRun := flag.Bool("allow-run", false, "enable run_drill, which puts load on the local lab")
	flag.Parse()
	abs, err := filepath.Abs(*repo)
	if err != nil {
		log.Fatal(err)
	}
	l := &lab{repo: abs, results: filepath.Join(abs, "results"), allowRun: *allowRun}

	s := mcp.NewServer(&mcp.Implementation{Name: "pg-pressure-lab", Version: "0.1.0"}, nil)
	mcp.AddTool(s, &mcp.Tool{Name: "list_rounds",
		Description: "List the rounds of a scenario (batch or conn) with what each round changes."}, l.listRounds)
	mcp.AddTool(s, &mcp.Tool{Name: "list_runs",
		Description: "Recorded runs of a scenario with their headline numbers: requests, failures, p99, " +
			"failures after the batch ended, time to recover, max lock waiters, PgBouncer queue, longest " +
			"transaction, new sessions per second. Also returns the README-style markdown table."}, l.listRuns)
	mcp.AddTool(s, &mcp.Tool{Name: "get_timeline",
		Description: "One run, second by second: requests, successes, worst p99, errors by code, and what " +
			"PostgreSQL, PgBouncer and the API pool showed in that second. Use from_s/to_s to zoom in."}, l.timeline)
	mcp.AddTool(s, &mcp.Tool{Name: "first_signals",
		Description: "For a run with a batch: which signals rose above their pre-batch maximum first, and " +
			"how many seconds before the first failed request. Answers 'what should we have alerted on?'"}, l.firstSignals)
	mcp.AddTool(s, &mcp.Tool{Name: "run_drill",
		Description: "Run one round on the local lab (scripts/lab run) and return its numbers. Takes about " +
			"as long as the duration plus ~30 s. Only available when the server was started with -allow-run, " +
			"and needs the lab up and seeded."}, l.runDrill)

	if err := s.Run(context.Background(), &mcp.StdioTransport{}); err != nil {
		log.Fatal(err)
	}
}

var name = regexp.MustCompile(`^[a-z][a-z0-9-]{0,40}$`)

type scenarioIn struct {
	Scenario string `json:"scenario" jsonschema:"batch or conn"`
}

type roundsOut struct {
	Scenario string   `json:"scenario"`
	Rounds   []string `json:"rounds"`
	Notes    string   `json:"notes"`
}

// rounds asks the driver script itself, so the list can never drift from it.
func (l *lab) rounds(ctx context.Context, scenario string) ([]string, error) {
	if !name.MatchString(scenario) {
		return nil, fmt.Errorf("bad scenario %q", scenario)
	}
	out, err := exec.CommandContext(ctx, filepath.Join(l.repo, "scripts", "lab"), "rounds", scenario).Output()
	if err != nil {
		return nil, fmt.Errorf("scripts/lab rounds: %w", err)
	}
	rs := strings.Fields(string(out))
	if len(rs) == 0 {
		return nil, fmt.Errorf("unknown scenario %q", scenario)
	}
	return rs, nil
}

func (l *lab) listRounds(ctx context.Context, _ *mcp.CallToolRequest, in scenarioIn) (*mcp.CallToolResult, roundsOut, error) {
	rs, err := l.rounds(ctx, in.Scenario)
	if err != nil {
		return nil, roundsOut{}, err
	}
	return nil, roundsOut{Scenario: in.Scenario, Rounds: rs,
		Notes: "Each round changes one thing from the one before it; see the comments in scripts/lab."}, nil
}

type listRunsIn struct {
	Scenario string   `json:"scenario" jsonschema:"batch or conn"`
	Rounds   []string `json:"rounds,omitempty" jsonschema:"optional round order, e.g. [baseline naive chunked]"`
}

type listRunsOut struct {
	Runs     []runs.Run `json:"runs"`
	Markdown string     `json:"markdown"`
}

func (l *lab) listRuns(_ context.Context, _ *mcp.CallToolRequest, in listRunsIn) (*mcp.CallToolResult, listRunsOut, error) {
	if !name.MatchString(in.Scenario) {
		return nil, listRunsOut{}, fmt.Errorf("bad scenario %q", in.Scenario)
	}
	for _, r := range in.Rounds {
		if !name.MatchString(r) {
			return nil, listRunsOut{}, fmt.Errorf("bad round %q", r)
		}
	}
	rs, err := runs.List(l.results, in.Scenario, in.Rounds)
	if err != nil {
		return nil, listRunsOut{}, err
	}
	return nil, listRunsOut{Runs: rs, Markdown: runs.Markdown(rs)}, nil
}

type timelineIn struct {
	RunID string `json:"run_id" jsonschema:"<scenario>/<round>/<stamp>, as list_runs returns it"`
	FromS int    `json:"from_s,omitempty" jsonschema:"first second to return (default 0)"`
	ToS   int    `json:"to_s,omitempty" jsonschema:"last second to return (default: end of run)"`
}

type timelineOut struct {
	RunID   string        `json:"run_id"`
	Seconds []runs.Second `json:"seconds"`
}

func (l *lab) timeline(_ context.Context, _ *mcp.CallToolRequest, in timelineIn) (*mcp.CallToolResult, timelineOut, error) {
	tl, err := runs.Timeline(l.results, in.RunID)
	if err != nil {
		return nil, timelineOut{}, err
	}
	to := in.ToS
	if to <= 0 || to >= len(tl) {
		to = len(tl) - 1
	}
	from := max(0, in.FromS)
	if from > to {
		return nil, timelineOut{}, fmt.Errorf("from_s %d is after to_s %d", from, to)
	}
	return nil, timelineOut{RunID: in.RunID, Seconds: tl[from : to+1]}, nil
}

type runIDIn struct {
	RunID string `json:"run_id" jsonschema:"<scenario>/<round>/<stamp>, as list_runs returns it"`
}

type signalsOut struct {
	RunID          string        `json:"run_id"`
	FirstFailureS  int           `json:"first_failed_request_s"`
	Signals        []runs.Signal `json:"signals"`
	Interpretation string        `json:"how_to_read"`
}

func (l *lab) firstSignals(_ context.Context, _ *mcp.CallToolRequest, in runIDIn) (*mcp.CallToolResult, signalsOut, error) {
	first, sigs, err := runs.FirstSignals(l.results, in.RunID)
	if err != nil {
		return nil, signalsOut{}, err
	}
	return nil, signalsOut{RunID: in.RunID, FirstFailureS: first, Signals: sigs,
		Interpretation: "Signals are sorted by when they first rose above their highest pre-batch value. " +
			"lead_over_first_failure_s > 0 means the signal moved that many seconds before any caller saw " +
			"an error: a candidate for alerting. first_failed_request_s is -1 when nothing failed."}, nil
}

type runDrillIn struct {
	Scenario  string `json:"scenario" jsonschema:"batch or conn"`
	Round     string `json:"round" jsonschema:"a round from list_rounds"`
	Rate      int    `json:"rate,omitempty" jsonschema:"requests per second, 1 to 2000 (default 300)"`
	DurationS int    `json:"duration_s,omitempty" jsonschema:"seconds of load, 20 to 600 (default 180)"`
}

func (l *lab) runDrill(ctx context.Context, _ *mcp.CallToolRequest, in runDrillIn) (*mcp.CallToolResult, runs.Run, error) {
	if !l.allowRun {
		return nil, runs.Run{}, errors.New("run_drill is disabled: start the server with -allow-run to enable it")
	}
	rs, err := l.rounds(ctx, in.Scenario)
	if err != nil {
		return nil, runs.Run{}, err
	}
	if !slices.Contains(rs, in.Round) {
		return nil, runs.Run{}, fmt.Errorf("round %q is not one of %v", in.Round, rs)
	}
	rate, dur := in.Rate, in.DurationS
	if rate == 0 {
		rate = 300
	}
	if dur == 0 {
		dur = 180
	}
	if rate < 1 || rate > 2000 || dur < 20 || dur > 600 {
		return nil, runs.Run{}, fmt.Errorf("rate must be 1..2000 and duration_s 20..600")
	}
	before := time.Now().UTC().Format("20060102T150405Z")
	cmd := exec.CommandContext(ctx, filepath.Join(l.repo, "scripts", "lab"), "run", in.Scenario, in.Round)
	cmd.Dir = l.repo
	cmd.Env = append(os.Environ(), fmt.Sprintf("RATE=%d", rate), fmt.Sprintf("DURATION=%ds", dur))
	if out, err := cmd.CombinedOutput(); err != nil {
		tail := string(out)
		if len(tail) > 2000 {
			tail = tail[len(tail)-2000:]
		}
		return nil, runs.Run{}, fmt.Errorf("scripts/lab run failed: %v\n%s", err, tail)
	}
	// The newest run of this round started at or after `before`.
	entries, _ := os.ReadDir(filepath.Join(l.results, in.Scenario, in.Round))
	var stamps []string
	for _, e := range entries {
		if e.IsDir() && e.Name() >= before {
			stamps = append(stamps, e.Name())
		}
	}
	if len(stamps) == 0 {
		return nil, runs.Run{}, errors.New("the run finished but its results were not found")
	}
	slices.Sort(stamps)
	r, err := runs.Load(l.results, in.Scenario+"/"+in.Round+"/"+stamps[len(stamps)-1])
	return nil, r, err
}

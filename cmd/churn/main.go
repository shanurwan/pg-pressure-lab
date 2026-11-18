// Command churn is a market-data feed: it updates the quotes table at a fixed
// rate for a fixed time. Each UPDATE leaves a dead row version behind, which
// VACUUM (or page pruning) can only remove once no transaction can still see
// it. Hold the xmin horizon back and the table bloats.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math/rand/v2"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	var (
		dsn      = flag.String("dsn", os.Getenv("DATABASE_URL"), "connection string")
		rate     = flag.Int("rate", 2000, "updates per second")
		duration = flag.Duration("duration", 3*time.Minute, "how long to run")
		symbols  = flag.Int("symbols", 2000, "quotes are S0001..S<symbols>")
		workers  = flag.Int("workers", 8, "concurrent connections")
		out      = flag.String("out", "", "write result JSON here")
	)
	flag.Parse()
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, *dsn)
	if err != nil {
		log.Fatal(err)
	}
	defer pool.Close()

	var sent, failed atomic.Int64
	work := make(chan string, *workers*4)
	var wg sync.WaitGroup
	for range *workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for sym := range work {
				mid := 10 + rand.Float64()*490
				if _, err := pool.Exec(ctx,
					`UPDATE quotes SET bid = $2, ask = $3, updated_at = now() WHERE symbol = $1`,
					sym, mid-0.01, mid+0.01); err != nil {
					failed.Add(1)
				}
				sent.Add(1)
			}
		}()
	}
	start := time.Now()
	interval := time.Second / time.Duration(*rate)
	for i := 0; ; i++ {
		due := start.Add(time.Duration(i) * interval)
		if due.Sub(start) >= *duration {
			break
		}
		if d := time.Until(due); d > 0 {
			time.Sleep(d)
		}
		select {
		case work <- fmt.Sprintf("S%04d", 1+rand.IntN(*symbols)):
		default: // the database is not keeping up; skip rather than queue forever
		}
	}
	close(work)
	wg.Wait()
	res := map[string]any{"mode": "churn", "rate": *rate, "seconds": time.Since(start).Seconds(),
		"updates": sent.Load(), "failed": failed.Load(), "started_at": start.UTC().Format(time.RFC3339Nano)}
	b, _ := json.MarshalIndent(res, "", "  ")
	log.Printf("%s", b)
	if *out != "" {
		if err := os.WriteFile(*out, b, 0o644); err != nil {
			log.Fatal(err)
		}
	}
}

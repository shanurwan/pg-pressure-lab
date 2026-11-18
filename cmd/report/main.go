// Command report turns recorded runs into a markdown table, one row per run,
// so the numbers in the README come straight from the result files.
//
//	report -results results -scenario batch -rounds baseline,naive,chunked
package main

import (
	"flag"
	"fmt"
	"log"
	"strings"

	"github.com/shanurwan/pg-pressure-lab/internal/runs"
)

func main() {
	dir := flag.String("results", "results", "results directory")
	scenario := flag.String("scenario", "batch", "scenario to report")
	order := flag.String("rounds", "", "comma-separated round order (default: alphabetical)")
	flag.Parse()

	var rounds []string
	if *order != "" {
		rounds = strings.Split(*order, ",")
	}
	rs, err := runs.List(*dir, *scenario, rounds)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Print(runs.Markdown(rs))
}

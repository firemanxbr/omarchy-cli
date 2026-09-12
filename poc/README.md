# Proof of concept (September 2026)

omarchy-pool started as a proof of concept for the Omarchy repository migration,
built to answer three questions from the packaging team:

1. Can an **immutable package pool plus an index** cleanly represent complete releases?
2. Can **valid, signed pacman databases** be generated from that index?
3. Does a **thin Omarchy client** give enough control to justify becoming part of the system?

All three were answered with evidence — [RESULTS.md](RESULTS.md) — and the design
then became the staging environment described in the top-level README. This
directory keeps what belonged to the proof and not to the product:

| | |
|---|---|
| [`RESULTS.md`](RESULTS.md) | the answers, the measurements, the first full-scale import |
| [`bench/`](bench/) | the benchmarks behind them: the index model at scale (`bench-promotion.sh`, `seed.py`) and today's rsync + repo-add mechanics at the same package count (`bench-current.sh`); `.github/workflows/bench.yml` runs them by hand |
| [`diagrams/`](diagrams/) | the benchmark chart and the transaction lifecycle of the native engine |
| [`crates/pkg-store`](crates/pkg-store) | a native install engine — redb state store plus a journaled, crash-safe filesystem transaction — built and tested, never wired in because the thin client did not need it |
| [`crates/pkg-hooks`](crates/pkg-hooks) | libalpm `.hook` types for the hook preview that is still on the TODO |

The crates stay in the Cargo workspace so CI keeps them compiling; nothing in
`worker/`, `crates/` or the pipeline depends on them.

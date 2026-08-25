# Benchmark methodology

`branchlift benchmark` measures the exact immutable snapshot selected by the user. For each iteration it creates and deletes two destinations:

1. BranchLift's normal strategy: APFS clonefile, Linux reflink, or recursive fallback;
2. a forced non-reflink full copy.

The order alternates on every iteration to reduce first-run and warm-cache bias. Output includes raw samples, clone median/p95, full-copy median, logical bytes, chosen strategy, and median speedup. No result is uploaded.

```bash
branchlift benchmark dev --iterations 10 --json
```

For a repository-independent comparison, generate a deterministic local fixture:

```bash
npm run benchmark:synthetic -- --size-mib 256 --iterations 7
```

Interpretation:

- `apfs-clone` or `linux-reflink` means copy-on-write was actually selected;
- `recursive-copy` is correct isolation but normally has little speed advantage over baseline;
- logical size is not physical disk growth for copy-on-write clones;
- background I/O, filesystem type, Docker Desktop file sharing, and cache state affect results, so publish the JSON plus platform details when comparing machines.

The synthetic command is an implementation proof, not a universal performance claim. Project decisions should use the real snapshot command on the target workstation.

## Linux reflink reproduction

The manual `Linux reflink benchmark` GitHub Actions workflow creates a disposable 3 GiB Btrfs loop filesystem on a public Ubuntu runner, places the entire fixture and temporary copies on that filesystem, and runs the same alternating benchmark. It fails unless the implementation actually reports `linux-reflink`; the JSON artifact includes raw samples, platform details, filesystem output, and methodology. It uses only the free runner and public Actions artifact storage.

For an equivalent local run on Btrfs or reflink-capable XFS:

```bash
npm run benchmark:synthetic -- --size-mib 512 --iterations 7
```

Recorded Linux results are committed under `benchmarks/` after the public workflow completes; workflow artifacts remain the independently reproducible source.

## Real-project lifecycle evidence

The `Real project evidence` workflow runs a matrix against pinned upstream Docmost, n8n Hosting, and Langfuse Compose files. Every job resolves pulled images to immutable digests, then performs snapshot, spawn, HTTP readiness, PostgreSQL golden-state verification, mutation, reset, post-reset readiness/state verification, preview, and destroy. Langfuse additionally exercises ClickHouse, MinIO, and Redis managed volumes. See [EVIDENCE.md](EVIDENCE.md) for the exact contract and results.

## Real-project comparison: Docmost

The Docmost harness compares the complete time until its HTTP application responds:

```bash
npm run benchmark:docmost -- --dataset-mib 128 --iterations 3
```

- Traditional path: new Docker named volumes, PostgreSQL/Redis initialization, Docmost migrations/startup, materialization of the same deterministic SQL dataset, verification, then HTTP readiness.
- BranchLift path: one previously prepared immutable snapshot containing that dataset, copy-on-write state clone, isolated Compose startup, verification, then HTTP readiness.
- Images are pulled once and replaced with their resolved immutable digests before either timed path.
- Sample order alternates to reduce warm-cache bias. The one-time golden snapshot build is intentionally excluded and disclosed in the JSON.
- The harness emits raw samples, medians, speedup, exact upstream commit, image digests, and platform details. It never uploads results.
- It reports two different facts: real snapshot CoW clone versus full filesystem copy, and full end-to-end application readiness. Do not present the first number as the second.

This measures the repeated worktree/agent use case; it does not claim that BranchLift makes a project's first-ever setup faster.

Use `--dataset-mib 0` as a negative control. On the recorded machine, empty Docmost was faster without BranchLift (2.47 s versus 2.94 s median, or 0.84×), because there was no meaningful state preparation to amortize. The final 128 MiB recorded run was also slower end-to-end (3.29 s versus 4.02 s, or 0.82×), even though cloning its 358 MiB real snapshot was 2.51× faster than a full copy (204 ms versus 512 ms). A 512 MiB seed widened the end-to-end gap to 0.59×. The observed cause is Docker Desktop startup overhead for large bind-mounted PostgreSQL state, not CoW clone time. These negative results are retained so optimization work has an honest acceptance target. Raw final evidence is in [`benchmarks/docmost-macos-arm64-2026-08-25.json`](../benchmarks/docmost-macos-arm64-2026-08-25.json).

## Recorded implementation check

On 2026-08-25 the 128 MiB synthetic fixture was run for seven iterations on arm64 macOS 26.5, APFS, Node 26.7.0. BranchLift selected `apfs-clone`:

| Metric | Result |
| --- | ---: |
| Clone median | 15.69 ms |
| Clone p95 | 16.61 ms |
| Forced full-copy median | 89.58 ms |
| Median speedup | 5.71× |

Command: `npm run benchmark:synthetic -- --size-mib 128 --iterations 7`. Raw sample arrays are emitted as JSON by the command; rerun it rather than treating this machine-specific observation as a guarantee.

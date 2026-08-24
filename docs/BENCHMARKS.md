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

## Recorded implementation check

On 2026-08-25 the 128 MiB synthetic fixture was run for seven iterations on arm64 macOS 26.5, APFS, Node 26.7.0. BranchLift selected `apfs-clone`:

| Metric | Result |
| --- | ---: |
| Clone median | 15.69 ms |
| Clone p95 | 16.61 ms |
| Forced full-copy median | 89.58 ms |
| Median speedup | 5.71× |

Command: `npm run benchmark:synthetic -- --size-mib 128 --iterations 7`. Raw sample arrays are emitted as JSON by the command; rerun it rather than treating this machine-specific observation as a guarantee.

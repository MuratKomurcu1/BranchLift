# Real-project evidence

BranchLift's compatibility parser checks five pinned public Compose projects. The stronger lifecycle evidence suite actually runs three representative stacks:

| Project | Stateful/runtime coverage | Verified lifecycle |
| --- | --- | --- |
| Docmost | PostgreSQL, Redis, application volume | snapshot → spawn → HTTP → mutate → reset → HTTP/state restore → destroy |
| n8n Hosting | PostgreSQL, n8n, task runner | snapshot → spawn → HTTP → mutate → reset → HTTP/state restore → destroy |
| Langfuse | PostgreSQL, ClickHouse, MinIO, Redis, web, worker | snapshot → spawn → HTTP → mutate → reset → HTTP/state restore → destroy |

The source commits live in [`evidence/projects.json`](../evidence/projects.json). The harness downloads only those exact upstream files, pulls their referenced images, resolves every image to a repository digest, and commits the generated fixture before invoking BranchLift. No project API key, hosted backend, paid database, or paid CI service is used.

Run one case locally:

```bash
npm run evidence:project -- --project docmost --output evidence-docmost.json
npm run evidence:project -- --project n8n --output evidence-n8n.json
npm run evidence:project -- --project langfuse --output evidence-langfuse.json
```

The manual `Real project evidence` public GitHub Actions workflow runs all three independently on Linux and uploads one machine-readable JSON artifact per project. A job passes only after the application responds both before and after reset, the seeded PostgreSQL row can be mutated, reset restores its original value, Compose reports running services, and cleanup completes.

All three jobs passed in [public Actions run #32797809216](https://github.com/MuratKomurcu1/BranchLift/actions/runs/32797809216) on 2026-08-25. The exact artifacts are committed as [Docmost](../evidence/results/docmost-linux-x64-2026-08-25.json), [n8n Hosting](../evidence/results/n8n-linux-x64-2026-08-25.json), and [Langfuse](../evidence/results/langfuse-linux-x64-2026-08-25.json). Every image reference in those files is resolved to a digest, every HTTP status is 200, and every result is `passed`.

These results are evidence for the pinned versions and Linux runner environment, not a promise that every future upstream version or every database engine is supported.

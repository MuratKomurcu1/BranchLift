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

Committed successful Linux results are stored in [`evidence/results`](../evidence/results) after the public run. They are evidence for these pinned versions, not a promise that every future upstream version or every database engine is supported.

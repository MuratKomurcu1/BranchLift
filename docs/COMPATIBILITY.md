# Compatibility contract

BranchLift tests five real open-source Compose definitions at immutable commits. The online suite downloads only those pinned files, inspects them, generates an override, and verifies either safe compatibility or the exact expected diagnosis.

| Project | Pinned commit | Contract | Why |
| --- | --- | --- | --- |
| Langfuse | `ea3c905cd535` | Compatible | 6 services, 5 cloneable volumes, no blocker |
| n8n Hosting | `6b78193475d8` | Compatible | PostgreSQL and n8n data use managed volumes |
| Docmost | `cd597f0161ab` | Compatible | PostgreSQL, Redis, and application data are managed |
| Twenty | `cbd58da103f3` | Diagnosed | Redis is inferred stateful but has no managed snapshot volume |
| Immich | `8dcfd36fa579` | Diagnosed | Fixed container names, shared database bind state, and non-managed Redis state prevent worktree isolation |

Run the contract:

```bash
npm run test:compat
npm run test:compat -- --json
```

“Diagnosed” is intentional coverage, not claimed support. BranchLift must reject a stack that would share or collide before it creates state. The manifest lives at `compatibility/projects.json`; updating a pin is a reviewed compatibility change.

Database-specific production claims are narrower than generic Compose parsing:

- PostgreSQL 16, Redis 7, and MySQL 8.4 LTS run in the local Docker E2E suite;
- MongoDB 8 and Kafka 3.9 run a real seed → isolated mutation → child commit → reset → re-spawn contract in `test/mongo-kafka-e2e.test.ts`;
- on macOS Docker Desktop, MongoDB/WiredTiger instance state is hydrated into a runtime-native volume and exported back into BranchLift's portable snapshot layout on commit;
- generic managed named volumes are cloned and isolated;
- other databases need a database-aware mutation/reset probe before being described as production-ready.

The local lifecycle supports Docker Compose and explicitly selected Podman Compose. Persistent remote BuildKit remains Docker Buildx-specific. Windows is supported through WSL2 with repositories in its Linux filesystem; native Windows/NTFS is not claimed.

Current non-goals: native Windows, external volumes, host networking, fixed container names, live production-database capture, and VM-grade hostile multi-tenant isolation. `snapshot import` handles stopped-consistent development Compose state. `sandbox run` provides a least-privilege container boundary for agent commands; it does not turn the project Compose stack into a hostile-code VM.

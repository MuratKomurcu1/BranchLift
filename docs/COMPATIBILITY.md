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
- generic managed named volumes are cloned and isolated;
- other databases need a database-aware mutation/reset probe before being described as production-ready.

Current non-goals: Windows, Podman, external volumes, host networking, fixed container names, production data import, and VM-grade hostile multi-tenant isolation. `sandbox run` provides a least-privilege Docker boundary for agent commands; it does not turn the project Compose stack into a hostile-code sandbox.

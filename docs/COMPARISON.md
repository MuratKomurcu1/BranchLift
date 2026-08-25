# BranchLift in the 2026 landscape

Positioning review, last updated August 2026. The goal is honesty, not marketing: this document states what each neighboring category does well, what it does not do, and where BranchLift stands.

## The three layers agents actually need

1. **Session orchestration** — launch N agents on isolated checkouts, watch diffs, merge.
2. **Stateful backend isolation** — give every agent its own seeded database/queue/cache state that can be committed, diffed, and reset.
3. **Execution isolation** — run agent commands inside a bounded security perimeter.

Most teams assemble layer 1 from a GUI tool and improvise layers 2–3 with shell scripts and shared `.env` databases. BranchLift implements layers 2 and 3 as first-class infrastructure and stays deliberately thin on layer 1.

## Category snapshot (August 2026)

| Tool | Type | Stateful backend state | Agent sandbox | Local-first | Notes |
|---|---|---|---|---|---|
| Conductor | Session orchestrator (Mac) | ❌ shared dev DBs at best | ❌ | ✅ | Free, polished; Mac-only, single-player |
| Vibe Kanban | Orchestrator board | ❌ | ❌ | ✅ | Community-maintained after Bloop wound down (2026-04) |
| Claude Squad / Parallel Code / Nimbalyst | Terminal / desktop orchestrators | ❌ | ❌ | ✅ | Worktree + diff UX focus |
| GitHub Codespaces / DevPod / Gitpod | Cloud dev environments | Whole-VM only | VM boundary | ❌ cloud | Heavier, metered, vendor-hosted |
| E2B / Daytona / Modal | Agent sandboxes | Stateless containers/VMs | ✅ strong | ❌ cloud | Built for code execution, no app-state lineage |
| Neon / PlanetScale branching | Cloud DB branching | ✅ Postgres/MySQL only | ❌ | ❌ cloud | Excellent, but tied to their hosted engines |
| **BranchLift** | **State layer for worktree agents** | ✅ any Compose volume: snapshot, commit, semantic diff, reset | ✅ Docker boundary, policy-gated secrets, audit | ✅ local or your own SSH hosts | No account, no hosted service |

## What BranchLift uniquely does

- **Golden-snapshot cloning of real Compose state** — APFS `clonefile` / Btrfs reflink first, safe copy fallback; 19.23× median clone speedup over full copy on the public Linux benchmark.
- **Crash-consistent lifecycle** — snapshots are taken from cleanly stopped services; instances commit mutated state back into immutable child snapshots with content-addressed manifests and semantic diffs.
- **A real sandbox contract** — capabilities dropped, `no-new-privileges`, read-only root, no host Docker socket, loopback-only ports, machine-local policy approval with digest binding, scoped secret injection with log redaction.
- **Your machines as remotes** — strict-host-key SSH workers, exact-commit bundle sync, conflict-refusing one-way live sync, self-healing loopback tunnels, repository-scoped BuildKit builders. No BranchLift-operated service exists to trust or pay.

## Honest gaps

- **No session GUI**: BranchLift's local control plane covers lifecycle, logs, tunnels, and audits, but there is no kanban/diff-review workspace like Conductor or Nimbalyst. Pair BranchLift with whichever orchestrator you already use.
- **Single-player**: team features assume shared Git plus your own remote hosts; there is no built-in multiplayer workspace like AQ.
- **Discovery**: an independent, non-VC project competes for attention against funded launches in a consolidating category (Terragon shut down 2026-01; Crystal deprecated 2026-02). Stars and word-of-mouth are its distribution.

## Recommendation matrix

| If you need… | Use |
|---|---|
| A visual cockpit for parallel agents | Conductor / Nimbalyst / Vibe Kanban |
| Seeded per-branch PostgreSQL that resets in milliseconds | BranchLift |
| Untrusted agent commands without handing over your host | BranchLift sandbox |
| Remote builds/tests on a lab machine you own, via SSH | BranchLift remote workspaces |
| Managed cloud Postgres branches in production | Neon-style DB branching |
| Disposable cloud VMs per task | Codespaces / DevPod / E2B |

BranchLift is designed to sit underneath the orchestrator you already picked, not instead of it.

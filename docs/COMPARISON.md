# BranchLift in the 2026 landscape

Positioning review, last updated August 2026. The goal is honesty, not marketing: this document states what each neighboring category does well, what it does not do, and where BranchLift stands.

## The three layers agents actually need

1. **Session orchestration** — launch N agents on isolated checkouts, watch diffs, merge.
2. **Stateful backend isolation** — give every agent its own seeded database/queue/cache state that can be committed, diffed, and reset.
3. **Execution isolation** — run agent commands inside a bounded security perimeter.

Many teams assemble layer 1 from a GUI tool and improvise layers 2–3 with shell scripts and shared `.env` databases. Coasts is a notable exception: it combines agent workspaces with container runtimes and seeded isolated volumes. BranchLift now includes the core human loop—private prompts, a five-lane Kanban, environment ownership, and bounded Git diff review—while going deeper on versioned, semantically comparable application state.

## Category snapshot (August 2026)

| Tool | Type | Stateful backend state | Agent sandbox | Local-first | Notes |
|---|---|---|---|---|---|
| Conductor | Session orchestrator (Mac) | ❌ shared dev DBs at best | ❌ | ✅ | Free, polished; Mac-only, single-player |
| Vibe Kanban | Orchestrator board | ❌ | ❌ | ✅ | Community-maintained after Bloop wound down (2026-04) |
| Claude Squad / Parallel Code / Nimbalyst | Terminal / desktop orchestrators | ❌ | ❌ | ✅ | Worktree + diff UX focus |
| [Coasts](https://github.com/coast-guard/coasts) | Agent workspace + runtime orchestrator | ✅ isolated/shared/snapshot-seeded volumes | Container / DinD model | ✅ local and self-hosted remote | Broader session/runtime product; secrets, shells, MCP, remote development |
| GitHub Codespaces / DevPod / Gitpod | Cloud dev environments | Whole-VM only | VM boundary | ❌ cloud | Heavier, metered, vendor-hosted |
| E2B / Daytona / Modal | Agent sandboxes | Stateless containers/VMs | ✅ strong | ❌ cloud | Built for code execution, no app-state lineage |
| Neon / PlanetScale branching | Cloud DB branching | ✅ Postgres/MySQL only | ❌ | ❌ cloud | Excellent, but tied to their hosted engines |
| **BranchLift** | **State layer for worktree agents** | ✅ any Compose volume: snapshot, commit, semantic diff, reset | ✅ Docker boundary, policy-gated secrets, audit | ✅ local or your own SSH hosts | No account, no hosted service |

## BranchLift and Coasts, directly

These projects overlap, but their centers of gravity differ. Coasts remains broader in full runtime modes and DinD-oriented development. BranchLift combines a focused **agent workspace**—prompt Kanban, environment ownership, and Git review—with a deeper **state control plane**: stopped-consistent snapshots, parent lineage, content-addressed manifests, environment-to-snapshot commits, semantic diffs, dependency-protected deletion, and deterministic reset.

| Question | Coasts | BranchLift |
|---|---|---|
| What is the primary object? | Agent workspace/runtime | Immutable backend snapshot and isolated branch instance |
| Human task loop | Workspace/session oriented | Five-lane private-prompt Kanban with registered-worktree Git review |
| How is initial state provided? | Shared, isolated, or snapshot-seeded volume strategy | Golden Compose snapshot with APFS/Btrfs/reflink acceleration and copy fallback |
| Can mutated state become a named child with recorded parent and digest? | Not documented in the public contract | Yes |
| Can two backend states be semantically diffed? | Not documented in the public contract | Yes |
| What does reset mean? | Recreate/reseed the runtime volume | Restore the selected immutable snapshot lineage |
| Remote control model | Broader remote development service; DinD/runtime oriented | Strict-host-key SSH allowlist; no BranchLift daemon or arbitrary host shell |
| Remote build cache | Runtime/build support depends on workspace mode | One persistent, repository-scoped BuildKit builder with bounded/prunable cache |
| Team access | Product workspace model | Loopback UI + viewer/operator/admin tokens + secret-free shared registry; no hosted service |
| Best fit | One product to manage agents and their workspaces | Reproducible DB/queue/cache state underneath any agent or orchestrator |

This is not a claim that BranchLift is universally “ahead.” It is a claim that teams whose hard problem is mutable backend state get a deeper, auditable state lifecycle. A team can use Coasts for workspace orchestration and BranchLift as the state layer rather than treating them as mutually exclusive.

## What BranchLift uniquely does

- **Golden-snapshot cloning of real Compose state** — APFS `clonefile` / Btrfs reflink first, safe copy fallback; 19.23× median clone speedup over full copy on the public Linux benchmark.
- **Crash-consistent lifecycle** — snapshots are taken from cleanly stopped services; instances commit mutated state back into immutable child snapshots with content-addressed manifests and semantic diffs.
- **A real sandbox contract** — capabilities dropped, `no-new-privileges`, read-only root, no host Docker socket, loopback-only ports, machine-local policy approval with digest binding, scoped secret injection with log redaction.
- **Your machines as remotes** — strict-host-key SSH workers, exact-commit bundle sync, conflict-refusing one-way live sync, self-healing loopback tunnels, repository-scoped BuildKit builders. No BranchLift-operated service exists to trust or pay.

## Honest gaps

- **No hosted collaboration service**: team access uses loopback UI tokens, SSH tunnels, and an optional shared-filesystem inventory. There are no comments, presence indicators, SSO, or a hosted organization console.
- **No native Windows runtime**: Windows is supported through WSL2; native NTFS worktree and container-volume ownership semantics are not claimed.
- **Podman scope is local**: local lifecycle operations select Podman explicitly, while persistent remote builds still require Docker Buildx.
- **Discovery**: an independent, non-VC project competes for attention against funded launches in a consolidating category. Stars and word-of-mouth are its distribution.

## Recommendation matrix

| If you need… | Use |
|---|---|
| A focused prompt → environment → Git review cockpit | BranchLift |
| A broad session-first desktop cockpit | Conductor / Nimbalyst / Vibe Kanban |
| An all-in-one local agent workspace with seeded volumes | Coasts |
| Seeded per-branch PostgreSQL that resets in milliseconds | BranchLift |
| Untrusted agent commands without handing over your host | BranchLift sandbox |
| Remote builds/tests on a lab machine you own, via SSH | BranchLift remote workspaces |
| Managed cloud Postgres branches in production | Neon-style DB branching |
| Disposable cloud VMs per task | Codespaces / DevPod / E2B |

BranchLift is designed to sit underneath the orchestrator you already picked, not instead of it.

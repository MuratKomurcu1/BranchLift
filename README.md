# BranchLift

**Lift a full backend into every worktree.**

BranchLift gives parallel coding agents isolated, stateful backend environments. Git worktrees separate source files; BranchLift also separates PostgreSQL, Redis, queues, object stores, Docker networks, and published ports.

```text
main snapshot
├── agent/fix-auth      → isolated worktree + PostgreSQL + Redis + ports
├── agent/billing       → isolated worktree + PostgreSQL + Redis + ports
└── agent/migration     → isolated worktree + PostgreSQL + Redis + ports
```

It is local-first, agent-agnostic, and has no hosted service or API key.

## The problem

Running Codex, Claude, Cursor, or another coding agent in separate worktrees only isolates code. Stateful backends still collide:

- migrations modify the same database;
- workers consume another agent's jobs;
- tests flush a shared Redis instance;
- Compose stacks compete for fixed ports and container names;
- every new stack starts empty and repeats slow migrations and seeds.

BranchLift prepares one stopped, immutable golden snapshot and clones its state for each branch. On APFS, Btrfs, and reflink-capable XFS, the clone initially shares disk blocks with the snapshot and only changed blocks consume new space.

## Current status

**v1.1** covers PostgreSQL 16, MySQL 8.4 LTS, and Redis 7 in one real Docker end-to-end contract. It also adds automatic Codex/Claude/Cursor attachment, a local STDIO MCP server, live endpoint previews, and Compose log access. The test creates two environments, mutates both SQL databases in one branch, proves the other branch remains at golden state, resets the changed branch, and verifies both databases again.

Supported today:

- Docker Compose 2.24.4+;
- Git worktrees;
- named-volume discovery and isolation;
- PostgreSQL on macOS Docker Desktop and Linux;
- MySQL 8.4 LTS on macOS Docker Desktop and Linux;
- Redis and generic named volumes;
- APFS clonefile and Linux reflink, with recursive-copy fallback;
- arbitrary agent commands, including `codex` and `claude`;
- multiple merged Compose files, with legacy `compose.file` compatibility;
- immutable snapshot listing and dependency-protected deletion;
- runtime audits and conservative orphan cleanup through `doctor --fix`;
- cross-process snapshot and instance locks with stale-owner diagnosis;
- context-aware host commands through `branchlift exec`;
- crash recovery for abandoned snapshot builds and instance creation;
- attachment to worktrees already created by Codex, Claude, an IDE, or the user;
- idempotent session-start hooks for Codex, Claude Code, and Cursor;
- a local MCP server exposing attach, list, preview, and logs;
- live service/health inspection through `preview` and targeted Compose logs.
- pinned compatibility contracts for Langfuse, n8n Hosting, Docmost, Twenty, and Immich.

MongoDB, Kafka, MinIO, Windows, Podman, and live production imports are not yet claimed as production-ready. Generic named volumes are isolated, but a database-specific production claim requires its own crash-consistency E2E contract.

## Install

Requirements: Node.js 22+, Git, Docker, and Docker Compose 2.24.4+.

```bash
npm install -g branchlift

# or
brew install muratkomurcu/tap/branchlift
```

See [docs/INSTALL.md](docs/INSTALL.md) for requirements, source installation, and package verification.

## Quick start

Run this inside an existing Git repository containing `compose.yaml` or `docker-compose.yml`:

```bash
branchlift init --dry-run
branchlift init
branchlift inspect
```

`init` creates `branchlift.yaml`. Commit that file, then build the golden backend once:

It automatically includes the standard `compose.override.yaml`/`docker-compose.override.yml` companion and copies only `.env`/`.env.local` files that actually exist. Use repeated `--compose` options for non-standard merge stacks.

```bash
branchlift snapshot dev
```

Spawn isolated branches and optionally launch an agent in each one:

```bash
branchlift spawn agent/fix-auth -- codex
branchlift spawn agent/billing -- claude
branchlift list
```

If a tool has already created and checked out a worktree, run this from that worktree instead:

```bash
branchlift attach -- codex
```

Attached worktrees are recorded as externally owned. BranchLift manages their backend state but never removes the worktree itself.

Install automatic session-start attachment and the project-scoped MCP server without replacing existing agent settings:

```bash
branchlift agents install all
git add .codex .claude .cursor .mcp.json
```

Use `codex`, `claude`, or `cursor` instead of `all` to configure only one client. Codex asks you to review and trust a new project hook before its first run.

Inspect exact ports and live Compose service health, then read one service's logs:

```bash
branchlift preview
branchlift logs agent/fix-auth --service postgres --tail 100
```

Run tests, migrations, or another tool inside an existing instance's worktree and environment:

```bash
branchlift exec agent/fix-auth -- npm test
```

Reset an environment to the immutable snapshot:

```bash
branchlift reset agent/fix-auth
```

Clean up runtime state while preserving the Git worktree and branch:

```bash
branchlift destroy agent/fix-auth
```

Remove the worktree too, but only if it is clean:

```bash
branchlift destroy agent/fix-auth --worktree
```

BranchLift never deletes the Git branch.

## Configuration

`branchlift init` generates a minimal file:

```yaml
version: 1
compose:
  files:
    - compose.yaml
  statefulServices:
    - postgres
    - redis
snapshot:
  default: dev
  healthTimeoutSeconds: 120
  seed: []
worktree:
  copyFiles:
    - .env
```

Snapshot seed commands execute inside an already healthy Compose service:

```yaml
snapshot:
  default: dev
  healthTimeoutSeconds: 120
  seed:
    - service: api
      command: ["npm", "run", "db:migrate"]
    - service: api
      command: ["npm", "run", "db:seed"]
```

The snapshot stack is shut down cleanly before its filesystem state is made available for cloning.

Projects that normally use an override can list files in Compose merge order:

```yaml
compose:
  files:
    - compose.yaml
    - compose.dev.yaml
```

The older `compose.file: compose.yaml` form remains readable.

## Commands

```text
  branchlift init [--compose FILE]... [--dry-run] [--json]
branchlift inspect [--json]
branchlift snapshot [create] [NAME]
branchlift snapshot list [--json]
branchlift snapshot delete NAME
branchlift spawn BRANCH [--snapshot NAME] [--no-start] [-- AGENT ...]
branchlift attach [--snapshot NAME] [--no-start] [-- AGENT ...]
branchlift start BRANCH [-- AGENT ...]
branchlift stop BRANCH
branchlift exec BRANCH -- COMMAND ...
branchlift reset BRANCH [--no-start]
branchlift list [--json]
branchlift preview [BRANCH] [--json]
branchlift logs [BRANCH] [--service NAME] [--tail N] [--follow] [--timestamps]
branchlift destroy BRANCH [--worktree]
branchlift doctor [--fix] [--json]
branchlift benchmark [SNAPSHOT] [--iterations N] [--json]
branchlift agents install [all|codex|claude|cursor] [--dry-run] [--json]
branchlift mcp
```

When an agent is launched, BranchLift supplies:

```text
BRANCHLIFT_INSTANCE
BRANCHLIFT_CONTEXT
BRANCHLIFT_WORKTREE
COMPOSE_PROJECT_NAME
BRANCHLIFT_<SERVICE>_<CONTAINER_PORT>_HOST
BRANCHLIFT_<SERVICE>_<CONTAINER_PORT>_PORT
BRANCHLIFT_<SERVICE>_<CONTAINER_PORT>_URL
```

`BRANCHLIFT_CONTEXT` points to JSON containing the assigned host ports and service endpoints. For example, a PostgreSQL service exposing container port 5432 receives `BRANCHLIFT_POSTGRES_5432_PORT`.

`snapshot delete` refuses to remove a snapshot while any instance references it. `doctor` checks snapshot contents, metadata references, worktrees, Compose files, lifecycle locks, runtime status, and Docker resources. `doctor --fix` removes verified stale locks, reconciles abandoned operations, and removes exact BranchLift-labeled orphan resources. Recovered snapshot data is renamed into `.failed-recovered-*` diagnostic state rather than deleted. Git branches, worktrees, and managed database state directories are not silently discarded.

## Safety model

BranchLift inspects Compose before mutating runtime state and refuses configurations that would only appear isolated:

- fixed `container_name` values;
- `network_mode: host`;
- external named volumes;
- detected stateful services without a managed named volume.

Shared writable bind mounts are reported as warnings, or blockers when they belong to a stateful service. `.env` is copied with owner-only permissions when it is absent from the worktree.

Diagnostics include a concrete recommendation for every isolation blocker. Interpolated or absolute bind sources are treated conservatively as shared. Generated overrides replace managed mount targets without deleting unrelated bind, tmpfs, secret, or config mounts from the source project.

Mutating commands acquire owner-stamped filesystem locks. A conflicting command fails instead of racing database copies or Compose teardown. Agent and `exec` child processes run outside lifecycle locks so long-running tools do not prevent intentional runtime control.

Instances created by `spawn` own their generated worktree. Instances created by `attach` mark the current worktree as external. `destroy --worktree` refuses external ownership before stopping or removing anything; plain `destroy` removes only BranchLift runtime state.

BranchLift is environment isolation, **not a security sandbox**. Agents and containers still have whatever host, filesystem, credential, and network access the user gives them. See [SECURITY.md](SECURITY.md).

## Storage behavior

Runtime state lives outside the repository:

```text
~/.branchlift/
├── repos/<repo-id>/snapshots/<name>/volumes/
├── repos/<repo-id>/instances/<branch>/volumes[-<generation>]/
├── repos/<repo-id>/locks/
└── worktrees/<repo-id>/<branch>/
```

Override the root with `BRANCHLIFT_HOME`.

Copy strategy order:

1. macOS APFS clonefile (`cp -c`);
2. Linux reflink (`cp --reflink=always`);
3. safe recursive copy fallback.

Each reset clones into a never-before-mounted volume generation and switches the generated Compose override only after the clone validates. The previous generation is removed after the replacement stack becomes healthy. This avoids Docker Desktop bind-cache races and never exposes a half-copied reset as the active path.

Measure clone latency against a forced full-copy baseline on your machine:

```bash
branchlift benchmark dev --iterations 10
```

For a database-independent fixture use `npm run benchmark:synthetic -- --size-mib 256 --iterations 7`. For the pinned Docmost comparison use `npm run benchmark:docmost -- --dataset-mib 128 --iterations 3`.

The recorded Docmost result is deliberately not presented as a win: its real APFS state clone was 2.51× faster than full copy, but the complete HTTP-ready path was 0.82× because Docker Desktop starts the bind-mounted PostgreSQL state more slowly. Methodology, raw evidence, and the negative controls are in [docs/BENCHMARKS.md](docs/BENCHMARKS.md).

## Development

```bash
npm install
npm run check
npm test

# Requires a running Docker daemon and pulls postgres:16-alpine, mysql:8.4, and redis:7-alpine
npm run test:e2e

# Fetches five pinned public Compose projects
npm run test:compat

# Typecheck, unit tests, audit, and package dry-run
npm run verify
```

See [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and [CONTRIBUTING.md](CONTRIBUTING.md) for the exact support contract.

The architecture is documented in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License and provenance

Apache-2.0. BranchLift is an original implementation. It is informed by the public behavior and product ideas of worktree environment tools and database branching systems, but does not copy their source or claim their work as its own.

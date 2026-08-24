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

This repository is an early **v0.4**. PostgreSQL 16 and Redis 7 are covered by a real Docker end-to-end test that creates two environments, mutates one, proves the other is unchanged, rejects a concurrent lifecycle mutation, executes a context-aware child command, and recovers an abandoned snapshot build without discarding its diagnostic state.

Supported today:

- Docker Compose v2;
- Git worktrees;
- named-volume discovery and isolation;
- PostgreSQL on macOS Docker Desktop and Linux;
- Redis and generic named volumes;
- APFS clonefile and Linux reflink, with recursive-copy fallback;
- arbitrary agent commands, including `codex` and `claude`;
- multiple merged Compose files, with legacy `compose.file` compatibility;
- immutable snapshot listing and dependency-protected deletion;
- runtime audits and conservative orphan cleanup through `doctor --fix`;
- cross-process snapshot and instance locks with stale-owner diagnosis;
- context-aware host commands through `branchlift exec`;
- crash recovery for abandoned snapshot builds and instance creation.

MySQL, MongoDB, Kafka, MinIO, Windows, Podman, and live production imports are not yet claimed as production-ready.

## Install from this checkout

Requirements: Node.js 22+, Git, Docker, and Docker Compose v2.

```bash
npm install
npm run build
npm install -g .

branchlift --version
```

Nothing is published automatically from this repository. A future npm release can use the same package and binary name.

## Quick start

Run this inside an existing Git repository containing `compose.yaml` or `docker-compose.yml`:

```bash
branchlift init
branchlift inspect
```

`init` creates `branchlift.yaml`. Commit that file, then build the golden backend once:

```bash
branchlift snapshot dev
```

Spawn isolated branches and optionally launch an agent in each one:

```bash
branchlift spawn agent/fix-auth -- codex
branchlift spawn agent/billing -- claude
branchlift list
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
branchlift init [--compose FILE]...
branchlift inspect [--json]
branchlift snapshot [create] [NAME]
branchlift snapshot list [--json]
branchlift snapshot delete NAME
branchlift spawn BRANCH [--snapshot NAME] [--no-start] [-- AGENT ...]
branchlift start BRANCH [-- AGENT ...]
branchlift stop BRANCH
branchlift exec BRANCH -- COMMAND ...
branchlift reset BRANCH [--no-start]
branchlift list [--json]
branchlift destroy BRANCH [--worktree]
branchlift doctor [--fix] [--json]
branchlift benchmark [SNAPSHOT] [--iterations N] [--json]
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

Writable bind mounts are reported as warnings because they may share state across branches. `.env` is copied with owner-only permissions when it is absent from the worktree.

Mutating commands acquire owner-stamped filesystem locks. A conflicting command fails instead of racing database copies or Compose teardown. Agent and `exec` child processes run outside lifecycle locks so long-running tools do not prevent intentional runtime control.

BranchLift is environment isolation, **not a security sandbox**. Agents and containers still have whatever host, filesystem, credential, and network access the user gives them. See [SECURITY.md](SECURITY.md).

## Storage behavior

Runtime state lives outside the repository:

```text
~/.branchlift/
├── repos/<repo-id>/snapshots/<name>/volumes/
├── repos/<repo-id>/instances/<branch>/volumes/
├── repos/<repo-id>/locks/
└── worktrees/<repo-id>/<branch>/
```

Override the root with `BRANCHLIFT_HOME`.

Copy strategy order:

1. macOS APFS clonefile (`cp -c`);
2. Linux reflink (`cp --reflink=always`);
3. safe recursive copy fallback.

Measure the actual behavior on your machine:

```bash
branchlift benchmark dev --iterations 10
```

## Development

```bash
npm install
npm run check
npm test

# Requires a running Docker daemon and pulls postgres:16-alpine + redis:7-alpine
npm run test:e2e
```

The architecture is documented in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License and provenance

Apache-2.0. BranchLift is an original implementation. It is informed by the public behavior and product ideas of worktree environment tools and database branching systems, but does not copy their source or claim their work as its own.

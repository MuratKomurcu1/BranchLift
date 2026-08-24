# BranchLift architecture

## Lifecycle

```text
compose.yaml + optional overrides
    │ inspect + validate
    ▼
golden snapshot ── filesystem clone ──► branch instance
    │                                      │
    │ stopped, immutable                   ├── git worktree
    │                                      ├── generated Compose override
    │                                      ├── isolated state directories
    │                                      └── random published host ports
    ▼
reset source for every instance
```

## Compose inspection

The inspector parses a single Compose file directly. For multiple files it asks Docker Compose for the merged project model in the configured order, then records:

- services and image hints;
- named volumes and their container targets;
- bind mounts;
- published container ports;
- stateful services inferred from names and images;
- isolation blockers and warnings.

Source Compose files are never rewritten. BranchLift generates an additional final override using Compose's `!override` tag. Named volumes become host-managed bind mounts and published ports omit a fixed host port so Docker assigns collision-free ports.

PostgreSQL receives a nested `PGDATA` directory. On macOS, initial snapshot bootstrap runs in a temporary Docker-native volume and exports the cleanly stopped data as host-owned files; cloned instances then use the invoking host UID/GID for the container and socket tmpfs. This avoids Docker Desktop bind ownership races while preserving APFS cloning for normal spawn and reset operations. Other platforms bootstrap directly in the host-managed snapshot path and keep the image's declared user.

## Snapshot consistency

Snapshot creation follows this order:

1. create empty managed state directories;
2. start the Compose stack and wait for health;
3. run configured seed commands;
4. stop and remove containers cleanly;
5. mark the snapshot immutable and ready.

Filesystem cloning is never performed from a running database.

## Instance creation

`spawn` creates a Git worktree while `attach` adopts the current registered Git worktree. Both paths clone every snapshot volume, write an override, validate the merged Compose model, start it, and discover actual published ports. Metadata and agent context are written outside the worktree.

Instance metadata records worktree ownership. BranchLift-generated worktrees are `branchlift`; attached worktrees are `external`. Legacy metadata defaults to BranchLift ownership because attachment did not exist in earlier releases. External ownership is checked before any `destroy --worktree` teardown, preventing a partially destructive refusal.

Reset uses volume generations instead of deleting and repopulating an already-mounted bind source. A complete clone and a new override are validated under unique paths, metadata adopts that generation, and the previous generation is removed only after the replacement is healthy. This prevents partial resets and stale bind-path caches from reaching the database process.

## Concurrency control

Every mutating snapshot or instance operation owns an atomic filesystem lock containing its scope, operation, process ID, host, and start time. Instance operations use one lock per branch, so unrelated branches remain parallel. Spawn briefly nests the selected snapshot lock until dependency metadata exists; after that, dependency-protected deletion keeps the immutable source alive without serializing container startup.

Locks are released in `finally` blocks before a requested agent command starts. Same-host locks whose process no longer exists are classified as stale. Foreign-host ownership is never guessed from age because liveness cannot be verified safely. `doctor --fix` rechecks and removes only stale locks.

`branchlift exec` runs a host command in the instance worktree with the context path, Compose project, and normalized service port variables. It does not take a lifecycle lock, allowing test processes and agents to run concurrently with explicit operator controls.

## Copy-on-write

The copy layer prefers native filesystem clones:

- APFS: BSD `cp -cR`;
- Linux Btrfs/XFS: GNU `cp -a --reflink=always`;
- other filesystems: Node recursive copy.

The fallback remains correct but loses the speed and disk-efficiency advantage. `branchlift benchmark` exposes the selected strategy and measured latency.

## Crash behavior

Metadata moves through `creating`, `running`, `stopped`, and `failed` states. Failed snapshots are moved to a diagnostic directory rather than becoming valid immutable snapshots. Failed instances retain metadata so users can inspect and destroy them. A process crash may leave its lock behind, but a later doctor audit can distinguish it from a live owner without guessing from timestamps on the same host.

An ownerless `.building-*` directory is treated as an abandoned snapshot only when no live lock owns that snapshot name. Recovery reacquires the snapshot lock, rechecks metadata, removes exact Compose-labeled Docker resources, marks the build failed, and atomically renames it to `.failed-recovered-*`. Volume contents remain available for diagnosis. A live build is not reported as abandoned.

Likewise, an instance left in `creating` without a live branch lock is moved to `failed`; its worktree and state remain intact. Any lingering Docker resources are handled by the same exact-label cleanup used for other stopped or failed instances.

`branchlift doctor` reconciles metadata with managed files and Docker labels. Cleanup rechecks project ownership immediately before removing exact labeled containers, networks, or volumes. Diagnostic snapshot directories and user worktrees are preserved.

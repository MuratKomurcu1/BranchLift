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
- isolation blockers, warnings, and actionable recommendations.

Source Compose files are never rewritten. BranchLift generates an additional final override. Managed volume targets are replaced through Compose's unique-resource merge rules, preserving unrelated bind, tmpfs, secret, and config mounts. Ports use Compose's `!override` tag and omit fixed host ports so Docker assigns collision-free ports.

PostgreSQL receives a nested `PGDATA` directory. On macOS and Linux, initial snapshot bootstrap runs in a temporary Docker-native volume and exports the cleanly stopped data as host-owned files; cloned instances then use the invoking non-root UID/GID for the container and socket tmpfs. This avoids bind ownership races while preserving APFS/reflink cloning for normal spawn and reset operations.

MySQL uses the same native-volume bootstrap/export path. Both bootstrap and cloned instances use `lower_case_table_names=1`, because that value is valid on case-sensitive and case-insensitive filesystems and the setting must match the initialized data dictionary.

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

`branchlift hook attach` wraps attachment in an idempotent ensure operation. A running instance in the same worktree is reused, a stopped instance is started, and only a missing instance is provisioned. Conflicting worktrees and failed/partial instances require explicit repair rather than being silently replaced.

The repo-local agent installer merges Codex and Claude `SessionStart` hooks, Cursor `sessionStart`, and project MCP configuration without replacing unrelated settings. The STDIO MCP server writes only JSON-RPC to stdout; mutating calls use quiet Compose execution so container progress cannot corrupt the protocol stream.

## Concurrency control

Every mutating snapshot or instance operation owns an atomic filesystem lock containing its scope, operation, process ID, host, and start time. Instance operations use one lock per branch, so unrelated branches remain parallel. Spawn briefly nests the selected snapshot lock until dependency metadata exists; after that, dependency-protected deletion keeps the immutable source alive without serializing container startup.

Locks are released in `finally` blocks before a requested agent command starts. Same-host locks whose process no longer exists are classified as stale. Foreign-host ownership is never guessed from age because liveness cannot be verified safely. `doctor --fix` rechecks and removes only stale locks.

`branchlift exec` runs a host command in the instance worktree with the context path, Compose project, and normalized service port variables. It does not take a lifecycle lock, allowing test processes and agents to run concurrently with explicit operator controls.

## Copy-on-write

The copy layer prefers native filesystem clones:

- APFS: BSD `cp -cR`;
- Linux Btrfs/XFS: GNU `cp -a --reflink=always`;
- other filesystems: Node recursive copy.

The fallback remains correct but loses the speed and disk-efficiency advantage. `branchlift benchmark` alternates clone and forced full-copy order, reports both sample sets, and calculates median speedup.

## Crash behavior

Metadata moves through `creating`, `running`, `stopped`, and `failed` states. Failed snapshots are moved to a diagnostic directory rather than becoming valid immutable snapshots. Failed instances retain metadata so users can inspect and destroy them. A process crash may leave its lock behind, but a later doctor audit can distinguish it from a live owner without guessing from timestamps on the same host.

An ownerless `.building-*` directory is treated as an abandoned snapshot only when no live lock owns that snapshot name. Recovery reacquires the snapshot lock, rechecks metadata, removes exact Compose-labeled Docker resources, marks the build failed, and atomically renames it to `.failed-recovered-*`. Volume contents remain available for diagnosis. A live build is not reported as abandoned.

Likewise, an instance left in `creating` without a live branch lock is moved to `failed`; its worktree and state remain intact. Any lingering Docker resources are handled by the same exact-label cleanup used for other stopped or failed instances.

`branchlift doctor` reconciles metadata with managed files and Docker labels. Cleanup rechecks project ownership immediately before removing exact labeled containers, networks, or volumes. Diagnostic snapshot directories and user worktrees are preserved.

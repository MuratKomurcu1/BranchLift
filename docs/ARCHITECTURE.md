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

PostgreSQL receives a nested `PGDATA` directory. This avoids Docker Desktop's inability to change ownership of the bind-mount root while preserving a cloneable host directory.

## Snapshot consistency

Snapshot creation follows this order:

1. create empty managed state directories;
2. start the Compose stack and wait for health;
3. run configured seed commands;
4. stop and remove containers cleanly;
5. mark the snapshot immutable and ready.

Filesystem cloning is never performed from a running database.

## Instance creation

BranchLift creates the Git worktree, clones every snapshot volume, writes an override, validates the merged Compose model, starts it, and discovers actual published ports. Metadata and agent context are written outside the worktree.

## Copy-on-write

The copy layer prefers native filesystem clones:

- APFS: BSD `cp -cR`;
- Linux Btrfs/XFS: GNU `cp -a --reflink=always`;
- other filesystems: Node recursive copy.

The fallback remains correct but loses the speed and disk-efficiency advantage. `branchlift benchmark` exposes the selected strategy and measured latency.

## Crash behavior

Metadata moves through `creating`, `running`, `stopped`, and `failed` states. Failed snapshots are moved to a diagnostic directory rather than becoming valid immutable snapshots. Failed instances retain metadata so users can inspect and destroy them.

`branchlift doctor` reconciles metadata with managed files and Docker labels. Cleanup rechecks project ownership immediately before removing exact labeled containers, networks, or volumes. Diagnostic snapshot directories and user worktrees are reported but never automatically deleted.

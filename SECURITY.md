# Security policy

## What BranchLift protects

BranchLift prevents accidental runtime collisions between trusted local development tasks. It creates separate Git worktrees, Compose projects, networks, published ports, and managed state directories.

## What BranchLift does not protect

BranchLift is not a sandbox for untrusted code. A process or coding agent launched through BranchLift may still access:

- host files allowed by the operating system;
- credentials already available to the user or copied into the worktree;
- the network and external services;
- the Docker daemon, when exposed to it;
- writable bind mounts declared by the project.

Do not treat worktree isolation as a security boundary.

## Data handling

- Runtime data is stored under `~/.branchlift` or `BRANCHLIFT_HOME`.
- Configured ignored files such as `.env` are copied with mode `0600` when possible.
- BranchLift refuses external named volumes because it cannot safely clone or own them.
- The current release does not pull data from production or anonymize PII.
- Snapshot seed commands are trusted project configuration and execute inside Compose services.

## Destructive operations

- Ready snapshots are immutable.
- `reset` replaces only managed instance-volume contents.
- `destroy` removes only the selected managed runtime directory.
- `doctor --fix` removes only exact BranchLift-labeled Docker resources and verified same-host stale locks.
- Abandoned snapshot recovery preserves volume contents in a `.failed-recovered-*` diagnostic directory.
- Git worktrees are preserved unless `--worktree` is explicit.
- Worktrees registered through `attach` are externally owned and cannot be removed by BranchLift even with `--worktree`.
- A dirty worktree is never removed.
- Git branches are never deleted.

## Reporting a vulnerability

Do not open a public issue for a vulnerability that could expose credentials or delete data. Until a private advisory channel is configured, contact the repository owner privately before disclosure.

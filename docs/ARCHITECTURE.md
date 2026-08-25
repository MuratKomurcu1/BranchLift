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

Source Compose files are never rewritten. BranchLift generates an additional final override. Managed volume targets are replaced through Compose's unique-resource merge rules, preserving unrelated bind, tmpfs, secret, and config mounts. Ports use Compose's `!override` tag, omit fixed host ports so Docker assigns collision-free ports, and explicitly bind the result to IPv4 or IPv6 loopback.

Every managed volume is initialized in temporary Docker-native storage, then exported from its cleanly stopped service as host-owned snapshot files. This preserves the filesystem behavior images expect during bootstrap and prevents image-owned directories (for example Redis data) from blocking snapshot deletion on Linux.

PostgreSQL and MySQL clones run against managed writable binds as the invoking non-root UID/GID. PostgreSQL additionally receives a nested `PGDATA` directory and socket tmpfs. Generic volumes retain the image's declared runtime user; before startup, BranchLift prepares numeric non-root ownership from the created Compose container. During teardown it records the stack's existing images, stops writers, and only then returns managed state ownership to the invoking host user. If a minimal image has no `chown` binary, BranchLift reuses another image from the same stateful stack in an isolated, read-only-root helper container with only the exact managed directory mounted. This keeps MinIO- and ClickHouse-style stacks portable without pulling a privileged helper image or changing arbitrary application container identities.

MySQL bootstrap and cloned instances use `lower_case_table_names=1`, because that value is valid on case-sensitive and case-insensitive filesystems and the setting must match the initialized data dictionary.

## Snapshot consistency

Snapshot creation follows this order:

1. create temporary Docker-native volumes for managed state;
2. start the Compose stack and wait for health;
3. run configured seed commands;
4. stop containers cleanly and export every volume to host-owned files;
5. remove bootstrap containers and volumes;
6. mark the snapshot immutable and ready.

Filesystem cloning is never performed from a running database.

`snapshot import` applies the same consistency boundary to an existing Compose project. It records exactly which services are running, stops only that set, copies each managed path through its stopped service container, and restarts the recorded set before committing the snapshot. A copy or restart failure leaves diagnostic state and never publishes a ready snapshot. Imported PostgreSQL data-directory and MySQL case-sensitivity settings are retained in snapshot metadata so later clones use the source layout.

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

`branchlift gc` first selects only stopped or failed instances older than the requested threshold. Destruction acquires the same per-branch lock and compares status plus `updatedAt` again, so a concurrently restarted or otherwise changed instance is skipped. BranchLift-created worktrees may be removed; externally owned worktrees are never removed by garbage collection.

## Copy-on-write

The copy layer prefers native filesystem clones:

- APFS: BSD `cp -cR`;
- Linux Btrfs/XFS: GNU `cp -a --reflink=always`;
- other filesystems: Node recursive copy.

The fallback remains correct but loses the speed and disk-efficiency advantage. Independent managed volumes are cloned in parallel. `branchlift benchmark` alternates clone and forced full-copy order, reports both sample sets, and calculates median speedup; the repository also contains a free GitHub Actions workflow that verifies the Linux reflink path on a disposable Btrfs filesystem.

## Crash behavior

Metadata moves through `creating`, `running`, `stopped`, and `failed` states. Failed snapshots are moved to a diagnostic directory rather than becoming valid immutable snapshots. Failed instances retain metadata so users can inspect and destroy them. A process crash may leave its lock behind, but a later doctor audit can distinguish it from a live owner without guessing from timestamps on the same host.

An ownerless `.building-*` directory is treated as an abandoned snapshot only when no live lock owns that snapshot name. Recovery reacquires the snapshot lock, rechecks metadata, removes exact Compose-labeled Docker resources, marks the build failed, and atomically renames it to `.failed-recovered-*`. Volume contents remain available for diagnosis. A live build is not reported as abandoned.

Likewise, an instance left in `creating` without a live branch lock is moved to `failed`; its worktree and state remain intact. Any lingering Docker resources are handled by the same exact-label cleanup used for other stopped or failed instances.

`branchlift doctor` reconciles metadata with managed files and Docker labels. Cleanup rechecks project ownership immediately before removing exact labeled containers, networks, or volumes. Diagnostic snapshot directories and user worktrees are preserved.

## Content-addressed state graph

Every new snapshot receives a deterministic SHA-256 manifest covering directories, regular files, symlinks, modes, sizes, volume names, and file content. Older snapshots are indexed lazily without mutating their volume data. A snapshot committed from an instance records its parent and source instance, so state evolves as an inspectable graph rather than a set of anonymous copies. `snapshot diff` compares manifests offline and reports added, removed, modified, unchanged, and shared logical bytes.

Instance commit takes the instance lifecycle lock and target snapshot lock. If the stack is running, writers are stopped before cloning and the previous running state is restored afterward. A failure cannot publish a ready child snapshot and retains diagnostics.

## Command sandbox

The default agent boundary is an ephemeral Docker container. It receives only the selected worktree, a read-only context file, tmpfs-backed `/tmp` and `/run`, explicitly scoped secrets, and the selected network. The runtime drops all Linux capabilities, enables `no-new-privileges`, applies CPU/RAM/PID limits, uses a read-only root filesystem, runs as the invoking UID/GID, and never mounts the host Docker socket. Images must already exist locally.

Backend-only mode creates a short-lived internal Docker network, attaches the running instance's Compose containers with service aliases, starts the sandbox on that network, and detaches/removes the network in `finally`. This removes direct egress from the sandbox while deliberately allowing access to the selected backend. Application containers keep their original networks, so a compromised backend service could still act as a proxy; this is stated as a boundary limitation rather than hidden.

Host mode and `branchlift exec` are convenience execution paths with no security boundary. Both are kept distinct from `sandbox run` in the CLI, UI, posture report, and audit trail.

## Secret broker

Secret definitions contain sources and targets, not values. Values are resolved on demand from the host environment, an owner-selected file, or an explicitly enabled argument-vector command. Scope controls compose, exec, legacy host-agent, and sandbox injection independently. Environment values reject empty, multiline, NUL-containing, and oversized payloads. Sandbox file targets support multiline credentials, are restricted to `/run/secrets/...`, are written beneath private instance state, mounted read-only, and removed with the ephemeral sandbox directory.

Compose env material is stored outside the worktree with mode `0600`; logs are redacted against that material. This protects against accidental commits and cross-user reads, not a malicious process running as the same host user. Environment injection is also visible to sufficiently privileged Docker inspection. Use file targets inside the sandbox when the tool supports them.

## Local and remote control planes

The UI binds only to loopback. A random 256-bit bearer token is placed in the URL fragment, moved to session storage, and never sent in the initial HTTP request or server logs. APIs require the token, reject foreign origins, cap request bodies, and emit no-store, CSP, frame, MIME, opener, resource, and referrer protections. Destructive operations require exact-name confirmation.

With `ui --team-access`, repository-scoped bearer tokens add viewer, operator, and admin roles. Only SHA-256 token digests are persisted; a raw token is returned once. The local session is always admin. Viewer endpoints are read-only, operator actions may create/move tasks and operate non-destructive lifecycle paths, and reset/destroy/remove/prune operations require admin. The server still binds to loopback, so remote team access composes with an authenticated SSH tunnel instead of exposing a public daemon.

The agent workspace stores prompts and task status beneath private repository state, never in Git. Its Git-review endpoint accepts only a registered instance branch, resolves the recorded worktree, verifies that it stays under the repository or BranchLift-managed worktree root, and executes bounded, no-color `git status`, `git diff --stat`, and `git diff` argument vectors. A shared-filesystem registry is optional: every node atomically publishes environment, snapshot, and prompt-free task metadata into its own file, preventing last-writer contention without requiring a hosted database.

SSH remotes use batch authentication, strict host-key checking, timeouts, optional explicit identity files, and no stored passwords or tokens. Lifecycle calls send a size-bounded JSON request over stdin to a hidden worker and accept only a correlated, framed response. The worker allowlists actions and validates every field; it is not an arbitrary remote-shell API. `remote setup` packages the installed BranchLift files locally, transfers them through stdin, installs below the remote user's home directory without `sudo`, verifies the binary, and then performs a protocol ping.

The remote data plane has a separate fixed receiver. Code moves as a SHA-256-verified Git bundle whose `HEAD` must equal the declared commit. Snapshot planning compares SHA-256 blob inventories in bounded batches, after which only missing file bodies cross SSH. The receiver validates paths and symlinks, stores verified content-addressed blobs, materializes a private staging generation, recomputes the manifest, makes state read-only, and atomically publishes it. Existing snapshots are rehashed before a reuse receipt. `remote launch` composes worker bootstrap, code sync, state sync, optional explicit policy approval, and exact-commit spawn; a workspace lock and expected commit/policy digest bind the control-plane steps without a persistent daemon or Docker-in-Docker daemon.

Live working-tree sync is a second, opt-in data contract. The sender enumerates Git tracked plus untracked-nonignored files and hashes a deterministic manifest. A plan request returns only mismatched paths and managed deletions. Apply sends exact framed bodies, then recalculates the plan under the instance lock before atomically replacing individual files. The receiver retains the last managed manifest outside the worktree and rehashes it on every cycle, so remote edits become conflicts. Native recursive watch events provide latency. A scheduled Git inventory plus mode/size/time fingerprint catches missed events without rehashing and contacting SSH when nothing changed; any fingerprint change runs the complete content protocol.

Remote service access uses OpenSSH local forwarding, with the local endpoint on IPv4 loopback, the remote endpoint on recorded IPv4/IPv6 loopback, and a local ControlMaster socket for lifecycle. Server-alive options detect transport loss. While `remote dev` or the standalone tunnel watcher owns the session, a five-second health loop probes every local listener and recreates a failed tunnel set, reserving the previous per-service local ports when possible. The remote agent entry point accepts a bounded command argument vector, validates the synchronized commit and policy, and unconditionally selects the Docker sandbox backend; it does not evaluate a host shell string. Interactive TTY allocation occurs only for a terminal caller.

Remote builds select a deterministic repository-specific Buildx builder using the `docker-container` driver. BuildKit's internal cache remains attached to that named builder across commands. Builder bootstrap, builds, cache inspection, and cache pruning share a repository lock. Successful builds apply a configurable, default-20-GB LRU cache ceiling; full prune addresses the exact builder and requires explicit confirmation. Canonical context and Dockerfile paths must remain within the root checkout or selected instance worktree. This build plane is trusted remote Docker infrastructure and is deliberately separate from the least-privilege agent sandbox.

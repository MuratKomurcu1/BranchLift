# Remote workspaces

BranchLift can bootstrap source code, immutable backend state, and an isolated branch environment on a machine you control with one command. It needs no BranchLift cloud, subscription, daemon, public port, or privileged Docker-in-Docker container. Every control and data transfer is a short-lived SSH session.

## Requirements

- SSH public-key or agent authentication;
- the remote host key already present in `known_hosts`;
- Node.js 22+, npm, Git, Docker, and Docker Compose on the remote host;
- the free Docker Buildx plugin when using remote build/cache (included with Docker Desktop and available as `docker-buildx-plugin` on supported Linux distributions);
- an absolute `--repo` destination that does not exist yet or is a clean Git worktree;
- enough disk space for the selected snapshot and its runtime clone.

Register a machine:

```bash
branchlift remote add lab 192.0.2.10 \
  --user developer \
  --repo /srv/my-project \
  --identity ~/.ssh/lab_ed25519
```

The remote account and host key are the trust boundary. BranchLift never stores an SSH password or private-key contents.

## One-command workflows

Synchronize the current committed source tree and the default immutable snapshot:

```bash
branchlift remote sync lab
branchlift remote sync lab --snapshot seeded
```

Bootstrap, synchronize, and create an exact-commit remote branch environment:

```bash
branchlift remote launch lab agent/fix-auth --snapshot dev
```

Bootstrap the workspace, establish safe working-tree sync, start all TCP tunnels, and keep watching with one command:

```bash
branchlift remote dev lab agent/fix-auth --snapshot dev
```

`remote dev` is idempotent for an existing same-snapshot, same-commit instance: it reuses a running environment or starts a stopped one. It fails closed when the branch points at another commit, uses another snapshot, or contains an out-of-band remote edit. Pressing Ctrl-C stops the local watcher; the remote backend and SSH ControlMaster tunnels remain available until explicitly stopped.

`launch` performs these steps in order:

1. verifies that the same BranchLift version is installed remotely, installing it below the remote user's home directory when necessary;
2. builds a Git bundle for local `HEAD`, hashes it, transfers it over SSH, and checks out exactly that commit remotely;
3. compares snapshot content hashes, transfers only missing file blobs, verifies each SHA-256 digest, reconstructs the immutable snapshot, and verifies the final manifest;
4. binds trust and spawn to that exact commit and local policy digest under a remote workspace lock;
5. creates the requested Git worktree from the transferred commit and starts its isolated Compose backend.

BranchLift does not silently approve executable project policy. If a non-default `branchlift.yaml` has been reviewed and should be trusted on this remote machine, opt in explicitly:

```bash
branchlift remote launch lab agent/fix-auth --snapshot dev --trust-policy
```

Without that flag, the remote policy gate can stop the final spawn while leaving the verified code and snapshot ready for review. `branchlift remote trust lab` is the equivalent separate operation.

## Continuous working-tree sync

After `remote launch`, mirror one change set or continuously reconcile it:

```bash
branchlift remote live-sync lab agent/fix-auth
branchlift remote watch lab agent/fix-auth --interval 2000
```

Live sync is deliberately one-way: the local working tree is authoritative. It includes tracked files plus untracked files that Git does not ignore, while ignored files such as `.env`, caches, and editor state remain local. Add every local-only credential path to `.gitignore` before enabling it.

Each reconciliation creates a deterministic SHA-256 manifest, asks the remote which files differ, and transfers only missing file bodies. The receiver permits regular files and repository-contained symlinks, enforces per-file, total-byte, and file-count caps, applies changes through a staging area, and records the exact last managed manifest outside the worktree. A first sync requires a clean remote worktree. Later syncs rehash the previously managed remote files before changing anything; an edit made by a remote process therefore produces a conflict instead of being overwritten. The two-phase plan is revalidated under the instance lock immediately before apply, and failed applies restore affected files from exact backups.

Native recursive file notifications trigger low-latency sync. Periodic full reconciliation remains active as a correctness fallback when an operating system drops or cannot provide watch events. File-to-directory shape changes are intentionally refused; make that structural change through Git and recreate the remote branch environment.

Do not run a writable remote coding agent and local-authoritative live sync against the same branch at the same time. Use `--read-only-worktree` for test/review agents during local editing, or stop the watcher when the remote agent should own source changes.

## Automatic loopback tunnels

BranchLift reads the instance's discovered TCP ports and opens one OpenSSH local forward for each service:

```bash
branchlift remote tunnel start lab agent/fix-auth
branchlift remote tunnel status lab agent/fix-auth
branchlift remote tunnel watch lab agent/fix-auth
branchlift remote tunnel stop lab agent/fix-auth
```

The local endpoint binds to `127.0.0.1`; the remote target must be the instance's recorded `127.0.0.1` or `::1` loopback address, so no public remote listener is created. Local ports are reserved as a unique set before OpenSSH starts, and `ExitOnForwardFailure` prevents a partial success receipt. Server-alive probes detect a broken SSH transport; a hashed, length-bounded ControlMaster socket controls status and shutdown. `remote dev` and `remote tunnel watch` additionally probe every local listener and recreate the tunnel set when the master or a listener dies. Recovery reuses each service's prior local port whenever it is still available, is audited, and never widens either endpoint. UDP publishing cannot be carried by an SSH TCP forward and is omitted.

## Sandboxed remote agent shell

Run a reviewed shell or a specific agent command inside the existing branch instance:

```bash
branchlift remote shell lab agent/fix-auth --network backend
branchlift remote agent lab agent/fix-auth --network none --read-only-worktree -- npm test
```

The SSH side invokes a fixed BranchLift worker entry point with a size-bounded, allowlisted request. The requested command is never interpolated into a host shell. The remote worker verifies the exact synchronized commit and policy digest, requires machine-local policy approval, forces the Docker sandbox backend, and applies the same dropped capabilities, `no-new-privileges`, read-only root, UID/GID, resource, secret-scope, and network controls as local `sandbox run`. Network defaults to the reviewed sandbox policy unless explicitly overridden on the command line. It never mounts the host Docker socket. `remote shell` means `/bin/sh` inside that sandbox image, not an SSH login shell on the host.

The sandbox image must already be reviewed and available on the remote host. Remote secret values are resolved from that host's configured sources; BranchLift does not copy local secret values over SSH.

## Remote BuildKit and scoped cache

Build either the synchronized root checkout or one live-synced branch worktree:

```bash
branchlift remote build lab --tag my-api:dev --branch agent/fix-auth --cache-max 20gb
branchlift remote build lab --tag my-api:offline --branch agent/fix-auth --network none
branchlift remote cache inspect lab
branchlift remote cache prune lab --confirm prune
```

BranchLift provisions one deterministic `docker-container` Buildx builder per repository and always selects it explicitly. BuildKit's persistent internal cache is therefore reused across builds without a registry, cloud cache, account, or paid service, while other repositories and the default Docker builder remain outside BranchLift cache operations. Creation, build, inspection, and pruning share a repository cache lock. After every successful build, an LRU prune enforces `--cache-max` (default `20gb`) on that builder; a failed best-effort cap never changes a successful image result and is reported as a warning. Manual full cache pruning requires the exact confirmation word and targets only that named builder.

Build context and Dockerfile paths must be relative, exist canonically inside the selected remote worktree, and may not traverse through an escaping symlink. `--network none` removes build-step network access; the default permits normal dependency downloads. The first named-builder bootstrap may pull the public BuildKit image through the remote Docker daemon. Dockerfiles execute inside the trusted remote build infrastructure, not the least-privilege agent sandbox, and must be reviewed accordingly.

## Code sync contract

Base code sync deliberately sends committed Git objects only. Uncommitted, untracked, ignored, and host-only files are excluded and the CLI reports how many dirty paths it omitted. This prevents a convenient bootstrap command from silently uploading `.env` files, credentials, build caches, or editor state. The later opt-in live-sync path has the separate tracked-plus-nonignored contract described above.

The receiver:

- caps a source bundle at 5 GiB and verifies its declared SHA-256 digest;
- runs `git bundle verify` and requires the fetched bundle `HEAD` to equal the declared commit;
- refuses an existing remote checkout with modified or untracked files;
- detects ignored host-only paths that collide with the incoming tree and refuses to replace them;
- checks out a detached exact commit and records it at `refs/branchlift/sync/latest`;
- never rewrites an existing requested branch when it points at another commit.

Git submodule contents and Git LFS objects are not expanded by BranchLift. Provision those through their reviewed Git workflows before depending on them remotely.

## Snapshot data plane

Snapshot files are addressed by SHA-256 content rather than snapshot name. Before upload, the local client asks which hashes already exist in the remote repository's private BranchLift store. A second snapshot containing the same database files can therefore transfer zero data for those files, even when the snapshot name and lineage differ.

The transfer format is not tar extraction or rsync path replay. The receiver validates the manifest, rejects absolute/traversing paths and escaping symlinks, verifies every incoming blob, materializes into a private staging directory, recomputes the complete manifest, makes volume data read-only, and only then atomically publishes the snapshot. An existing snapshot name with a different digest is never overwritten; a same-digest snapshot is fully rehashed before it can satisfy the deduplication fast path.

If an SSH connection is interrupted, rerun the command. Completely verified blobs from the first attempt are discovered by the next plan and skipped; a partial blob is never accepted as reusable content.

Snapshots may contain database credentials, personal data, or production-derived records. `remote sync` and `remote snapshot push` are explicit authorization to copy the selected snapshot to the configured account. BranchLift does not inspect, anonymize, or upload snapshots anywhere else.

## Lifecycle and diagnostics

```bash
branchlift remote doctor lab
branchlift remote instances lab
branchlift remote snapshots lab
branchlift remote preview lab
branchlift remote snapshot push lab dev
branchlift remote spawn lab feature/auth --snapshot dev
branchlift remote stop lab feature/auth
branchlift remote start lab feature/auth
branchlift remote reset lab feature/auth
branchlift remote destroy lab feature/auth
```

The loopback UI exposes sync/launch receipts, one-shot live sync, tunnel management, BuildKit builds, and scoped cache inspection/pruning. It does not expose an arbitrary remote shell, a generic file-transfer endpoint, or own a long-running watcher/TTY; those process-lifetime-sensitive operations remain explicit CLI commands.

Lifecycle and remote-development requests use separate 64-KiB allowlisted protocols. Unknown actions and fields are rejected, destructive operations require exact confirmation, captured UI/worker output is capped at 4 MiB, and setup diagnostics are capped at 1 MiB. Code, state, and live working-tree changes use a dedicated framed binary receiver with bounded headers and correlated receipts.

Code checkout and lifecycle actions share a remote-workspace lock. `remote launch` additionally sends the expected commit and SHA-256 policy digest with trust and spawn requests, so an intervening checkout or policy change fails closed instead of launching a different workspace.

## Why BranchLift does not use DinD

BranchLift runs the synchronized project against the remote host's normal Docker daemon. It does not create a privileged `docker:dind` container, mount a host Docker socket into an agent sandbox, or keep a remotely reachable control service alive. This removes a powerful nested-daemon boundary from the default design and makes the SSH account plus remote Docker installation the explicit trust domain.

This is not a hostile multi-tenant VM boundary. A compromised remote account, Docker daemon, trusted Compose image, or host kernel can still compromise remote workloads and state. Use a dedicated account or disposable VM when stronger isolation is required. See [REMOTE-THREAT-MODEL.md](REMOTE-THREAT-MODEL.md).

## Zero-cost open-source stack

BranchLift does not require or integrate a paid remote-development control plane. It composes tools already available under open-source licenses:

| Layer | Component | License / role |
| --- | --- | --- |
| Transport, authentication, tunnels | [OpenSSH](https://github.com/openssh/openssh-portable/blob/master/LICENCE) | BSD/ISC-family implementation; strict host keys and ControlMaster forwards |
| Source history | [Git](https://github.com/git/git/blob/master/COPYING) | GPL-2.0; exact-commit bundles and worktrees |
| Watch and reconciliation | Node.js `fs.watch` plus BranchLift manifest scans | Built-in runtime API; no sync daemon or SaaS |
| Image build and cache | [Docker Buildx](https://github.com/docker/buildx/blob/master/LICENSE) + [BuildKit](https://github.com/moby/buildkit/blob/master/LICENSE) | Apache-2.0; named builders and persistent local cache |
| Runtime isolation | Linux Docker Engine / Moby and Compose | Self-hosted container runtime already required by BranchLift |
| BranchLift control/data plane | BranchLift | Apache-2.0; original protocols and safety logic in this repository |

BranchLift invokes these installed components through documented interfaces; it does not vendor, disguise, or republish their source as its own. Software cost is zero. A rented VM, electricity, network traffic, or a commercially licensed desktop distribution can still have infrastructure cost; a user-controlled Linux host with Docker Engine avoids any BranchLift-specific subscription.

## Troubleshooting

- `Host key verification failed`: verify the fingerprint out of band, then add it through your normal `known_hosts` workflow.
- `Permission denied`: confirm the selected account, identity file, or SSH agent.
- `Node.js 22+ is required`: install Node through the remote host's trusted package workflow, then retry; sync and launch install BranchLift automatically.
- `Remote repository has uncommitted or untracked files`: preserve or remove those changes yourself; BranchLift will not overwrite them.
- `security policy approval required`: review the synchronized `branchlift.yaml`, then use `remote trust` or rerun launch with `--trust-policy`.
- `snapshot ... already exists with different content`: choose a new immutable snapshot name or deliberately remove the unused remote snapshot first.
- `Remote worktree changed outside live sync`: preserve the remote edit yourself, then either make local and remote content equal or recreate the instance; BranchLift will not choose a winner.
- `Remote branch commit differs from the live-sync base commit`: launch a new branch environment at the current local `HEAD`, or explicitly destroy and recreate the old one.
- `Remote BuildKit requires ... Buildx`: install the open-source Docker Buildx plugin through the remote host's trusted package workflow.
- `has no published TCP ports to tunnel`: use `remote dev --no-tunnel`, or publish an application TCP port through the reviewed Compose definition.

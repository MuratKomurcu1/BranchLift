# Security policy

## Security boundaries

BranchLift has three distinct trust levels:

1. `branchlift sandbox run` executes one command in an ephemeral, least-privilege Docker container.
2. Compose application services use the security settings in the project's reviewed Compose files; BranchLift isolates their state and network names but does not harden arbitrary images.
3. `branchlift exec`, snapshot seed commands, secret command sources, and explicitly enabled host agent commands execute with their normal host or Compose privileges. They are not sandboxes.

Do not infer a stronger boundary from Git worktrees or random ports.

## Sandbox guarantees

For the Docker backend, BranchLift:

- drops all Linux capabilities and enables `no-new-privileges`;
- uses a read-only root filesystem by default;
- applies memory, CPU, and PID limits;
- never mounts `/var/run/docker.sock`;
- runs as the invoking UID/GID when the platform exposes it;
- mounts only the selected worktree and a read-only instance context;
- uses tmpfs for `/tmp` and `/run`;
- supports no-network, backend-only internal network, or explicit outbound network modes;
- refuses implicit image pulls, requiring the operator to review and pull/build the image first;
- removes temporary networks and secret material after execution.

This is a Docker container boundary, not a VM or hostile multi-tenant boundary. Kernel vulnerabilities, Docker daemon compromise, a malicious trusted image, writable worktree access, deliberately scoped credentials, and vulnerabilities in reachable backend services remain in scope for the operator.

Backend-only networking removes a direct default egress path from the sandbox. The selected Compose services retain their original networks; a compromised service could proxy traffic on the sandbox's behalf.

## Secrets

- `branchlift.yaml` stores only source/target policy and may be committed.
- Compose lifecycle/snapshot operations, sandbox execution, secret resolution, and host-agent execution require an exact machine-local configuration-digest approval stored outside the worktree; any configuration change invalidates it. Cleanup operations remain available for recovery.
- Values are resolved only for a requested scope.
- Repository-relative file sources must remain inside the canonical repository and cannot contain symlinks; absolute and `~/` sources are explicit host paths.
- Command extractors and host agent commands are disabled by default.
- Compose env files live outside the repository with mode `0600` and are redacted from BranchLift log output.
- Sandbox secret files are restricted to `/run/secrets/...`, mounted read-only, and removed after the command.
- Audit details whose keys resemble credentials are recursively redacted; secret values are never added intentionally.

Mode `0600` does not protect against another process running as the same host user. Docker environment variables may be visible to principals that can inspect the container. Prefer file injection and short-lived credentials where supported. BranchLift does not fetch production data or anonymize PII.

## Local UI

The UI binds only to `127.0.0.1` or `::1`. It uses a random bearer token carried in the URL fragment, same-origin API checks, strict security headers, no-store responses, bounded JSON bodies, and exact-name confirmations for destructive actions. Anyone able to read the user's browser session, process output, or same-user memory may still obtain the token. Do not expose the port through a reverse proxy or public tunnel.

## SSH remotes

Remote definitions contain host metadata and an optional identity-file path, never passwords or private-key contents. SSH uses batch mode, strict host-key checking, and a connection timeout. Workers accept allowlisted protocols with 64-KiB requests and 4-MiB captured responses; output floods terminate the child process. Remote agent commands are argument arrays forced through the Docker sandbox and never become a host login shell.

`remote setup` intentionally executes a fixed installation script on a machine selected by the operator. It installs below that user's home directory without `sudo`. Review the SSH host key and control the remote account.

`remote sync`, `remote snapshot push`, and `remote launch` explicitly copy the selected committed Git history and snapshot to that account. Dirty, untracked, ignored, and secret-broker files are excluded. Git bundles have a 5-GiB cap, are hashed and verified, and must resolve to the declared exact commit. Existing dirty repositories, colliding ignored host-only paths, and divergent branches are not overwritten. Launch binds remote trust and spawn to the synchronized commit and policy digest under a shared workspace lock.

`remote live-sync`, `remote watch`, and `remote dev` have a different, explicit transfer contract: tracked files and untracked nonignored files are included; ignored files and secret-broker values are not. Live sync is one-way, size bounded, content hashed, symlink/path checked, and two-phase under the instance lock. It verifies the previously managed remote manifest and refuses out-of-band edits rather than overwriting them. Keep every credential and local-only artifact ignored before enabling live sync.

Remote tunnels are TCP-only OpenSSH forwards bound to loopback on both hosts. Remote shell/agent requests verify the exact commit and policy and force the existing least-privilege Docker sandbox. Remote builds validate canonical context paths and run in a dedicated named BuildKit builder per repository. Build cache inspection and exact-confirmation pruning target that builder, not the default or another repository's cache. Dockerfiles and the remote Docker/BuildKit infrastructure remain trusted code outside the agent sandbox boundary.

Snapshot transfer uses SHA-256-addressed blobs. The receiver validates every manifest path and symlink, hashes every incoming blob, reconstructs in a private staging directory, recomputes the complete manifest, and refuses to overwrite a snapshot name with different content. Existing same-digest snapshots are rehashed before reuse. Completed verified blobs can be reused after interruption. Treat the selected snapshot as sensitive data: BranchLift does not anonymize its application contents.

BranchLift opens no public remote listener and creates no Docker-in-Docker daemon. Remote Compose workloads and the named BuildKit builder use the selected host's Docker daemon, which remains inside the operator's remote trust domain. See `docs/REMOTE-THREAT-MODEL.md` for guarantees, residual risks, and non-goals.

## Data integrity and destructive operations

- Ready snapshot volume trees are made host-read-only and remain dependency-protected; runtime clones regain owner-only write access.
- Snapshot files have deterministic manifests and content digests.
- `reset` switches to a fully cloned, validated generation before removing the previous one.
- `destroy` removes only the selected managed runtime directory.
- `doctor --fix` targets exact BranchLift labels and verified same-host stale locks.
- Abandoned snapshot recovery preserves data in a diagnostic directory.
- External and dirty worktrees are never removed; Git branches are never deleted.
- Mutations use owner-stamped per-resource locks and atomic metadata writes.
- `BRANCHLIFT_HOME` is enforced as mode `0700`; metadata, approvals, remotes, logs, and materialized Compose secrets use mode `0600`.

## Reporting a vulnerability

Do not open a public issue for a vulnerability that could expose credentials or delete data. Use GitHub's private vulnerability reporting for the repository when available, or contact the repository owner privately before disclosure. Include the BranchLift version, platform, Docker version, minimal reproduction, impact, and whether credentials or data may have been exposed.

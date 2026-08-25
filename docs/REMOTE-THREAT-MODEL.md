# Remote workspace threat model

## Assets

BranchLift protects the local Git history, selected snapshot contents, SSH identity path, remote repository, remote blob store, machine-local policy approval, and runtime state. Secret values resolved by the local secret broker are not part of remote sync.

## Trust boundaries

The operator trusts the configured SSH host key and remote account. The remote account can read every repository, nonignored working-tree file, and snapshot explicitly transferred to it. The remote Docker daemon, kernel, Compose files, Dockerfiles, BuildKit builder, and images remain outside BranchLift's agent-sandbox guarantee.

The network carries SSH ciphertext only. BranchLift opens no inbound listener, deploys no persistent control daemon, and depends on no BranchLift-operated service. SSH agent forwarding is not enabled by BranchLift.

## Enforced controls

- strict host-key checking, batch authentication, connection timeouts, and validated SSH destinations;
- fixed remote binary commands rather than a user-supplied remote shell command;
- exact-version, user-scoped, sudo-free worker installation;
- committed-only Git bundles with bundle verification, SHA-256 transport integrity, and exact-commit checkout;
- refusal to overwrite a dirty repository, a colliding ignored host-only path, or an existing divergent branch;
- content-addressed snapshot blobs and retry deduplication;
- strict manifest/path/symlink validation, per-blob hashing, full post-materialization and reuse-time verification, read-only publication, and immutable-name collision refusal;
- machine-local configuration-digest approval before configuration-driven execution;
- a shared remote-workspace lock plus exact expected-commit and expected-policy binding for launch;
- one-way live sync with Git-ignore filtering, bounded deterministic manifests, two-phase plan/apply, exact content hashing, instance locking, rollback backups, ignored-path collision refusal, and out-of-band-edit conflict detection;
- OpenSSH ControlMaster forwards bound to loopback at both ends, unique local port reservation, TCP-only selection, and all-or-nothing startup receipts;
- remote agent commands accepted only as bounded argument arrays by a fixed worker entry point and forced through the least-privilege Docker sandbox rather than a host login shell;
- canonical in-worktree build paths, a deterministic per-repository BuildKit builder, and exact-confirmation cache pruning scoped to that builder;
- bounded JSON, header, process-output, setup-output, and bundle sizes;
- no synced secret-broker values, no arbitrary-path upload, no arbitrary host-shell worker command, no Docker-in-Docker daemon, and no agent access to the host Docker socket through BranchLift's sandbox.

## Security review amendments (2026-08)

A full working-tree security review verified the controls above and produced two fixes:

- Sandbox secret corruption fixed: environment-target secrets were written with Compose interpolation escaping (`$$`, `\`) into a file handed to `docker run --env-file`, which reads values verbatim, so values containing `$` or `\` reached sandboxed containers corrupted. The underlying escaping was itself inert because `String.prototype.replace` treats `$$` in a replacement string as a literal `$`. Sandbox runs now receive a verbatim env file (`writePlainSecretEnvFile`), while Compose interpolation files keep correct escaping.
- Git option smuggling hardened: the remote worker accepted `spawn.startPoint` unvalidated and passed it to `git worktree add`, where an option-shaped value such as `--force` would be parsed by Git instead of treated as a revision. Start points are now validated as plain revision tokens at both the worker request boundary and `createWorktree`.

## Residual risks

- The selected snapshot itself can contain sensitive application data. The operator authorizes its transfer explicitly.
- A malicious or compromised remote account can retain plaintext code and snapshot data after receipt.
- A compromised Docker daemon, kernel, Compose image, or reviewed configuration can escape the guarantees of Git and state isolation.
- Traffic size, timing, host address, and SSH account metadata remain visible outside SSH encryption.
- Git LFS and submodule content require separate trusted provisioning.
- Verified blobs consume remote disk until normal BranchLift state is reclaimed; interrupted unverified temporary files are never treated as valid blobs.
- An unignored local file is in live-sync scope even when it is untracked. Incorrect `.gitignore` policy can therefore disclose a local file to the trusted remote account.
- Live sync is not a malicious-filesystem boundary and does not merge changes. A compromised same-account process can race or replace data; BranchLift rechecks and fails closed where detectable.
- SSH tunnels give local processes access to the selected remote services. Those services retain their application authentication and security responsibility.
- The named BuildKit builder is trusted infrastructure controlled by the remote Docker daemon. A malicious Dockerfile, builder image, daemon, or build escape can affect that remote trust domain; `--network none` controls build-step egress but is not a VM boundary.

## Non-goals

BranchLift remote workspaces are not a public multi-tenant cloud, VM isolation layer, production backup system, bidirectional or conflict-merging editor synchronization service, secret replication system, or data anonymizer. Use disposable VMs, disk encryption, separate accounts, network policy, and a production-grade secret manager when those controls are required.

# Sandbox and secrets

## Secure default

BranchLift blocks host agent commands and secret command sources unless the committed project policy enables them. Inspect the effective result before running an untrusted task:

```bash
branchlift security inspect
branchlift secrets doctor
branchlift sandbox inspect
```

Review `branchlift.yaml`, then establish a machine-local trust anchor outside every worktree:

```bash
branchlift security trust
```

The approval contains a SHA-256 digest, never secret values. Any configuration change invalidates it. Compose lifecycle and snapshot commands, sandbox execution, configured secret use, and host-agent execution fail closed until the new configuration is approved. Stop/destroy and other cleanup paths stay available. Use `branchlift security revoke` to remove the approval explicitly.

A secure baseline is:

```yaml
security:
  sandbox:
    backend: docker
    image: my-reviewed-agent:local
    network: backend
    readOnlyRoot: true
    memory: 4g
    cpus: 2
    pidsLimit: 512
  allowHostAgentCommands: false
  allowSecretCommands: false
```

BranchLift checks that the image already exists. Review and build or pull it explicitly; a tag is convenient but a digest-pinned image gives a stronger supply-chain guarantee.

## Network modes

| Mode | Direct egress | Selected backend | Typical use |
|---|---:|---:|---|
| `none` | no | no | offline analysis, formatting, pure unit tests |
| `backend` | no | yes | migrations and integration tests against the branch stack |
| `outbound` | yes | host ports | package installs and external APIs |

`backend` creates a temporary internal network and exposes running services by Compose service name and container port. For example, `postgres:5432` is reachable directly. BranchLift also supplies `BRANCHLIFT_<SERVICE>_<PORT>_HOST`, `_PORT`, and `_URL` variables.

The worktree is writable by default because coding agents need to edit it. Add `--read-only-worktree` for test or inspection commands:

```bash
branchlift sandbox run feature/auth --network none --read-only-worktree -- npm test
```

## Secret sources

Environment source:

```yaml
secrets:
  githubToken:
    source: { env: GITHUB_TOKEN }
    target: { env: GITHUB_TOKEN }
    scopes: [sandbox]
    required: true
```

File source and file target:

```yaml
secrets:
  cloudCredentials:
    source: { file: ~/.config/example/credentials.json }
    target: { file: /run/secrets/cloud-credentials.json }
    scopes: [sandbox]
    required: true
```

Command source, disabled by default:

```yaml
security:
  allowSecretCommands: true
secrets:
  shortToken:
    source: { command: ["pass", "show", "development/api-token"] }
    target: { env: API_TOKEN }
    scopes: [sandbox]
    required: true
```

Commands are argument arrays and never passed through a shell. Enabling them means trusting committed configuration to execute a host binary.

## Scopes

- `sandbox`: the hardened Docker command container;
- `compose`: Compose interpolation and service environment configured by the project;
- `exec`: `branchlift exec`, which is a host process;
- `agent`: legacy `spawn -- AGENT` and `start -- AGENT`, which require host-agent opt-in.

File targets support only `sandbox`, are restricted below `/run/secrets`, and accept multiline content up to 1 MiB. Environment targets reject empty, multiline, NUL-containing, and over-64-KiB values.

Compose-scoped values also apply while creating a golden snapshot or importing an existing Compose project. Those operations use a separate `0600` env file below `BRANCHLIFT_HOME/operations` and remove its entire operation directory in `finally`, whether the snapshot succeeds or fails.

## Exposure model

BranchLift prevents accidental commits by keeping materialized secrets below a mode-`0700` `BRANCHLIFT_HOME`, using owner-only files, redacting explicit Compose logs and persisted lifecycle diagnostics, bounding command output, and removing ephemeral sandbox material. It does not claim protection from the same host user, root, the Docker daemon, or a process deliberately receiving the secret. Environment variables may be visible through Docker inspection. Prefer file injection, least scope, short lifetimes, and development-only credentials.

Relative file sources are repository-scoped: BranchLift rejects traversal, symlinks in any path component, non-regular targets, and canonical paths outside the repository. Use an absolute path or `~/...` when the source is deliberately host-managed.

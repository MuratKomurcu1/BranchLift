# Changelog

## 1.3.0

- Fix Linux cleanup of stateful instances: ownership of managed volume trees is reclaimed through a privileged helper container before deletion, so database entrypoints that reown bind-mounted files (for example MySQL's `#innodb_redo`) no longer cause `EACCES` during destroy or generation replacement.

- Upgrade the control-plane UI with live filtering for environments, snapshots, and audit events, a `/` keyboard shortcut, Escape-to-clear, and click-to-copy endpoint URLs.
- Document BranchLift's position in the August 2026 parallel-agent tool landscape, including an honest gaps assessment, in `docs/COMPARISON.md`, and surface badges plus a capability comparison in the README.
- Fix sandbox secret injection: environment-target secrets are written verbatim for `docker run --env-file` (the previous file reused Compose `$$` escaping, and the escaping itself never applied due to JavaScript replace semantics), while Compose interpolation files escape correctly.
- Harden remote launch: worker `startPoint` values are validated as plain revision tokens at the worker boundary and in `createWorktree`, rejecting Git option-shaped values such as `--force`.
- Add a least-privilege Docker command sandbox with dropped capabilities, `no-new-privileges`, read-only root filesystems, resource limits, no host Docker socket, explicit image review, backend-only networking, and a real Docker isolation contract.
- Add scoped env and read-only secret-file injection, command-source opt-in, private materialization, log redaction, availability diagnostics, and secret-free audit records.
- Add a loopback-only, bearer-token control plane with strict browser headers, live audit events, runtime lifecycle controls, snapshot commit/diff, and SSH worker management.
- Add strict-host-key SSH remotes, an allowlisted framed worker protocol, and sudo-free user-scoped remote worker setup.
- Add one-command remote workspace sync/launch with exact-commit Git bundles, automatic worker bootstrap, SHA-256 transport receipts, content-addressed snapshot blob deduplication, retry reuse, atomic verified reconstruction, explicit remote policy approval, and matching UI controls.
- Harden remote launch with a shared workspace lock, expected commit/policy binding, ignored host-file collision refusal, and full integrity rechecks for reused snapshots.
- Add conflict-detecting one-way live working-tree sync with native watch plus periodic reconciliation, bounded content manifests, two-phase atomic apply, and rollback.
- Add self-healing loopback-only OpenSSH ControlMaster port tunnels, sandbox-forced interactive remote agent sessions, and an idempotent `remote dev` workflow.
- Add canonical-path remote BuildKit builds with one persistent named builder per repository, scoped cache inspection/pruning, CLI streaming, and bounded UI capture.
- Add content-addressed snapshot manifests, lineage metadata, crash-consistent instance-to-snapshot commits, and semantic diffs.
- Expand MCP with security posture, snapshot lineage/diffs, audit events, and sanitized remote inventory.
- Add machine-local approval for every configuration-driven execution path, mode-`0700` state roots, host-read-only snapshots with owner-writable clones, loopback-only randomized ports, bounded subprocess/SSH capture, and symlink-safe private file copying.
- Reject repository-relative secret traversal and symlinks, and enforce the policy gate unconditionally before `exec`.

## 1.2.0

- Add crash-consistent `snapshot import` from an existing Compose project, including exact running-service restoration and imported PostgreSQL/MySQL layout metadata.
- Add race-safe `gc` with age thresholds, dry-run/JSON output, lifecycle-lock rechecks, external-worktree preservation, and reclaimed-byte reporting.
- Parallelize independent volume clones and published-port discovery.
- Add a public Linux Btrfs workflow and retain the 512 MiB raw benchmark where reflink cloning measured 19.23× faster than forced full copy at the median.
- Add digest-pinned, machine-readable Linux lifecycle evidence for Docmost, n8n Hosting, and Langfuse, covering HTTP readiness, PostgreSQL mutation/reset, service health, and strict cleanup.
- Prepare and reclaim numeric non-root bind ownership without changing application container identities or pulling a dedicated privileged helper image.

## 1.1.0

- Add idempotent Codex, Claude Code, and Cursor session-start hooks with non-destructive config merging.
- Add a local STDIO MCP server for attach, list, preview, and logs workflows.
- Add `branchlift preview` with live Compose state/health and `branchlift logs` with service, tail, follow, and timestamp controls.
- Add a pinned, digest-resolved Docmost benchmark with equivalent seeded state, raw samples, negative controls, and separate clone versus end-to-end metrics.
- Add npm/Homebrew release packaging and one-command install documentation.
- Bootstrap every managed volume in Docker-native storage, export host-owned files, and run managed stateful binds under the invoking UID/GID, preventing image-owned state from blocking reset or cleanup on Linux.

## 1.0.0

- Add first-class MySQL 8.4 snapshot, spawn, mutation-isolation, and reset coverage.
- Bootstrap PostgreSQL and MySQL through native Docker volumes on macOS and Linux, then export host-owned immutable state.
- Preserve unrelated Compose mounts while replacing only managed state targets.
- Add actionable Compose recommendations, version checks, safer fallback copies, and automatic standard-override/env discovery.
- Add pinned compatibility contracts for five real open-source projects.
- Compare copy-on-write clone performance with a forced full-copy baseline.
- Add macOS/Linux CI matrices, Linux Docker E2E, npm provenance release automation, install docs, and MySQL examples.

## 0.5.0

- Attach isolated backend state to externally created worktrees.
- Add immutable snapshot deletion protection, lifecycle locks, crash recovery, doctor repair, and context-aware execution.

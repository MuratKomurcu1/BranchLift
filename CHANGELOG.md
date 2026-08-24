# Changelog

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

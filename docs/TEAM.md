# Agent workspace and team access

BranchLift keeps the human task loop beside the stateful environment without introducing a hosted account or database.

## Prompt Kanban and Git review

```bash
branchlift task add "Fix auth race" \
  --prompt "Reproduce the race, implement the smallest safe fix, add regression tests, and summarize the diff" \
  --branch agent/fix-auth \
  --agent codex \
  --status ready

branchlift task list
branchlift task move TASK_ID running
```

The UI exposes Backlog, Ready, Running, Review, and Done lanes. Cards can be dragged or moved with buttons. Prompts live under the private `BRANCHLIFT_HOME` state tree and are not written into the repository. “Diff” is available only when a task names a registered BranchLift branch; review is read-only, argument-vector based, output-bounded, and restricted to the registered worktree.

## Roles

```bash
branchlift team token create alice-review --role viewer
branchlift team token create ci-operator --role operator
branchlift team token list
branchlift ui --team-access
```

| Role | Access |
|---|---|
| viewer | State, logs, events, snapshots, prompts, and bounded Git diffs |
| operator | Viewer access plus task creation/moves, spawn/start/stop, commits, sync, tunnels, and builds |
| admin | Operator access plus reset, destroy, remote removal/trust, cache prune, and task deletion |

The local UI session token is admin. Team token values are returned once; only SHA-256 digests, labels, roles, IDs, and creation times are stored. Revoke with exact confirmation:

```bash
branchlift team token revoke TOKEN_ID --confirm TOKEN_ID
```

The UI never stops being loopback-only. A teammate should establish an authenticated SSH local forward to the machine running BranchLift, open that loopback URL, and use their token. BranchLift does not provide a public listener or relay.

## Shared registry without SaaS

Point each machine at a directory available through NFS, SMB, SSHFS, Syncthing, or another filesystem you control:

```bash
export BRANCHLIFT_TEAM_REGISTRY=/shared/branchlift
branchlift team registry publish
branchlift team registry list
```

Each repository/node pair owns one atomic JSON record, so machines do not overwrite one another. Records contain repository name/key, node hostname, environment status and ports, snapshot summaries, and prompt-free task summaries. They exclude token digests, raw tokens, prompts, secret values, worktree paths, and Compose environment material.

The registry is discovery, not distributed locking. Lifecycle ownership remains on the machine whose node record advertises the environment; use BranchLift’s SSH remote commands to operate it.

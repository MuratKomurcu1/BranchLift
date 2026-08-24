# Contributing

BranchLift changes backend state, so correctness evidence matters more than a container merely starting. Keep pull requests focused and attach platform/filesystem details for copy or database behavior.

Before submitting:

```bash
npm install
npm run check
npm test
npm run test:compat
npm run verify
```

For changes to snapshot, Compose, port, or volume behavior, also run:

```bash
npm run test:e2e
```

The end-to-end test must prove state isolation and reset behavior, not only that containers start.

Compatibility changes must update `compatibility/projects.json` with an immutable commit SHA and a specific expected contract. A diagnosed incompatibility is acceptable; silently accepting shared state is not.

Do not weaken ownership, external-volume, fixed-container, or host-network blockers just to make a project appear compatible. Add a targeted fixture and a safe migration recommendation instead.

Pull requests should include:

- the commands run and their output summary;
- operating system, filesystem, Docker, and Compose versions for E2E changes;
- a regression test for every bug fix;
- no secrets, production snapshots, or unredacted `.env` content.

# Contributing

BranchLift is currently an early implementation. Keep pull requests small and attach evidence for platform-specific behavior.

Before submitting:

```bash
npm install
npm run check
npm test
```

For changes to snapshot, Compose, port, or volume behavior, also run:

```bash
npm run test:e2e
```

The end-to-end test must prove state isolation and reset behavior, not only that containers start.

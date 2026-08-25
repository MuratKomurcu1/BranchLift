# Release procedure

1. Run `npm ci`, `npm run verify`, `npm run test:compat`, and `npm run test:e2e`.
2. Confirm `package.json`, `package-lock.json`, and the CLI report the same version.
3. Inspect `npm pack --dry-run`; no runtime state, env file, fixture database, or credentials may be present.
4. Update user-facing release notes and compatibility pins when needed.
5. Tag the exact reviewed commit as `vX.Y.Z` and publish a GitHub Release.
6. The release workflow repeats verification on Ubuntu, runs Docker E2E, attaches the npm tarball, and publishes to npm through the repository-scoped OIDC trusted publisher. No long-lived npm token is used.
7. Update the Homebrew tap formula with the tarball SHA-256 attached by the release workflow; different npm versions can produce byte-different archives from identical package contents.
8. Install the published registry version in a clean directory and run `branchlift --version` plus `branchlift help`.

Ordinary pushes and pull requests never publish. A failed release job must be fixed with a new version; do not replace an npm artifact.

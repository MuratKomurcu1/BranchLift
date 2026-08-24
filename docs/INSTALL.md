# Installation

## Requirements

- Node.js 22 or newer;
- Git;
- a running Docker daemon;
- Docker Compose 2.24.4 or newer;
- a Git repository whose backend state uses Compose-managed named volumes.

BranchLift is local software. It needs no account, hosted service, API key, or paid dependency.

## Install from a checkout

```bash
cd /path/to/branchlift
npm ci
npm run verify
npm install -g .
branchlift --version
```

Until the repository and first npm release are public, the current checkout is the canonical install source.

## Test the exact package artifact

```bash
npm pack
npm install -g ./branchlift-1.0.0.tgz
branchlift --version
```

This is the closest local equivalent to an npm install and catches missing packaged files.

## npm after the first release

```bash
npm install -g branchlift
```

The release workflow publishes only when a GitHub Release is published. It runs type checks, unit tests, package validation, the Linux Docker E2E suite, and then `npm publish --provenance`. Publishing requires an npm token or trusted-publishing configuration in the repository settings; no release happens from ordinary pushes.

## Project setup

```bash
cd your-project
branchlift init --dry-run
branchlift init
branchlift inspect
branchlift snapshot dev
```

If the project uses non-standard Compose filenames, preserve merge order explicitly:

```bash
branchlift init --compose compose.yaml --compose compose.local.yaml
```

`branchlift doctor --json` is the first diagnostic command to attach to a bug report.

# Installation

## Requirements

- Node.js 22 or newer;
- Git;
- a running Docker daemon;
- Docker Compose 2.24.4 or newer;
- a Git repository whose backend state uses Compose-managed named volumes.

BranchLift is local software. It needs no account, hosted service, API key, or paid dependency.

## Homebrew

```bash
brew tap muratkomurcu/tap
brew trust --formula muratkomurcu/tap/branchlift
brew install branchlift
branchlift --version
```

Homebrew 6 requires explicit trust for non-official tap formulae. The trust command is scoped to BranchLift rather than the entire tap.

## npm

```bash
npm install -g https://github.com/muratkomurcu/BranchLift/releases/download/v1.1.0/branchlift-1.1.0.tgz
branchlift --version
```

This is the published GitHub Release artifact and works without an npm account. Once registry publishing is enabled, `npm install -g branchlift` is the shorter equivalent.

## Install from a checkout

```bash
cd /path/to/branchlift
npm ci
npm run verify
npm install -g .
branchlift --version
```

## Test the exact package artifact

```bash
npm pack
npm install -g ./branchlift-1.1.0.tgz
branchlift --version
```

This is the closest local equivalent to an npm install and catches missing packaged files.

The release workflow runs type checks, unit tests, package validation, the Linux Docker E2E suite, and then publishes with npm provenance. No release happens from ordinary pushes.

## Project setup

```bash
cd your-project
branchlift init --dry-run
branchlift init
branchlift inspect
branchlift snapshot dev
branchlift agents install all
```

If the project uses non-standard Compose filenames, preserve merge order explicitly:

```bash
branchlift init --compose compose.yaml --compose compose.local.yaml
```

`branchlift doctor --json` is the first diagnostic command to attach to a bug report.

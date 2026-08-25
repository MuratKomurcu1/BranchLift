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
brew tap MuratKomurcu1/tap
brew trust --formula MuratKomurcu1/tap/branchlift
brew install branchlift
branchlift --version
```

Homebrew 6 requires explicit trust for non-official tap formulae. The trust command is scoped to BranchLift rather than the entire tap.

## npm

```bash
npm install -g branchlift
branchlift --version
```

The public package is published at [npmjs.com/package/branchlift](https://www.npmjs.com/package/branchlift). Installing a public package does not require an npm account.

To install the immutable GitHub Release artifact without using the npm registry:

```bash
npm install -g https://github.com/MuratKomurcu1/BranchLift/releases/download/v1.2.0/branchlift-1.2.0.tgz
```

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
npm install -g ./branchlift-1.2.0.tgz
branchlift --version
```

This is the closest local equivalent to an npm install and catches missing packaged files.

The release workflow runs type checks, unit tests, package validation, the Linux Docker E2E suite, and then publishes through npm trusted publishing with automatic provenance. No release happens from ordinary pushes.

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

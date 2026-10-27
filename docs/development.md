# Development

[README](../README.md) · [Getting started](getting-started.md) · [Backends](backends.md)

## Build and check

Install dependencies with `bun install --frozen-lockfile`. The repository's normal checks are:

```sh
bun run test
bun run typecheck
bun run check
bun run build
npm pack --dry-run
```

`test` runs the mocked unit suite only. Bare `bun test` also discovers the live e2e suite, so use the package script for routine work. `check` runs Biome without rewriting files. The build produces `dist/index.js`; rebuild and restart the loading OpenCode server after source changes.

The executable commands live in `package.json` and `.github/workflows/ci.yml`. The GitHub workflow runs frozen dependency installation, typecheck, Biome, mocked tests, build and the package dry-run.

## Package contents

The package includes the generated entry point, `server.js`, the authored skill, README, topical guides, example images, license and package metadata. The container-testing runbook and `scripts/` remain source-checkout material. Local `.tmp/`, `.hive/`, credentials and development dependencies aren't published.

The existing package test packs the checkout, extracts it, bundles the entry point into the extracted copy and checks that its skill and linked documentation resolve there. This proves relocation and asset inclusion, not runtime loading of the exact built `dist/index.js` with only production dependencies. The live container runbook covers that separate check.

## Host adapters

One default export serves both hosts. OpenCode 1 calls `server()` and OpenCode 2 calls `setup()`. OpenCode 2 checks the root `server.js` entry before the package's `main`; both entries reach the same build. Neither OpenCode SDK is imported at runtime.

Each host adapter selects the backend once and registers its declared tools. The shared image flow parses arguments, asks permission, resolves the session directory and credential, reads references, generates, checks cancellation and saves the PNG. Provider-specific schemas, model controls and requests belong to the backend.

## Bundled skill

There is one authored skill at `skills/oc-multi-imagegen/SKILL.md`. It teaches image technique; tool arguments and backend limits remain in the tool descriptions and model information.

- OpenCode 1's `config` hook adds the package's absolute `skills/` directory to `skills.paths` once, preserving existing paths and URLs.
- OpenCode 2 registers the skill through its skill transform and leaves an existing skill with the same ID alone.

Neither host gets a copied user-directory file. If OpenCode 1 finds the same skill ID elsewhere, which copy it keeps isn't defined. Missing or malformed packaged skill content fails plugin load. The tools work without loading the skill, and the plugin doesn't request skill permission.

## Live checks

`bun run test:e2e` starts its own OpenCode process and makes real authenticated image calls. It uses account quota. Run the whole file, because later cases reuse earlier outputs. Set `OPENCODE_MODEL` for the agent model or leave it unset for the host default.

For real-agent runs on both hosts, use the [container-testing runbook](https://github.com/imarshallwidjaja/oc-multi-imagegen/blob/main/docs/container-testing.md) from a source checkout. It covers Codex and the OpenAI Images API, not NanoGPT, and is an ad-hoc procedure rather than an automated CI check. It uses disposable credential seeds; never mount or print the host credential store.

Recorded compatibility evidence lives in [Backends](backends.md#compatibility-and-recorded-coverage) and the runbook. Mocked coverage, a build or a successful example doesn't establish live parity across every host, model and backend.

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

Each host adapter selects the backend once and registers its declared tools. Every backend declares an `imagegen` tool without references and an `imageedit` tool that requires them, each with its own strict schema and request. The shared image flow parses arguments, asks permission, resolves the session directory and credential, reads references for a tool that takes them, generates, checks cancellation and saves native bytes with a matching extension, in the formats the tool declares: PNG, JPEG and WebP by default, plus GIF and SVG for the OpenAI Images API's `imagegen`. `file-type` detects the binary formats; `image-size` reads header dimensions without full pixel decoding. `src/svg.ts` parses an SVG strictly with `saxes` and refuses the active and external forms the provider's static-vector contract excludes. The shared lookup flow, used by the OpenAI Images API's `imagegen_models`, parses arguments, asks permission and resolves the credential without a session directory, then returns the provider's answer as text. Provider-specific schemas, model controls and requests belong to the backend.

## Bundled skill

There is one authored skill at `skills/oc-multi-imagegen/SKILL.md`. It teaches image technique; tool arguments and backend limits remain in the tool descriptions and model information.

- OpenCode 1's `config` hook adds the package's absolute `skills/` directory to `skills.paths` once, preserving existing paths and URLs.
- OpenCode 2 registers the skill through its skill transform and leaves an existing skill with the same ID alone.

Neither host gets a copied user-directory file. If OpenCode 1 finds the same skill ID elsewhere, which copy it keeps isn't defined. Missing or malformed packaged skill content fails plugin load. The tools work without loading the skill, and the plugin doesn't request skill permission.

## Live checks

`bun run test:e2e` starts its own OpenCode process and makes real authenticated image calls. It uses account quota. Run the whole file, because later cases reuse earlier outputs. Set `OPENCODE_MODEL` for the agent model or leave it unset for the host default. Each case keeps the host's JSON event output in a temporary directory it prints as `EVIDENCE_DIR`; case C passes only if that output shows a completed `imageedit` call with both earlier images as references.

For real-agent runs on both hosts, use the [container-testing runbook](https://github.com/imarshallwidjaja/oc-multi-imagegen/blob/main/docs/container-testing.md) from a source checkout. It covers Codex and the OpenAI Images API, not NanoGPT, and is an ad-hoc procedure rather than an automated CI check. It uses disposable credential seeds; never mount or print the host credential store.

Recorded compatibility evidence lives in [Backends](backends.md#compatibility-and-recorded-coverage) and the runbook. Mocked coverage, a build or a successful example doesn't establish live parity across every host, model and backend.

### NanoGPT direct-tool matrix

From a source checkout, `bun run test:nanogpt:live --live /absolute/new-evidence-directory` explicitly spends NanoGPT account credit. The runner at `scripts/nanogpt-live.ts` imports the candidate backend and invokes its real shared `tool.run` flow with a minimal host. Permission precedes the existing credential resolver. It uses the namespaced environment key or saved `nano-gpt-images` credential and fails if neither exists. It does not start or restart an OpenCode server.

Before a paid attempt, run `bun run test:nanogpt:live --preflight /absolute/new-preflight-directory`. This deliberately exits 1 after a synthetic transport failure and retains a report plus both deterministic 512px reference PNGs. Confirm that the report records the request and failed phase and that both referenced input paths exist. The mocked unit suite also exercises this collector boundary and missing-credential refusal.

The live matrix runs ten serial requests: generation and two-reference editing for Qwen Image 3 Pro, Seedream's base ID, WAN 2.7 Image Pro and Muse; Seedream's explicit `/edit` route; and WAN `auto` generation. Qwen generation uses `1k` with `aspect_ratio: auto`; Seedream uses `1k`; WAN uses `4k` generation and `2k` editing; Muse uses `1:1`. Each invocation needs a new directory and stops on the first failure without retrying. Preserve the failed report separately before any input correction.

`report.json` retains the Git identity, safe prompts and controls, ordered reference byte counts and hashes, HTTP status, response shape, and each output's actual path, MIME type, dimensions and hash. Keys, authorization headers, signed URLs and full base64 payloads are omitted. Inputs are stored once. Open every output and compare the subject identity from Image 1, the pattern from Image 2 and the requested change; saved headers alone do not establish reference retention. Keep visual findings alongside the report. The runner and local evidence are excluded from the npm package.

## Release to npm

The [publish workflow](https://github.com/imarshallwidjaja/oc-multi-imagegen/blob/main/.github/workflows/publish.yml) runs the normal checks and publishes matching `v*` tags through npm Trusted Publishing. It uses GitHub's OIDC identity rather than an npm publishing secret. Manual **Run workflow** executions run verification only; they don't publish, even when run against a tag.

Configure the npm package's **Settings → Trusted Publisher → GitHub Actions** with user `imarshallwidjaja`, repository `oc-multi-imagegen`, workflow filename `publish.yml`, no environment name, and **Allow npm publish** enabled. The filename must match exactly. npm generates provenance automatically for this public workflow and package.

### Publish a tagged version

Update `package.json` and version-pinning examples, run the checks above, and commit the changes. The tag must equal `v` followed by the package version. For v1.0.0:

```sh
git tag v1.0.0
git push origin main
git push origin v1.0.0
```

Check the **Publish to npm** run in GitHub Actions, then verify the registry version and install it by name in a fresh directory. Later releases must use a new version and matching tag: npm versions are immutable and can't be republished. Verify a new trusted-publisher configuration with a successful publish within two days of creating it, or npm expires it.

### Manual publishing

For a manual release, run the normal checks, including the build, before creating a tarball. Confirm your npm account, then pack:

```sh
npm whoami
npm pack
```

Inspect the file list and test the generated tarball in a separate directory with only production dependencies. Import both `oc-multi-imagegen` and `oc-multi-imagegen/server`, and check that the bundled skill loads without either OpenCode SDK installed.

Publish the exact tarball you verified, using its actual filename:

```sh
npm publish ./oc-multi-imagegen-1.0.0.tgz --access public --browser=false
```

For later releases, update the package version and the tarball filename. npm versions are immutable: the same name and version can't be republished. Browser-based authentication or 2FA approval may still be required; `--browser=false` prints the URL rather than opening a browser on the publishing machine.

After publishing, verify the registry version and install it by name in a fresh directory. Keep the source changes on GitHub consistent with the published package. `ci.yml` checks the project; `publish.yml` releases tagged versions.

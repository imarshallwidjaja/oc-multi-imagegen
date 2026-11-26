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

`test` runs the mocked unit suite only. Bare `bun test` also discovers the live e2e file. The file registers one skipped entry and does nothing else unless `OC_E2E_LIVE` equals `1`, which `bun run test:e2e` sets (see "Live checks"); bare `bun test` can also take that value from your shell or from a `.env` it loads. Use `bun run test` for routine work. `check` runs Biome without rewriting files. The build produces `dist/index.js`; rebuild and restart the loading OpenCode server after source changes.

The executable commands live in `package.json` and `.github/workflows/ci.yml`. The GitHub workflow runs frozen dependency installation, typecheck, Biome, mocked tests, build and the package dry-run.

## Package contents

The package includes the generated entry point, `server.js`, the authored skill, README, topical guides, example images, license and package metadata. The container-testing runbook and `scripts/` remain source-checkout material. Local `.tmp/`, `.hive/`, credentials and development dependencies aren't published.

The package test in `tests/unit/index.test.ts` uses `scripts/stage-package.ts`, which copies the checkout's build and package inputs into a temporary directory: `package.json`, `tsconfig.json`, `src/` and the entries of the manifest's `files` list, as Git sees them (tracked and untracked files that are not ignored, with uncommitted changes). It refuses a symbolic link among them before copying anything, so a link cannot bring an ignored file into the package. It then runs the package's own `build` script on that copy and packs it, so the checkout's `dist/` is never rebuilt, deleted or packed. The test installs the tarball into a consumer project together with its runtime dependency closure, copied from the checkout's `node_modules` so no network is needed, and loads it in a separate Node process. The installed `dist/index.js` and `server.js` must be the staged bytes. Loading the package name, `oc-multi-imagegen/server` and the `main` file must give the same module with both host entry points; OpenCode 1's config hook must add the installed `skills/` directory; neither OpenCode SDK may resolve from the installed package's main module, whether from the package's own `node_modules` or a directory above it; and the README's local links must resolve in the installed copy. The test then places a synthetic SDK inside the installed package to show that the SDK check reports it. The test does not install dependencies from the registry or start OpenCode. The container runbook covers both: its `pack` uses the same staging, then installs the runtime dependencies with `npm install --omit=dev`.

## Host adapters

One default export serves both hosts. OpenCode 1 calls `server()` and OpenCode 2 calls `setup()`. OpenCode 2 checks the root `server.js` entry before the package's `main`; both entries reach the same build. Neither OpenCode SDK is imported at runtime.

Each host adapter selects its backends when the plugin loads and registers their declared tools. OpenCode 1 runs one backend, chosen by `OC_MULTI_IMAGEGEN_BACKEND`, and takes no plugin options. OpenCode 2 runs the backends its `backend` or `backends` plugin options select, or the variable's one backend, and registers the tools in the `image` Code Mode namespace, with one sub-namespace per backend when there are several. Every backend declares an `imagegen` tool without references and an `imageedit` tool that requires them, each with its own strict schema and request. The `opencode` backend has no credential of its own: it calls OpenCode 2's image generation and model catalog, and the OpenCode 2 adapter fails the load when the host lacks them.

The shared image flow parses arguments, asks permission, resolves the session directory and credential, reads references for a tool that takes them (local files, or HTTPS URLs after a `webfetch` permission for each hop) and an optional mask, generates, checks cancellation and saves native bytes with a matching extension, in the formats the tool declares: PNG, JPEG and WebP by default, plus GIF and SVG for the OpenAI Images API's `imagegen`. When a call asks for `preview`, the flow returns the saved bytes, and only the OpenCode 2 adapter attaches them to the response. `file-type` detects the binary formats; `image-size` reads header dimensions without full pixel decoding. `src/svg.ts` parses an SVG strictly with `saxes` and refuses the active and external forms the provider's static-vector contract excludes. The shared lookup flow, used by the `imagegen_models` of the OpenAI Images API and the `opencode` backend, parses arguments, asks permission and resolves the credential without a session directory, then returns the provider's answer as text. Provider-specific schemas, model controls and requests belong to the backend.

## Bundled skill

There is one authored skill at `skills/oc-multi-imagegen/SKILL.md`. It teaches image technique; tool arguments and backend limits remain in the tool descriptions, their argument descriptions and model information.

- OpenCode 1's `config` hook adds the package's absolute `skills/` directory to `skills.paths` once, preserving existing paths and URLs.
- OpenCode 2 registers the skill through its skill transform and leaves an existing skill with the same ID alone.

Neither host gets a copied user-directory file. If OpenCode 1 finds the same skill ID elsewhere, which copy it keeps isn't defined. Missing or malformed packaged skill content fails plugin load. The tools work without loading the skill, and the plugin doesn't request skill permission.

## Live checks

`bun run test:e2e` runs `tests/e2e/imagegen.test.ts` with `OC_E2E_LIVE=1`, the file's opt-in. It starts the `opencode` on your `PATH` with your OpenCode sign-in and makes real authenticated image calls through the Codex backend, so it uses account quota. When `OC_E2E_LIVE` is not `1`, the file stages nothing, creates no directory and starts no OpenCode process.

The file is one journey, so run it whole. Stage A saves `character.png`. Stage B asks for the same path and must get the versioned `character-v2.png`, and stage C composes both with an edit. Stage D, a transparent sticker, stands alone. Each stage checks its prerequisites first: when A did not pass, B and C fail with "not run" before they start OpenCode, and D still runs. Export `OPENCODE_MODEL` in the invoking shell for the agent model, or leave it unset for the host default. The test process disables automatic `.env` loading.

Before the first stage, the run builds and packs a staged copy of the checkout with `scripts/stage-package.ts` (see "Package contents"), installs the tarball with its runtime dependencies under one temporary directory, and points a temporary OpenCode config at that copy. Your checkout's `dist/` is not rebuilt. OpenCode gets your environment, including `PATH`, `HOME` and `OPENCODE_AUTH_CONTENT`, without `OPENCODE` and the variables whose names start with `OPENCODE_` (apart from `OPENCODE_AUTH_CONTENT`), `OC_MULTI_IMAGEGEN_` or `OC_E2E_`. `XDG_CONFIG_HOME` is replaced by the temporary config directory and `OC_MULTI_IMAGEGEN_BACKEND` is set to `codex`; the config selects no autoupdate. A run that passes 10 minutes gets SIGTERM and, 10 seconds later, SIGKILL; the test reports that as a timeout, and any other exit status or signal as itself. The run prints the work directory, the config directory and `EVIDENCE_DIR`, which keeps each stage's JSON event output, and leaves them for review. Stage C passes only if that output shows a completed `imageedit` call with both earlier images as references.

For real-agent runs on both hosts, use the [container-testing runbook](https://github.com/imarshallwidjaja/oc-multi-imagegen/blob/main/docs/container-testing.md) from a source checkout. It covers Codex and the OpenAI Images API, not NanoGPT or the `opencode` backend, and is an ad-hoc procedure rather than an automated CI check. It uses disposable credential seeds; never mount or print the host credential store.

Recorded compatibility evidence lives in [Backends](backends.md#compatibility-and-recorded-coverage) and the runbook. Mocked coverage, a build or a successful example doesn't establish live parity across every host, model and backend.

### NanoGPT direct-tool matrix

From a source checkout, `bun run test:nanogpt:live --live /absolute/new-evidence-directory` explicitly spends NanoGPT account credit. The runner at `scripts/nanogpt-live.ts` imports the candidate backend and invokes its real shared `tool.run` flow with a minimal host. Permission precedes the existing credential resolver. It uses the namespaced environment key or saved `nano-gpt-images` credential and fails if neither exists. It does not start or restart an OpenCode server.

Before a paid attempt, run `bun run test:nanogpt:live --preflight /absolute/new-preflight-directory`. The preflight reads no credential and sends nothing over the network. It runs the first two cases of the matrix, Qwen generation and Qwen editing, through the same `tool.run` flow and collectors as a live run. The generation gets a synthetic response that holds the subject fixture, so the request, response and output collectors all run and `1-generate.png` is saved. The edit's transport fails on purpose once its request and both references are recorded, and the run stops there, as a live run stops at its first failure. It exits 1 and its last line is `1-edit: failed after request-recorded (controlled-transport-failure); evidence: <report path>`. Confirm that `report.json` shows `1-generate` at `output-saved`, `1-edit` at `request-recorded` with two references whose hashes match `subject.png` and `pattern.png` in that order, and that both fixtures are in the directory. `tests/unit/nanogpt-live.test.ts` runs the same preflight and checks that report, and checks the missing-credential refusal, each in a temporary directory.

Each case in `report.json` records `lastCompleted`, the last boundary the runner observed: `started`, `permission-granted`, `credential-resolved`, `request-recorded`, `response-recorded` or `output-saved`. A failed case also records `failure`: `missing-credential`, `controlled-transport-failure`, `unexpected-request` (a preflight request other than the image request) or `error`, whose provider or runtime message is not recorded because it can hold signed URLs or payloads.

The live matrix runs ten serial requests: generation and two-reference editing for Qwen Image 3 Pro, Seedream's base ID, WAN 2.7 Image Pro and Muse; Seedream's explicit `/edit` route; and WAN `auto` generation. Qwen generation uses `1k` with `aspect_ratio: auto`; Seedream uses `1k`; WAN uses `4k` generation and `2k` editing; Muse uses `1:1`. Each invocation needs a new directory and stops on the first failure without retrying. Preserve the failed report separately before any input correction.

`report.json` retains the Git identity, safe prompts and controls, ordered reference byte counts and hashes, HTTP status, response shape, and each output's actual path, MIME type, dimensions and hash. Keys, authorization headers, signed URLs and full base64 payloads are omitted. Inputs are stored once. Open every output and compare the subject identity from Image 1, the pattern from Image 2 and the requested change; saved headers alone do not establish reference retention. Keep visual findings alongside the report. The runner and local evidence are excluded from the npm package.

## Release to npm

The [publish workflow](https://github.com/imarshallwidjaja/oc-multi-imagegen/blob/main/.github/workflows/publish.yml) runs the normal checks and publishes matching `v*` tags through npm Trusted Publishing. It uses GitHub's OIDC identity rather than an npm publishing secret. Manual **Run workflow** executions run verification only; they don't publish, even when run against a tag.

Configure the npm package's **Settings → Trusted Publisher → GitHub Actions** with user `imarshallwidjaja`, repository `oc-multi-imagegen`, workflow filename `publish.yml`, no environment name, and **Allow npm publish** enabled. The filename must match exactly. npm generates provenance automatically for this public workflow and package.

### Publish a tagged version

Update `package.json` and version-pinning examples, run the checks above, and commit the changes. The tag must equal `v` followed by the package version. For v3.0.0:

```sh
git tag v3.0.0
git push origin main
git push origin v3.0.0
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
npm publish ./oc-multi-imagegen-3.0.0.tgz --access public --browser=false
```

For later releases, update the package version and the tarball filename. npm versions are immutable: the same name and version can't be republished. Browser-based authentication or 2FA approval may still be required; `--browser=false` prints the URL rather than opening a browser on the publishing machine.

After publishing, verify the registry version and install it by name in a fresh directory. Keep the source changes on GitHub consistent with the published package. `ci.yml` checks the project; `publish.yml` releases tagged versions.

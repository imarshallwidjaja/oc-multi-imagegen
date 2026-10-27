# Agent instructions

## Progressive discovery

- Read `AGENTS.md` from the repository root inward to the files in scope. A closer file refines its parent; name any override explicitly.
- Before changing plugin behavior, read `src/AGENTS.md`. Before changing unit tests, read `tests/unit/AGENTS.md`.
- Keep verified, decision-changing rules at their narrowest true scope. Add nested instructions to existing directories only when they have distinct local rules; keep command inventories in their executable configuration.

## Working here

- Use `bun run test` for routine mocked tests. Bare `bun test` also discovers the live e2e suite. Run `bun run test:e2e` only when live generation and account-quota use are in scope, and run the whole file: later cases reuse earlier outputs.
- OpenCode 1 and OpenCode 2 both load generated `dist/index.js` (OpenCode 2 through the root `server.js`). Edit `src/`, then `bun run build` and reload the OpenCode process that loaded the plugin. The e2e harness builds and starts its own OpenCode 1 process.
- Use the npm package for normal installation and a local checkout for development; follow `docs/getting-started.md` for setup and `docs/development.md` for development checks. `package.json` and `.github/workflows/ci.yml` own the executable commands.
- For a qualitative run with real agents on OpenCode 1 and 2, follow `docs/container-testing.md`. It uses account quota and a disposable credential seed: run it only when asked, and never mount or print the host's OpenCode credential store. Use a new `init` sandbox per attempt and run hosts and cases one after another, never in parallel or in the background. The OpenAI Images API key reaches a sandbox only when `OC_IMAGE_KEY_ENV_FILE` names a dotenv file for `seed`, which hands it to that host's containers as `OC_MULTI_IMAGEGEN_OPENAI_API_KEY`; never read, print or copy that file's contents, and never make the plugin read a dotenv file. The plugin's settings are `OC_MULTI_IMAGEGEN_BACKEND`, `OC_MULTI_IMAGEGEN_OPENAI_API_KEY` and `OC_MULTI_IMAGEGEN_NANOGPT_API_KEY` in the environment of the OpenCode process, not plugin options.
- Ignored `.tmp/` material may include an upstream checkout. Treat it as reference data; this checkout's source and configuration govern tool names and workflows.

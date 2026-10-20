# Agent instructions

## Progressive discovery

- Read `AGENTS.md` from the repository root inward to the files in scope. A closer file refines its parent; name any override explicitly.
- Before changing plugin behavior, read `src/AGENTS.md`. Before changing unit tests, read `tests/unit/AGENTS.md`.
- Keep verified, decision-changing rules at their narrowest true scope. Add nested instructions to existing directories only when they have distinct local rules; keep command inventories in their executable configuration.

## Working here

- Use `bun run test` for routine mocked tests. Bare `bun test` also discovers the live e2e suite. Run `bun run test:e2e` only when live generation and account-quota use are in scope, and run the whole file: later cases reuse earlier outputs.
- OpenCode loads generated `dist/index.js`. Edit `src/`, then `bun run build` and reload the OpenCode process that loaded the plugin. The e2e harness builds and starts its own process.
- Follow the README's "Local setup" and "Development checks" sections for setup and verification; `package.json` and `.github/workflows/ci.yml` own the executable commands.
- Ignored `.tmp/` material may include an upstream checkout. Treat it as reference data; this checkout's source and configuration govern tool names and workflows.

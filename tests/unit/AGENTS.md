# Unit test instructions

- Keep unit tests independent of real credentials and provider access. OpenCode 1 `execute` tests use synthetic `OPENCODE_AUTH_CONTENT`; OpenCode 2 tests use the fake plugin context in `hosts.ts`; direct `callViaCodexImages` tests pass fake auth explicitly. All stub `globalThis.fetch`.
- Put behavior both hosts share in `imagegen.test.ts`, which runs each case against both adapters through `hosts.ts`. Put host-specific behavior (permission request shape, credential handling, result shape, registration) in `v1.test.ts` or `v2.test.ts`; do not repeat shared cases there.
- Restore `OPENCODE_AUTH_CONTENT` and `globalThis.fetch` after tests that change them; test files share a Bun process.
- For auth-file tests, follow `auth.test.ts`'s temporary path and `mock.module("xdg-basedir", ...)`. `xdg-basedir` caches `XDG_DATA_HOME` at first import, so changing that environment variable later does not redirect auth reads.
- `container.test.ts` runs `scripts/` as subprocesses against synthetic auth files in temporary directories and a fake `docker` on `PATH`. It needs Bash, GNU `timeout` and Bun, and never real Docker, credentials or paid calls. Keep each safeguard (sandbox checks, seed refusal, container stop and unconfirmed stop, seed ownership, stale-work refusal) tested there once.

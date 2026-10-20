# Unit test instructions

- Keep unit tests independent of real credentials and provider access: `execute` tests use synthetic `OPENCODE_AUTH_CONTENT`; direct `callViaCodexImages` tests pass fake auth explicitly. Both stub `globalThis.fetch`.
- Restore `OPENCODE_AUTH_CONTENT` and `globalThis.fetch` after tests that change them; test files share a Bun process.
- For auth-file tests, follow `auth.test.ts`'s temporary path and `mock.module("xdg-basedir", ...)`. `xdg-basedir` caches `XDG_DATA_HOME` at first import, so changing that environment variable later does not redirect auth reads.

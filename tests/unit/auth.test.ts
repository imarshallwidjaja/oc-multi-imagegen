import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const XDG = mkdtempSync(path.join(os.tmpdir(), "auth-xdg-"))
const AUTH_FILE = path.join(XDG, "opencode", "auth.json")
mkdirSync(path.dirname(AUTH_FILE), { recursive: true })

// Capture so this file's env edits don't leak into other test files sharing the bun test process.
const ORIGINAL_AUTH_CONTENT = process.env.OPENCODE_AUTH_CONTENT
let loadStoredCredential: typeof import("../../src/auth").loadStoredCredential

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

beforeAll(async () => {
  // xdg-basedir reads XDG_DATA_HOME only once, when it is first imported, and another test file
  // may import it before this one. mock.module also replaces the module for files that already
  // imported it, so auth.json is read from the temp dir regardless of the test file order.
  mock.module("xdg-basedir", () => ({ xdgData: XDG }))
  loadStoredCredential = (await import("../../src/auth")).loadStoredCredential
})

afterAll(() => {
  restoreEnv("OPENCODE_AUTH_CONTENT", ORIGINAL_AUTH_CONTENT)
  rmSync(XDG, { recursive: true, force: true })
})

function writeAuthFile(content: string): void {
  writeFileSync(AUTH_FILE, content)
}

beforeEach(() => {
  delete process.env.OPENCODE_AUTH_CONTENT
  // Start each test from a no-credentials baseline; tests opt in to a file.
  writeAuthFile("{}")
})

afterEach(() => {
  delete process.env.OPENCODE_AUTH_CONTENT
})

const OAUTH = { type: "oauth", provider: "openai", label: "OpenAI ChatGPT OAuth" } as const
const KEY = { type: "key", provider: "openai-images", label: "OpenAI Images API" } as const

describe("loadStoredCredential", () => {
  test("reads a valid oauth entry from OPENCODE_AUTH_CONTENT", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      openai: { type: "oauth", access: "tok-env", refresh: "r", expires: 1, accountId: "acct-1" },
    })
    expect(await loadStoredCredential(OAUTH)).toEqual({ type: "oauth", access: "tok-env", accountId: "acct-1" })
  })

  test("reads a key saved as an api entry and ignores its metadata", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      "openai-images": { type: "api", key: "sk-images", metadata: { note: "x" } },
    })
    expect(await loadStoredCredential(KEY)).toEqual({ type: "key", key: "sk-images" })
  })

  test("prefers OPENCODE_AUTH_CONTENT over the auth.json file", async () => {
    writeAuthFile(JSON.stringify({ openai: { type: "oauth", access: "tok-file" } }))
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ openai: { type: "oauth", access: "tok-env" } })
    expect(await loadStoredCredential(OAUTH)).toEqual({ type: "oauth", access: "tok-env" })
  })

  test("falls back to the auth.json file when the env var is unset", async () => {
    writeAuthFile(JSON.stringify({ "openai-images": { type: "api", key: "sk-file" } }))
    expect(await loadStoredCredential(KEY)).toEqual({ type: "key", key: "sk-file" })
  })

  test("falls back to the auth.json file when OPENCODE_AUTH_CONTENT does not parse, as OpenCode does", async () => {
    writeAuthFile(JSON.stringify({ "openai-images": { type: "api", key: "sk-file" } }))
    process.env.OPENCODE_AUTH_CONTENT = "{not json sk-secret-in-the-text"
    expect(await loadStoredCredential(KEY)).toEqual({ type: "key", key: "sk-file" })
  })

  test("reads only the entry the backend names", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      openai: { type: "oauth", access: "tok" },
      "openai-images": { type: "api", key: "sk-images" },
    })
    expect(await loadStoredCredential(OAUTH)).toEqual({ type: "oauth", access: "tok" })
    expect(await loadStoredCredential(KEY)).toEqual({ type: "key", key: "sk-images" })
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ openai: { type: "oauth", access: "tok" } })
    expect(await loadStoredCredential(KEY)).toBeUndefined()
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ openai: { type: "api", key: "sk-chat" } })
    expect(await loadStoredCredential(KEY)).toBeUndefined()
  })

  test.each([
    ["an api entry where oauth is needed", OAUTH, { openai: { type: "api", key: "sk" } }],
    ["an oauth entry where a key is needed", KEY, { "openai-images": { type: "oauth", access: "tok" } }],
    ["an oauth entry whose access is not a string", OAUTH, { openai: { type: "oauth", access: 123 } }],
    ["a key that is empty", KEY, { "openai-images": { type: "api", key: "" } }],
    ["a key that is not a string", KEY, { "openai-images": { type: "api", key: 7 } }],
    ["an entry that is not an object", KEY, { "openai-images": "sk-images" }],
    ["no entry for the provider", OAUTH, { anthropic: { type: "oauth", access: "tok" } }],
    ["content that is not an object", OAUTH, ["openai"]],
  ])("returns undefined for %s", async (_name, spec, content) => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(content)
    expect(await loadStoredCredential(spec)).toBeUndefined()
  })

  test("returns undefined, without an error, when neither source holds usable JSON", async () => {
    process.env.OPENCODE_AUTH_CONTENT = "{not json"
    writeAuthFile("{also not json")
    expect(await loadStoredCredential(KEY)).toBeUndefined()
  })

  test("returns undefined when the auth.json file is missing", async () => {
    rmSync(AUTH_FILE, { force: true })
    expect(await loadStoredCredential(OAUTH)).toBeUndefined()
  })
})

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const XDG = mkdtempSync(path.join(os.tmpdir(), "auth-xdg-"))
const AUTH_FILE = path.join(XDG, "opencode", "auth.json")
mkdirSync(path.dirname(AUTH_FILE), { recursive: true })

// Capture so this file's env edits don't leak into other test files sharing the bun test process.
const ORIGINAL_AUTH_CONTENT = process.env.OPENCODE_AUTH_CONTENT
let loadOpenAIAuth: typeof import("../../src/auth").loadOpenAIAuth

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
  loadOpenAIAuth = (await import("../../src/auth")).loadOpenAIAuth
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

describe("loadOpenAIAuth", () => {
  test("reads a valid oauth entry from OPENCODE_AUTH_CONTENT", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      openai: { type: "oauth", access: "tok-env", accountId: "acct-1" },
    })
    expect(await loadOpenAIAuth()).toEqual({ type: "oauth", access: "tok-env", accountId: "acct-1" })
  })

  test("prefers OPENCODE_AUTH_CONTENT over the auth.json file", async () => {
    writeAuthFile(JSON.stringify({ openai: { type: "oauth", access: "tok-file" } }))
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ openai: { type: "oauth", access: "tok-env" } })
    expect(await loadOpenAIAuth()).toEqual({ type: "oauth", access: "tok-env" })
  })

  test("falls back to the auth.json file when the env var is unset", async () => {
    writeAuthFile(JSON.stringify({ openai: { type: "oauth", access: "tok-file" } }))
    expect(await loadOpenAIAuth()).toEqual({ type: "oauth", access: "tok-file" })
  })

  test("returns undefined when the entry is not an oauth type", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ openai: { type: "api", access: "tok" } })
    expect(await loadOpenAIAuth()).toBeUndefined()
  })

  test("returns undefined when access is not a string", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ openai: { type: "oauth", access: 123 } })
    expect(await loadOpenAIAuth()).toBeUndefined()
  })

  test("returns undefined when there is no openai entry", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ anthropic: { type: "oauth", access: "tok" } })
    expect(await loadOpenAIAuth()).toBeUndefined()
  })

  test("returns undefined when the content is not valid JSON", async () => {
    process.env.OPENCODE_AUTH_CONTENT = "{not json"
    expect(await loadOpenAIAuth()).toBeUndefined()
  })

  test("returns undefined when the auth.json file is missing", async () => {
    rmSync(AUTH_FILE, { force: true })
    // The read rejects; loadOpenAIAuth swallows it and reports no credentials.
    expect(await loadOpenAIAuth()).toBeUndefined()
  })
})
